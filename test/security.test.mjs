/**
 * security.test.mjs —— 1.15.0 Knowledge Reliability 的回归测试
 * ============================================================================
 * 钉住 1.15.0 修复的四类问题：
 *   P0 路径安全：comfy_learn / comfy_inspect 的 path 输入共用白名单安全读取；
 *   P0 隐私泄露：所有用户可控文本（含 inspector 事实 / editable_parameters /
 *                feedback.parameter_changes）递归脱敏；include_graph=false 的
 *                get 返回对象绝不夹带 Graph；
 *   P1 数据可靠性：provenance 落盘、history-reference Graph 恢复、feedback
 *                原子事务、index 与 record 一致性修复；
 *   P2 跨来源去重：graph/path/prompt_id 同结构同一 workflow_id。
 * 全部用临时目录 + 假 ComfyUI server，不碰真实知识与输出目录。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createExec, createFakeCtx } from './helpers/fake-ctx.mjs'
import { createWorkflowKnowledgeStore } from '../lib/workflow-knowledge-store.mjs'
import {
  buildExperience,
  buildRecord,
  normalizeRecord,
  redactString,
  sanitizeValue,
} from '../lib/learning.mjs'
import { readSafeJsonFile } from '../lib/safe-json-file.mjs'

const plugin = await import('../index.js')

function boot(root, baseUrl = 'http://127.0.0.1:1') {
  const fake = createFakeCtx()
  plugin.apply(fake.ctx, { outputRoot: root, baseUrl, timeoutMs: 2000 })
  return fake
}

const apiGraph = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] } },
  3: { class_type: 'KSampler', inputs: { seed: 7, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['4', 0] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  5: { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
}

/** 带大量用户可控敏感文本的图，Inspector 会把未连线标量列成 editable_parameters。 */
const sensitiveGraph = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'C:/Users/me/models/secret_model.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'api_key=SK1234567890ABCDEF 画一张 C:/Users/me/private.png', clip: ['1', 0] } },
  3: { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
}

const knowledge = {
  purpose: ['保留原图结构的图像放大'],
  workflow_steps: ['读取输入图像', '采样生成'],
  use_cases: ['图像修复'],
}

function learnTool(root, baseUrl) {
  return boot(root, baseUrl).tools.get('comfy_learn')
}

async function withTemp(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

/** 最小假 ComfyUI：只需 /system_stats 与 /history/:id 就能走 history 恢复。 */
function startHistoryServer(graph) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: { argv: ['/tmp/ComfyUI/main.py'] } }))
      return
    }
    if (url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(id === 'hist-1' ? { 'hist-1': { prompt: [0, graph, {}], outputs: {} } } : {}))
      return
    }
    if (url.pathname === '/history') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })))
}

// ── P0：路径安全（safe-json-file 单元 + 两个工具集成） ──────────────────────

test('readSafeJsonFile：拒绝相对路径 / URL / 非 json 扩展名', async () => {
  const r1 = await readSafeJsonFile({ path: 'wf.json' })
  assert.match(r1.error, /绝对路径/)
  const r2 = await readSafeJsonFile({ path: 'https://example.com/wf.json' })
  assert.match(r2.error, /URL/)
  const r3 = await readSafeJsonFile({ path: join(tmpdir(), 'wf.txt') })
  assert.match(r3.error, /\.json/)
})

test('readSafeJsonFile：白名单外 / 不存在 / 非法 JSON / 超限都给稳定文案', async () => {
  await withTemp('safe-outside-', async (outside) => {
    const file = join(outside, 'wf.json')
    await writeFile(file, JSON.stringify(apiGraph))
    const denied = await readSafeJsonFile({ path: file, roots: [] })
    assert.match(denied.error, /不在允许的工作流目录内/)
    assert.ok(!denied.error.includes(outside), '错误文案不能回显真实路径')
  })
  await withTemp('safe-root-', async (root) => {
    const missing = await readSafeJsonFile({ path: join(root, 'missing.json'), roots: [root] })
    assert.match(missing.error, /不存在/)
    const bad = join(root, 'bad.json')
    await writeFile(bad, '{ not json')
    assert.match((await readSafeJsonFile({ path: bad, roots: [root] })).error, /不是合法 JSON/)
    const big = join(root, 'big.json')
    await writeFile(big, 'x'.repeat(2048))
    assert.match((await readSafeJsonFile({ path: big, roots: [root], maxBytes: 1024 })).error, /超过大小上限/)
  })
})

