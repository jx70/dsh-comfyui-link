/**
 * learning.test.mjs —— comfy_learn 工具的端到端行为测试（假 ctx + 临时目录）
 * ============================================================================
 * 钉住：三来源互斥、API/UI 学习、去重、脱敏、store_graph、recall 排序、
 *       get 的 Graph 恢复、feedback 全枚举与不覆盖、completed≠approved。
 * 全部用 mkdtemp 临时目录，不碰真实 ComfyUI 知识库。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createExec, createFakeCtx } from './helpers/fake-ctx.mjs'
import { createWorkflowKnowledgeStore } from '../lib/workflow-knowledge-store.mjs'
import {
  buildExperience,
  applyExperienceToStatus,
  rankForRecall,
  sanitizeKnowledge,
  stableStringify,
  fingerprintsFor,
} from '../lib/learning.mjs'

const plugin = await import('../index.js')

function boot(root) {
  const fake = createFakeCtx()
  plugin.apply(fake.ctx, { outputRoot: root, baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  return fake
}

const apiGraph = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] } },
  3: { class_type: 'KSampler', inputs: { seed: 7, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['4', 0] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  5: { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
}

const knowledge = {
  purpose: ['保留原图结构的图像放大'],
  workflow_steps: ['读取输入图像', '编码为潜空间', '采样生成', '输出结果'],
  node_roles: [{ node: 'KSampler', role: '采样生成', confidence: 'medium' }],
  use_cases: ['图像修复'],
  parameter_guidance: [{ parameter: 'denoise', guidance: '按保留原图结构的要求调整', confidence: 'medium' }],
  dependencies: ['某放大模型'],
  limitations: ['受输入分辨率限制'],
  troubleshooting: ['节点缺失时检查自定义节点安装'],
}

test('comfy_learn 已注册，action 为必填，五个取值都在 schema 里', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-reg-'))
  try {
    const { tools } = boot(root)
    const tool = tools.get('comfy_learn')
    assert.ok(tool, 'comfy_learn 没注册')
    assert.deepEqual(tool.parameters.required, ['action'])
    assert.deepEqual(tool.parameters.properties.action.enum, ['learn', 'recall', 'list', 'get', 'feedback'])
    await assert.rejects(() => tool.execute({}, createExec()), /不认识的 action|undefined/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('learn：三来源必须且只能给一个', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-src-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    await assert.rejects(() => tool.execute({ action: 'learn' }, createExec()), /三选一/)
    await assert.rejects(
      () => tool.execute({ action: 'learn', graph: apiGraph, prompt_id: 'x' }, createExec()),
      /只能给一个/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('learn：API 图学习成功后可 list / get，Inspector 事实来自插件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-api-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const exec = createExec()
    const learned = await tool.execute({
      action: 'learn', graph: apiGraph, name: '测试工作流', description: '一只猫', tags: ['test', 'api'], knowledge,
    }, exec)
    const id = learned.text.match(/workflow_id: (wf_[0-9a-f]+)/)?.[1]
    assert.ok(id, '没返回 workflow_id')

    const listed = await tool.execute({ action: 'list' }, exec)
    assert.match(listed.text, new RegExp(id))
    assert.match(listed.text, /测试工作流/)

    const got = await tool.execute({ action: 'get', workflow_id: id }, exec)
    assert.match(got.text, /KSampler/)
    assert.match(got.text, /保留原图结构的图像放大/)
    assert.match(got.text, /参数指导/)
    // Inspector 事实：诊断/可改参数都在
    assert.ok(got.record.inspection.keyNodes.length > 0)
    assert.ok(got.record.inspection.editable_parameters.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('learn：同名不同 Graph 不覆盖，相同 source_hash 去重并保留反馈', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-dedup-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const exec = createExec()
    const a = await tool.execute({ action: 'learn', graph: apiGraph, name: '同名', knowledge }, exec)
    const idA = a.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const graph2 = { ...apiGraph, 99: { class_type: 'ImageScale', inputs: { image: ['5', 0], upscale_method: 'lanczos', width: 2048, height: 2048, crop: 'disabled' } } }
    const b = await tool.execute({ action: 'learn', graph: graph2, name: '同名', knowledge }, exec)
    const idB = b.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    assert.notEqual(idA, idB, '同名不同结构应各自独立')

    // 再学一次完全相同的图 → 命中去重，更新同一档案
    await tool.execute({ action: 'feedback', workflow_id: idA, execution_outcome: 'completed' }, exec)
    const again = await tool.execute({ action: 'learn', graph: apiGraph, name: '同名', knowledge }, exec)
    assert.match(again.text, /已更新原档案/)
    const got = await tool.execute({ action: 'get', workflow_id: idA }, exec)
    assert.equal(got.record.experiences.length, 1, '去重更新应保留历史反馈')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('learn：UI 图的 widgets_values 不被当作精确参数，warnings 保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-ui-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const uiGraph = {
      nodes: [{
        id: 1, type: 'CLIPLoader',
        inputs: [
          { name: 'clip_name', widget: { name: 'clip_name' }, link: null },
          { name: 'type', widget: { name: 'type' }, link: null },
        ],
        outputs: [], widgets_values: ['real_model.safetensors', 'stable_diffusion'],
      }],
      links: [],
    }
    const learned = await tool.execute({ action: 'learn', graph: uiGraph, name: 'UI 图', knowledge }, exec())
    const id = learned.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const got = await toolsGet(root, id)
    assert.equal(got.inspection.format, 'ui')
    assert.ok(got.inspection.warnings.some((w) => /Widget/.test(w)))
    assert.ok(got.inspection.unresolved.length > 0)
    // widgets_values 只能出现在 unresolved 的原始数组里，绝不进入具名参数
    for (const p of got.inspection.editable_parameters) {
      assert.notEqual(p.value, 'real_model.safetensors')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('learn：path 来源读文件，非法 JSON / 过大 / 空图报错友好', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-path-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const good = join(root, 'wf.json')
    await writeFile(good, JSON.stringify(apiGraph))
    const ok = await tool.execute({ action: 'learn', path: good, name: 'FromFile' }, createExec())
    assert.match(ok.text, /来源：path/)

    const bad = join(root, 'bad.json')
    await writeFile(bad, '{ not json')
    await assert.rejects(() => tool.execute({ action: 'learn', path: bad }, createExec()), /不是合法 JSON/)

    await assert.rejects(() => tool.execute({ action: 'learn', path: join(root, 'missing.json') }, createExec()), /读不了/)
    await assert.rejects(
      () => tool.execute({ action: 'learn', graph: {} }, createExec()),
      /解析失败|工作流必须是|识别不了/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('learn：prompt_id 找不到时友好报错（索引与历史都没有）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-pid-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    await assert.rejects(
      () => tool.execute({ action: 'learn', prompt_id: 'nonexistent-pid' }, createExec()),
      /找不到工作流|历史里也没有/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('learn：默认不保存 Graph（不可恢复），store_graph=true 保存快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-graph-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const exec = createExec()
    const off = await tool.execute({ action: 'learn', graph: apiGraph, name: '无快照' }, exec)
    const idOff = off.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const gotOff = await tool.execute({ action: 'get', workflow_id: idOff, include_graph: true }, exec)
    assert.match(gotOff.text, /没有保存原始快照/)

    const on = await tool.execute({ action: 'learn', graph: apiGraph, name: '有快照', store_graph: true }, exec)
    const idOn = on.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const gotOn = await tool.execute({ action: 'get', workflow_id: idOn, include_graph: true }, exec)
    assert.match(gotOn.text, /原始 Graph 快照/)
    assert.equal(gotOn.record.graph_storage.mode, 'snapshot')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('learn：默认脱敏，提示词/图片路径/token 不进知识字段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-redact-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const learned = await tool.execute({
      action: 'learn', graph: apiGraph, name: '脱敏测试',
      knowledge: {
        purpose: ['api_key=SECRET12345 画一张 C:/Users/me/secret.png 的图'],
        dependencies: ['token: abcdefghijklmnop'],
      },
    }, createExec())
    const id = learned.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const got = await toolsGet(root, id)
    const flat = JSON.stringify(got.knowledge)
    assert.ok(!flat.includes('SECRET12345'))
    assert.ok(!flat.includes('abcdefghijklmnop'))
    assert.match(flat, /已脱敏/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recall：名称/用途/标签/节点命中，含匹配原因；无结果友好提示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-recall-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const exec = createExec()
    await tool.execute({ action: 'learn', graph: apiGraph, name: '图像放大工作流', description: '保结构', tags: ['upscale'], knowledge }, exec)
    const hit = await tool.execute({ action: 'recall', query: '寻找保留原图结构的图像放大工作流', limit: 5 }, exec)
    assert.match(hit.text, /图像放大工作流/)
    assert.match(hit.text, /匹配原因/)
    assert.ok(hit.candidates.length >= 1)
    assert.match(hit.candidates[0].note, /推荐|不代表可直接执行/)

    const none = await tool.execute({ action: 'recall', query: '量子物理课程讲义' }, exec)
    assert.match(none.text, /没有找到/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recall：名称相似但用途不符不排第一（用途权重更高）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-rank-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const exec = createExec()
    // A：名字完全命中「放大」但用途是别的事；B：名字不叫放大但用途标签全是放大
    await tool.execute({
      action: 'learn', graph: apiGraph, name: '放大专用超强工具',
      knowledge: { purpose: ['生成随机噪声'], use_cases: ['调试'] },
    }, exec)
    await tool.execute({
      action: 'learn', graph: { ...apiGraph, 99: { class_type: 'ImageScale', inputs: { image: ['5', 0], upscale_method: 'lanczos', width: 2048, height: 2048, crop: 'disabled' } } },
      name: '超分链路',
      knowledge: { purpose: ['图像放大与超分，保留原图结构'], use_cases: ['放大'], tags: ['upscale'] },
    }, exec)
    const hit = await tool.execute({ action: 'recall', query: '图像放大 保留原图结构' }, exec)
    assert.match(hit.candidates[0].name, /超分链路/, '用途更贴题的应排在名字相似之前')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('feedback：全枚举被接受，多次追加不覆盖，completed 不自动 approved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learn-fb-'))
  try {
    const tool = boot(root).tools.get('comfy_learn')
    const exec = createExec()
    const learned = await tool.execute({ action: 'learn', graph: apiGraph, name: '反馈测试' }, exec)
    const id = learned.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]

    // 先把状态/统计更新（completed 不自动 approved），再追加独立事件
    await tool.execute({ action: 'feedback', workflow_id: id, execution_outcome: 'completed', assessment_source: 'agent_observation' }, exec)
    const s1 = await tool.execute({ action: 'get', workflow_id: id }, exec)
    assert.equal(s1.record.learning_status.execution_status, 'executed')
    assert.equal(s1.record.learning_status.quality_status, 'unreviewed', 'completed 不应自动 approved')
    assert.equal(s1.record.stats.execution_completed, 1)

    // 用户明确批准
    await tool.execute({
      action: 'feedback', workflow_id: id, quality_assessment: 'approved', assessment_source: 'user', prompt_id: 'p1', feedback: '很好',
    }, exec)
    const s2 = await tool.execute({ action: 'get', workflow_id: id }, exec)
    assert.equal(s2.record.learning_status.quality_status, 'approved')
    assert.equal(s2.record.experiences.length, 2, '多次反馈不覆盖')
    assert.ok(s2.record.experiences.some((e) => e.assessment_source === 'user'))

    // 无效 workflow_id 报错
    await assert.rejects(
      () => tool.execute({ action: 'feedback', workflow_id: 'wf_nope' }, exec),
      /找不到知识档案/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 纯函数单元测试 ────────────────────────────────────────────────────────

test('stableStringify：对象键顺序不影响结果', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }))
  assert.equal(stableStringify({ x: [1, { p: 1, q: 2 }] }), stableStringify({ x: [1, { q: 2, p: 1 }] }))
})

test('fingerprintsFor：相同输入相同指纹，不同结构不同指纹', () => {
  const parsed = { format: 'api', graph: apiGraph, diagnostics: [], subgraphs: [] }
  const a = fingerprintsFor({ graph: apiGraph }, parsed)
  const b = fingerprintsFor({ graph: apiGraph }, parsed)
  assert.equal(a.source_hash, b.source_hash)
  assert.equal(a.structure_hash, b.structure_hash)
  assert.match(a.workflow_id, /^wf_[0-9a-f]{16}$/)
})

test('sanitizeKnowledge：非法类型/未知 confidence 被规整', () => {
  const { knowledge: k, warnings } = sanitizeKnowledge({
    purpose: '不是数组',
    node_roles: [{ node: 'X', role: 'y', confidence: 'bogus' }],
    use_cases: ['ok'],
  })
  assert.deepEqual(k.purpose, [])
  assert.equal(k.node_roles[0].confidence, 'low')
  assert.ok(warnings.length > 0)
})

test('rankForRecall：confirmed 来源加分，空 query 不误判', () => {
  const base = (id, purpose, experiences) => ({
    workflow_id: id, name: id, description: '', tags: [],
    knowledge: { purpose, workflow_steps: [], use_cases: [], parameter_guidance: [], dependencies: [] },
    inspection: { keyNodes: [] }, experiences,
    graph_storage: { available: false }, metadata: { updated_at: '2026-01-01' },
  })
  const plain = base('wf_plain', ['放大'], [])
  const confirmed = base('wf_confirmed', ['放大'], [{ quality_assessment: 'approved', assessment_source: 'user' }])
  const ranked = rankForRecall([plain, confirmed], '放大')
  assert.ok(ranked[0].score > ranked[1].score, '有用户确认的应得分更高')
  assert.equal(rankForRecall([plain, confirmed], '').length, 2)
})

test('buildExperience / applyExperienceToStatus：状态与质量分开，cancelled 不改状态', () => {
  const ev = buildExperience({ workflow_id: 'wf_x', execution_outcome: 'cancelled', quality_assessment: 'not_assessed', assessment_source: 'user' })
  assert.equal(ev.execution_outcome, 'cancelled')
  const record = { learning_status: { execution_status: 'never_executed', quality_status: 'unreviewed' }, stats: {}, metadata: {} }
  const next = applyExperienceToStatus(record, ev)
  assert.equal(next.learning_status.execution_status, 'never_executed', 'cancelled 不写 executed')
  assert.equal(next.learning_status.quality_status, 'unreviewed')
})

// ── 测试辅助 ──────────────────────────────────────────────────────────────

function exec() {
  return createExec()
}

async function toolsGet(root, id) {
  const store = createWorkflowKnowledgeStore({ root })
  return store.get(id)
}
