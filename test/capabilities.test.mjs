/**
 * capabilities.test.mjs —— 能力发现层纯函数 + comfy_capabilities 工具行为
 * ============================================================================
 * 守的是「遇陌生模型不误判」这条线：
 *   · slimObjectInfo 砍掉大枚举，只留类名/输入名等轻量字段
 *   · findCapabilities 按中英任务词命中本机真实节点/模型，多候选按相关度排
 *   · object_info 拿不到时降级为「静态词典 + 文件名」候选
 *   · labelModel 只按文件名模式打标签，不写死某模型
 *   · searchNodes 支持关键词搜节点，打破「不知道类名」的鸡生蛋
 *   · comfy_capabilities 离线统一文案、空输入报错、结果带模型/节点/提示
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  CAPABILITIES, findCapabilities, labelModel, searchNodes, slimObjectInfo,
} from '../lib/capabilities.mjs'
import { createExec, createFakeCtx } from './helpers/fake-ctx.mjs'

const plugin = await import('../index.js')

const FULL_OBJECT_INFO = {
  TextEncodeQwenImage21: {
    name: 'TextEncodeQwenImage21', display_name: 'Qwen Image 2.1 编辑', category: 'conditioning',
    description: 'x'.repeat(2000),
    input: {
      required: { clip: ['CLIP', {}], prompt: ['STRING', {}], images: ['COMFY_AUTOGROW_V3', {}] },
      optional: { vae: ['VAE', {}] },
    },
  },
  RMBG: {
    name: 'RMBG', display_name: '背景去除', category: 'image',
    input: { required: { image: ['IMAGE', {}], model: [['a', 'b', 'c'], {}] } },
  },
  KSampler: {
    name: 'KSampler', display_name: 'KSampler', category: 'sampling',
    input: { required: { model: ['MODEL', {}], steps: ['INT', {}] } },
  },
}

const MODEL_INDEX = {
  diffusion_models: ['qwen_image_2.1_int8_convrot.safetensors', 'anima-base-v1.0.safetensors'],
  text_encoders: ['qwen3vl_8b_int8_convrot.safetensors'],
  vae: ['qwen_image_2.1_vae_bf16.safetensors'],
  checkpoints: [],
  loras: [],
}

test('slimObjectInfo：砍掉大 description 与枚举值，只留类名/输入名', () => {
  const slim = slimObjectInfo(FULL_OBJECT_INFO)
  assert.equal(slim.length, 3)
  const qwen = slim.find((n) => n.name === 'TextEncodeQwenImage21')
  assert.equal(qwen.display_name, 'Qwen Image 2.1 编辑')
  assert.equal(qwen.category, 'conditioning')
  assert.ok(qwen.description.length <= 300, 'description 应被截断')
  assert.deepEqual(qwen.requiredInputs, ['clip', 'prompt', 'images'])
  assert.deepEqual(qwen.optionalInputs, ['vae'])
  const rmbg = slim.find((n) => n.name === 'RMBG')
  // 枚举数组（['a','b','c']）不该出现在轻量字段里，只剩输入 key
  assert.deepEqual(rmbg.requiredInputs, ['image', 'model'])
  assert.ok(!JSON.stringify(slim).includes('x'.repeat(500)), '大 description 不该残留')
})

test('findCapabilities：「去掉遮挡只留人物」命中参考图编辑 + 抠图，且排在最前', () => {
  const slim = slimObjectInfo(FULL_OBJECT_INFO)
  const caps = findCapabilities('去掉截图里的遮挡，只保留人物', slim, MODEL_INDEX)
  assert.ok(caps.length >= 1)
  assert.equal(caps[0].match, 'task')
  const ids = caps.map((c) => c.id)
  assert.ok(ids.includes('reference_edit'), '应命中参考图编辑')
  const ref = caps.find((c) => c.id === 'reference_edit')
  assert.ok(ref.nodes.some((n) => n.name === 'TextEncodeQwenImage21'))
  assert.ok(ref.models.some((m) => m.includes('qwen_image_2.1')))
})

test('findCapabilities：英文任务词也能命中（upscale / reference edit）', () => {
  const slim = slimObjectInfo(FULL_OBJECT_INFO)
  const up = findCapabilities('upscale', slim, MODEL_INDEX)
  // 本机 fixture 没有 upscale 节点/模型 → 仍给出能力项，但标注 fallback（无本机佐证）
  assert.equal(up.length, 1)
  assert.equal(up[0].id, 'upscale')
  assert.equal(up[0].match, 'fallback')
  assert.equal(up[0].nodes.length, 0)
  assert.equal(up[0].models.length, 0)
  const ref = findCapabilities('reference edit', slim, MODEL_INDEX)
  assert.ok(ref.some((c) => c.id === 'reference_edit'))
})

test('findCapabilities：标志性节点（TextEncodeQwenImage21）优先于宽泛 Inpaint 匹配', () => {
  // 造一个「Inpaint 节点很多、真正该用的 Qwen 节点排在后面」的场景
  const many = [
    ...Array.from({ length: 12 }, (_, i) => ({
      name: `InpainThing${i}`, display_name: '', category: '', requiredInputs: [], optionalInputs: [],
    })),
    ...slimObjectInfo(FULL_OBJECT_INFO),
  ]
  const ref = findCapabilities('去遮挡', many, MODEL_INDEX).find((c) => c.id === 'reference_edit')
  assert.equal(ref.nodes[0].name, 'TextEncodeQwenImage21', '标志性节点应排在最前')
})

test('findCapabilities：任务词命中但本机无对应节点/模型时标 fallback', () => {
  const caps = findCapabilities('抠图', [], MODEL_INDEX)
  const mat = caps.find((c) => c.id === 'matting')
  assert.ok(mat, '抠图任务词应给出抠图能力项')
  assert.equal(mat.match, 'fallback')
  assert.equal(mat.nodes.length, 0)
  assert.equal(mat.models.length, 0)
  // 而「编辑」有真实 qwen 模型 → 是 task 而非 fallback
  const ref = findCapabilities('编辑', [], MODEL_INDEX).find((c) => c.id === 'reference_edit')
  assert.equal(ref.match, 'task')
  assert.ok(ref.models.length > 0)
})

test('findCapabilities：没匹配就不给结果，不硬凑', () => {
  const caps = findCapabilities('随便一个完全无关的词zzzzzz', slimObjectInfo(FULL_OBJECT_INFO), {})
  assert.equal(caps.length, 0)
})

test('labelModel：只按文件名模式，qwen 标编辑、anima 标文生图', () => {
  const qwen = labelModel('qwen_image_2.1_int8_convrot.safetensors')
  assert.ok(qwen.some((x) => /编辑/.test(x)))
  const anima = labelModel('anima-base-v1.0.safetensors')
  assert.ok(anima.some((x) => /文生图/.test(x)))
  const unknown = labelModel('mystery_xyz.safetensors')
  assert.equal(unknown.length, 0, '认不出就不乱打标签')
  // 词典里的每条都要有稳定字段
  for (const cap of CAPABILITIES) {
    assert.ok(cap.id && cap.label && cap.nodePat && cap.modelPat && Array.isArray(cap.taskWords))
  }
})

test('searchNodes：完整类名精确命中；关键词列候选', () => {
  const slim = slimObjectInfo(FULL_OBJECT_INFO)
  const exact = searchNodes('KSampler', slim)
  assert.ok(exact.exact)
  assert.equal(exact.candidates.length, 0)
  const byKeyword = searchNodes('qwen', slim)
  assert.equal(byKeyword.exact, null)
  assert.ok(byKeyword.candidates.some((n) => n.name === 'TextEncodeQwenImage21'))
  const miss = searchNodes('zzzzzz', slim)
  assert.equal(miss.exact, null)
  assert.equal(miss.candidates.length, 0)
})

function bootWithServer({ objectInfo = true, diffusionModels = [] } = {}) {
  let sawObjectInfo = false
  const server = createServer((req, res) => {
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.method === 'GET' && req.url.startsWith('/models/')) {
      const folder = req.url.slice('/models/'.length)
      return json(folder === 'diffusion_models' ? diffusionModels : [])
    }
    if (req.method === 'GET' && req.url === '/object_info') {
      if (!objectInfo) return json({}, 404)
      sawObjectInfo = true
      return json({ ...FULL_OBJECT_INFO, ...(diffusionModels.length ? {} : {}) })
    }
    return json({}, 404)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`
      const fake = createFakeCtx()
      plugin.apply(fake.ctx, { baseUrl, timeoutMs: 2000 })
      resolve({
        tools: fake.tools,
        baseUrl,
        sawObjectInfo: () => sawObjectInfo,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

test('comfy_capabilities：命中本机 qwen 模型 + 节点，结果带用途提示', async () => {
  const env = await bootWithServer({ diffusionModels: ['qwen_image_2.1_int8_convrot.safetensors'] })
  try {
    const result = await env.tools.get('comfy_capabilities').execute(
      { task: '去掉截图里的抖音遮挡，只保留人物' }, createExec(),
    )
    assert.match(result.text, /反查本机能力/)
    assert.match(result.text, /参考图指令编辑/)
    assert.match(result.text, /qwen_image_2\.1/)
    assert.match(result.text, /TextEncodeQwenImage21/)
    assert.match(result.text, /提示：/)
  } finally {
    await env.close()
  }
})

test('comfy_capabilities：object_info 拿不到时降级，给经验候选并标注未连本机', async () => {
  const env = await bootWithServer({ objectInfo: false, diffusionModels: ['qwen_image_2.1_int8_convrot.safetensors'] })
  try {
    const result = await env.tools.get('comfy_capabilities').execute({ task: '去遮挡' }, createExec())
    assert.match(result.text, /未连本机/)
    assert.match(result.text, /qwen_image_2\.1/)
  } finally {
    await env.close()
  }
})

test('comfy_capabilities：空任务报错；完全无匹配给指路文案', async () => {
  const env = await bootWithServer({ diffusionModels: [] })
  try {
    await assert.rejects(
      () => env.tools.get('comfy_capabilities').execute({ task: '  ' }, createExec()),
      /必须给 task/,
    )
    const result = await env.tools.get('comfy_capabilities').execute({ task: 'zzzz完全无关' }, createExec())
    assert.match(result.text, /没找到明确匹配/)
    assert.match(result.text, /comfy_models/)
  } finally {
    await env.close()
  }
})

test('comfy_node：完整类名查不到时按关键词列候选', async () => {
  const env = await bootWithServer()
  try {
    // /object_info/QwenFoo 在假服务上 404 → 走关键词分支
    const result = await env.tools.get('comfy_node').execute({ node_class: 'qwen' }, createExec())
    assert.match(result.text, /按关键词找到/)
    assert.match(result.text, /TextEncodeQwenImage21/)
  } finally {
    await env.close()
  }
})