test('readSafeJsonFile：拒绝符号链接指向的文件', async (t) => {
  await withTemp('safe-link-', async (root) => {
    const real = join(root, 'real.json')
    await writeFile(real, JSON.stringify(apiGraph))
    const link = join(root, 'link.json')
    try {
      await symlink(real, link, 'file')
    } catch (error) {
      t.skip(`本环境无法创建符号链接：${error?.code ?? error}`)
      return
    }
    const read = await readSafeJsonFile({ path: link, roots: [root] })
    assert.equal(read.ok, false)
    assert.match(read.error, /符号链接/)
  })
})

test('comfy_learn / comfy_inspect 的 path 输入走同一安全读取，错误不泄露路径', async () => {
  await withTemp('safe-tool-', async (root) => {
    const tool = learnTool(root)
    const good = join(root, 'wf.json')
    await writeFile(good, JSON.stringify(apiGraph))
    const ok = await tool.execute({ action: 'learn', path: good, name: '安全路径' }, createExec())
    assert.match(ok.text, /来源：path/)

    await withTemp('safe-tool-outside-', async (outside) => {
      const bad = join(outside, 'wf.json')
      await writeFile(bad, JSON.stringify(apiGraph))
      await assert.rejects(
        () => tool.execute({ action: 'learn', path: bad }, createExec()),
        (error) => /读不了工作流文件/.test(error.message) && !error.message.includes(outside),
      )
      const inspect = boot(root).tools.get('comfy_inspect')
      const inspected = await inspect.execute({ path: bad }, createExec())
      assert.match(inspected.text, /读不了工作流文件/)
      assert.ok(!inspected.text.includes(outside), 'comfy_inspect 也不能回显真实路径')
    })
  })
})

// ── P0：隐私泄露 ────────────────────────────────────────────────────────────

test('sanitizeValue：递归脱敏嵌套对象里的路径 / token，保留数值与布尔', () => {
  const out = sanitizeValue({
    text: 'token: abcdefghijklmnop1234',
    path: 'C:/Users/secret/private.png',
    nested: [{ prompt: 'password=hunter2secret' }],
    seed: 7,
    flag: true,
    nil: null,
  })
  const flat = JSON.stringify(out)
  assert.ok(!flat.includes('abcdefghijklmnop1234'))
  assert.ok(!flat.includes('C:/Users/secret'))
  assert.ok(!flat.includes('hunter2secret'))
  assert.equal(out.seed, 7)
  assert.equal(out.flag, true)
  assert.equal(out.nil, null)
})

test('redactString：绝对路径 / UNC / sk- token / 长文本兜底', () => {
  assert.match(redactString('画 C:/Users/me/a.png'), /已脱敏/)
  assert.match(redactString('api_key=abcdefghijklmnop'), /已脱敏/)
  assert.match(redactString('key=sk-abcdefghijklmnop1234'), /已脱敏/)
  assert.ok(redactString('x'.repeat(1000)).length <= 701)
})

test('learn：Inspector 事实里的提示词 / 路径 / token 递归脱敏后落盘', async () => {
  await withTemp('privacy-learn-', async (root) => {
    const tool = learnTool(root)
    const learned = await tool.execute({
      action: 'learn', graph: sensitiveGraph, name: '脱敏',
      knowledge: { purpose: ['token: abcdefghijklmnop1234 画一张图'] },
    }, createExec())
    const id = learned.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const store = createWorkflowKnowledgeStore({ root })
    const record = await store.get(id)
    const flat = JSON.stringify(record)
    assert.ok(!flat.includes('SK1234567890ABCDEF'), 'editable_parameters 不能泄露 key')
    assert.ok(!flat.includes('secret_model.safetensors'))
    assert.ok(!flat.includes('C:/Users/me'))
    assert.ok(!flat.includes('abcdefghijklmnop1234'), 'knowledge 不能泄露 token')
  })
})

test('get include_graph=false：返回对象与文本都不夹带 Graph（快照档案）', async () => {
  await withTemp('privacy-graph-', async (root) => {
    const tool = learnTool(root)
    const learned = await tool.execute({
      action: 'learn', graph: apiGraph, name: '快照', store_graph: true,
    }, createExec())
    const id = learned.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]

    const withGraph = await tool.execute({ action: 'get', workflow_id: id, include_graph: true }, createExec())
    assert.equal(withGraph.record.graph_storage.mode, 'snapshot')
    assert.ok(withGraph.record.graph_storage.graph, 'include_graph=true 才应该有 Graph')

    const without = await tool.execute({ action: 'get', workflow_id: id }, createExec())
    assert.equal(without.record.graph_storage.graph, undefined)
    assert.equal(without.record.graph_storage.snapshot, undefined)
    assert.equal(without.record.graph, undefined)
    assert.equal(without.record.graphData, undefined)
    assert.equal(without.record.workflow, undefined)
    assert.ok(!without.text.includes('"class_type"'), 'text 也不能带原始 Graph 节点')
  })
})

test('feedback.parameter_changes 递归脱敏，feedback 文本也脱敏', () => {
  const ev = buildExperience({
    workflow_id: 'wf_x',
    feedback: 'api_key=SECRET1234567890 很好',
    parameter_changes: { path: 'C:/Users/me/out.png', nested: { token: 'ghp_abcdefghijklmnop1234' } },
  })
  assert.ok(!ev.feedback.includes('SECRET1234567890'))
  const flat = JSON.stringify(ev.parameter_changes)
  assert.ok(!flat.includes('C:/Users/me'))
  assert.ok(!flat.includes('ghp_abcdefghijklmnop1234'))
})

// ── P1：provenance / 旧记录兼容 / feedback 原子事务 ─────────────────────────

test('learn 的 provenance 落盘，默认 agent，不把推测标成 inspector', async () => {
  await withTemp('prov-learn-', async (root) => {
    const tool = learnTool(root)
    const a = await tool.execute({ action: 'learn', graph: apiGraph, name: '默认来源' }, createExec())
    const idA = a.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const store = createWorkflowKnowledgeStore({ root })
    const recA = await store.get(idA)
    assert.equal(recA.provenance.source, 'agent')
    assert.equal(recA.provenance.object_info_checked, false)
    assert.ok(recA.metadata.created_at)

    const graph2 = { ...apiGraph, 99: { class_type: 'ImageScale', inputs: { image: ['5', 0], upscale_method: 'lanczos', width: 2048, height: 2048 } } }
    const b = await tool.execute({
      action: 'learn', graph: graph2, name: '用户声明',
      provenance: { source: 'user', details: '用户提供的工作流' },
    }, createExec())
    const idB = b.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const recB = await store.get(idB)
    assert.equal(recB.provenance.source, 'user')
    assert.equal(recB.provenance.inspector, null)
    assert.ok(recB.provenance.recorded_at)
  })
})

test('normalizeRecord：旧档案补 graph_available / provenance / created_at，不伪造事实', () => {
  const legacy = {
    workflow_id: 'wf_legacy',
    graph_storage: { mode: 'reference-only', available: true, prompt_id: 'p1' },
    source: { type: 'history', created_at: '2026-01-01T00:00:00.000Z' },
    metadata: { revision: 1 },
  }
  const next = normalizeRecord(legacy)
  assert.equal(next.graph_available, false, '旧 reference-only 的 available=true 必须降回 false')
  assert.equal(next.provenance.legacy, true)
  assert.equal(next.provenance.source, 'agent')
  assert.equal(next.metadata.created_at, '2026-01-01T00:00:00.000Z')
})

test('feedback 原子事务：并发两次反馈，状态统计与事件数一致', async () => {
  await withTemp('atomic-fb-', async (root) => {
    const tool = learnTool(root)
    const learned = await tool.execute({ action: 'learn', graph: apiGraph, name: '原子反馈' }, createExec())
    const id = learned.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]

    await Promise.all([
      tool.execute({ action: 'feedback', workflow_id: id, execution_outcome: 'completed', assessment_source: 'agent_observation' }, createExec()),
      tool.execute({ action: 'feedback', workflow_id: id, quality_assessment: 'approved', assessment_source: 'user', feedback: '很好' }, createExec()),
    ])
    const got = await tool.execute({ action: 'get', workflow_id: id }, createExec())
    assert.equal(got.record.experiences.length, 2, '两次并发反馈都落盘')
    assert.equal(got.record.stats.execution_completed, 1)
    assert.equal(got.record.learning_status.execution_status, 'executed')
    assert.equal(got.record.stats.approved, 1)
    assert.equal(got.record.learning_status.quality_status, 'approved')
  })
})

// ── P2：跨来源去重 / 索引一致性 / history 恢复 ───────────────────────────────

test('跨来源去重：graph 与 path 同一结构归一到同一 workflow_id', async () => {
  await withTemp('dedup-source-', async (root) => {
    const tool = learnTool(root)
    const a = await tool.execute({ action: 'learn', graph: apiGraph, name: '来自 graph' }, createExec())
    const idA = a.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    const file = join(root, 'wf.json')
    await writeFile(file, JSON.stringify(apiGraph))
    const b = await tool.execute({ action: 'learn', path: file, name: '来自 path' }, createExec())
    const idB = b.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
    assert.equal(idA, idB, '同一结构跨来源应同一身份')
    assert.match(b.text, /已更新原档案/)
  })
})

test('index 与 record 不一致时 list 自动修复', async () => {
  await withTemp('index-repair-', async (root) => {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    const base = buildRecord({
      sourceInput: { graph: apiGraph },
      parsed: { graph: apiGraph, format: 'api', diagnostics: [], subgraphs: [], warnings: [], unresolved: [] },
      inspection: { keyNodes: [], editable: [], edges: [], diagnostics: [], subgraphs: [] },
      source: { type: 'graph', created_at: new Date().toISOString() },
      knowledge: {}, name: 'A',
    }).record
    const r1 = { ...base, workflow_id: 'wf_repair_a' }
    const r2 = { ...base, workflow_id: 'wf_repair_b' }
    await store.upsert(r1)
    await store.upsert(r2)
    // 人为破坏 index：只留一条
    const indexPath = await store.indexPath()
    const data = JSON.parse(await readFile(indexPath, 'utf8'))
    data.entries = data.entries.slice(0, 1)
    await writeFile(indexPath, JSON.stringify(data))
    const listed = await store.list()
    assert.equal(listed.source, 'repaired')
    assert.equal(listed.entries.length, 2, '从 records 修复回来两条')
  })
})

test('history-reference：prompt_id 学习后可从 ComfyUI history 恢复 Graph', async () => {
  await withTemp('history-ref-', async (root) => {
    const comfy = await startHistoryServer(apiGraph)
    try {
      const tool = learnTool(root, comfy.baseUrl)
      const learned = await tool.execute({ action: 'learn', prompt_id: 'hist-1', name: '历史工作流' }, createExec())
      assert.match(learned.text, /来源：history/)
      const id = learned.text.match(/workflow_id: (wf_[0-9a-f]+)/)[1]
      const store = createWorkflowKnowledgeStore({ root })
      const record = await store.get(id)
      assert.equal(record.graph_storage.mode, 'history-reference')
      assert.equal(record.graph_available, true)

      const got = await tool.execute({ action: 'get', workflow_id: id, include_graph: true }, createExec())
      assert.match(got.text, /从 history 的 prompt_id hist-1 恢复/)
      assert.match(got.text, /CheckpointLoaderSimple/)

      const safe = await tool.execute({ action: 'get', workflow_id: id }, createExec())
      assert.equal(safe.record.graph_storage.graph, undefined)
    } finally {
      await comfy.close()
    }
  })
})
