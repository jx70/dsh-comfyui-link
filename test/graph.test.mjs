/**
 * graph.test.mjs —— lib/comfy.mjs 里那些纯函数的单测
 * ============================================================================
 * 这些函数不碰网络，所以 `npm test` 不需要 ComfyUI、不需要 DSH。
 * 覆盖的重点是踩过的坑：
 *   · 连线必须写字符串节点 id（数字会让 ComfyUI 抛 KeyError）
 *   · normalizeGraph 要认得出「界面版工作流」并给出能照做的报错
 *   · LoRA 要把 model/clip 的连线从 1/2 改接到 10
 * ============================================================================
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ComfyError, MODEL_FOLDERS, buildImg2Img, buildTxt2Img, buildUpscale,
  collectImages, createClient, humanDuration, injectPrompt, normalizeGraph,
  resolveModels, summarizeGraph,
} from '../lib/comfy.mjs'

const MODELS = { unet: 'unet.safetensors', clip: 'clip.safetensors', vae: 'vae.safetensors' }

/** 收集一张图里所有连线（形如 ["节点id", 序号] 的二元组） */
function links(graph) {
  const out = []
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number') {
        out.push({ from: id, key, to: value[0], slot: value[1] })
      }
    }
  }
  return out
}

test('MODEL_FOLDERS 是文档里承诺的那五个文件夹', () => {
  assert.deepEqual(MODEL_FOLDERS, ['diffusion_models', 'text_encoders', 'vae', 'checkpoints', 'loras'])
})

test('buildTxt2Img 产出 9 个节点，默认 1024×1024 / 30 步 / cfg 4.9', () => {
  const graph = buildTxt2Img({ ...MODELS, prompt: 'a cat', negative: 'blurry' })
  assert.equal(Object.keys(graph).length, 9)
  assert.equal(graph[1].class_type, 'UNETLoader')
  assert.equal(graph[1].inputs.unet_name, 'unet.safetensors')
  assert.equal(graph[2].inputs.clip_name, 'clip.safetensors')
  assert.equal(graph[3].inputs.vae_name, 'vae.safetensors')
  assert.equal(graph[6].inputs.width, 1024)
  assert.equal(graph[6].inputs.height, 1024)
  assert.equal(graph[6].inputs.batch_size, 1)
  assert.equal(graph[7].inputs.steps, 30)
  assert.equal(graph[7].inputs.cfg, 4.9)
  assert.equal(graph[7].inputs.sampler_name, 'euler')
  assert.equal(graph[7].inputs.scheduler, 'simple')
  assert.equal(graph[7].inputs.denoise, 1)
  assert.equal(graph[4].inputs.text, 'a cat')
  assert.equal(graph[5].inputs.text, 'blurry')
  assert.equal(graph[9].class_type, 'SaveImage')
})

test('buildTxt2Img 的所有连线都用字符串节点 id', () => {
  const graph = buildTxt2Img({ ...MODELS, prompt: 'p', negative: 'n' })
  const all = links(graph)
  assert.ok(all.length > 0, '应该有连线')
  for (const link of all) {
    assert.equal(typeof link.to, 'string', `${link.from}.${link.key} 的节点 id 必须是字符串`)
  }
  // 关键几条：采样器吃模型/正负/潜空间，解码吃采样器 + vae，存图吃解码
  assert.deepEqual(graph[7].inputs.model, ['1', 0])
  assert.deepEqual(graph[7].inputs.positive, ['4', 0])
  assert.deepEqual(graph[7].inputs.negative, ['5', 0])
  assert.deepEqual(graph[7].inputs.latent_image, ['6', 0])
  assert.deepEqual(graph[8].inputs.samples, ['7', 0])
  assert.deepEqual(graph[8].inputs.vae, ['3', 0])
  assert.deepEqual(graph[9].inputs.images, ['8', 0])
})

test('buildTxt2Img 挂 LoRA 时插节点 10 并把 model/clip 改接到它', () => {
  const graph = buildTxt2Img({ ...MODELS, prompt: 'p', negative: 'n', lora: 'style.safetensors', loraStrength: 0.7 })
  assert.equal(graph[10].class_type, 'LoraLoader')
  assert.deepEqual(graph[10].inputs, {
    model: ['1', 0],
    clip: ['2', 0],
    lora_name: 'style.safetensors',
    strength_model: 0.7,
    strength_clip: 0.7,
  })
  // 正负提示词的 clip 改从 LoRA 的第 1 个输出取，采样器的 model 从第 0 个取
  assert.deepEqual(graph[4].inputs.clip, ['10', 1])
  assert.deepEqual(graph[5].inputs.clip, ['10', 1])
  assert.deepEqual(graph[7].inputs.model, ['10', 0])
})

test('buildTxt2Img 不给 lora 时没有节点 10', () => {
  const graph = buildTxt2Img({ ...MODELS, prompt: 'p', negative: 'n' })
  assert.equal(graph[10], undefined)
})

test('buildImg2Img 有 10 个节点，denoise 可调且不传时默认 0.6', () => {
  const graph = buildImg2Img({ ...MODELS, imageName: 'src.png', prompt: 'p', negative: 'n' })
  assert.equal(Object.keys(graph).length, 10)
  assert.equal(graph[6].class_type, 'LoadImage')
  assert.equal(graph[6].inputs.image, 'src.png')
  assert.equal(graph[7].class_type, 'VAEEncode')
  assert.deepEqual(graph[7].inputs.pixels, ['6', 0])
  assert.equal(graph[8].class_type, 'KSampler')
  assert.equal(graph[8].inputs.denoise, 0.6)
  assert.deepEqual(graph[8].inputs.latent_image, ['7', 0])

  const custom = buildImg2Img({ ...MODELS, imageName: 'src.png', prompt: 'p', negative: 'n', denoise: 0.35 })
  assert.equal(custom[8].inputs.denoise, 0.35)
})

test('buildImg2Img 少了 imageName 会抛 ComfyError(GRAPH)', () => {
  assert.throws(
    () => buildImg2Img({ ...MODELS, prompt: 'p', negative: 'n' }),
    (error) => error instanceof ComfyError && error.code === 'GRAPH' && /imageName/.test(error.message),
  )
})

test('buildUpscale 用 ImageScale 做算法放大，默认 lanczos', () => {
  const graph = buildUpscale({ imageName: 'src.png', width: 2048, height: 1024 })
  assert.equal(Object.keys(graph).length, 3)
  assert.equal(graph[1].class_type, 'LoadImage')
  assert.equal(graph[2].class_type, 'ImageScale')
  assert.deepEqual(graph[2].inputs, {
    image: ['1', 0],
    upscale_method: 'lanczos',
    width: 2048,
    height: 1024,
    crop: 'disabled',
  })
  assert.deepEqual(graph[3].inputs.images, ['2', 0])
})

test('buildUpscale 拒绝缺 imageName 或非正整数尺寸', () => {
  assert.throws(() => buildUpscale({ width: 10, height: 10 }), ComfyError)
  assert.throws(() => buildUpscale({ imageName: 'a.png', width: 0, height: 10 }), ComfyError)
  assert.throws(() => buildUpscale({ imageName: 'a.png', width: 10, height: 1.5 }), ComfyError)
})

test('normalizeGraph 复制一份，不改调用方的对象', () => {
  const source = { 1: { class_type: 'UNETLoader', inputs: { unet_name: 'u' } } }
  const out = normalizeGraph(source)
  out[1].inputs.unet_name = 'changed'
  assert.equal(source[1].inputs.unet_name, 'u')
  assert.notEqual(out[1], source[1])
  assert.notEqual(out[1].inputs, source[1].inputs)
})

test('normalizeGraph 认得出「界面版工作流」并说清怎么改', () => {
  assert.throws(
    () => normalizeGraph({ nodes: [], links: [] }),
    (error) => error instanceof ComfyError && error.code === 'GRAPH' && /API/.test(error.message),
  )
})

test('normalizeGraph 拒绝外层再包一层 prompt / 空图 / 坏节点', () => {
  assert.throws(() => normalizeGraph({ prompt: {} }), /prompt/)
  assert.throws(() => normalizeGraph({}), /空/)
  assert.throws(() => normalizeGraph({ 1: null }), /不是节点对象/)
  assert.throws(() => normalizeGraph({ 1: { inputs: {} } }), /class_type/)
  assert.throws(() => normalizeGraph({ 1: { class_type: 'X', inputs: [] } }), /inputs/)
  assert.throws(() => normalizeGraph([]), /对象/)
})

test('summarizeGraph 给出节点数与按类计数', () => {
  const graph = normalizeGraph(buildTxt2Img({ ...MODELS, prompt: 'p', negative: 'n' }))
  const summary = summarizeGraph(graph)
  assert.equal(summary.count, 9)
  assert.equal(summary.byClass.CLIPTextEncode, 2)
  assert.equal(summary.byClass.KSampler, 1)
  assert.equal(summary.nodes.length, 9)
})

test('injectPrompt 不点名时写进第一个 CLIPTextEncode', () => {
  const graph = normalizeGraph(buildTxt2Img({ ...MODELS, prompt: 'old', negative: 'n' }))
  assert.equal(injectPrompt(graph, 'new'), '4')
  assert.equal(graph[4].inputs.text, 'new')
  assert.equal(graph[5].inputs.text, 'n', '负面提示词不该被动到')
})

test('injectPrompt 点名时写进指定节点，节点不存在会报出有哪些', () => {
  const graph = normalizeGraph(buildTxt2Img({ ...MODELS, prompt: 'old', negative: 'n' }))
  assert.equal(injectPrompt(graph, 'neg', '5'), '5')
  assert.equal(graph[5].inputs.text, 'neg')
  assert.throws(
    () => injectPrompt(graph, 'x', '99'),
    (error) => error instanceof ComfyError && /99/.test(error.message) && /1, 2, 3/.test(error.message),
  )
})

test('injectPrompt 空文本直接返回 null，图里没有 CLIPTextEncode 也返回 null', () => {
  const graph = normalizeGraph({ 1: { class_type: 'VAELoader', inputs: {} } })
  assert.equal(injectPrompt(graph, ''), null)
  assert.equal(injectPrompt(graph, 'text'), null)
})

test('collectImages 摊平历史记录里的输出图', () => {
  const entry = {
    outputs: {
      9: { images: [{ filename: 'a.png', subfolder: 'dsh', type: 'output' }] },
      12: { images: [{ filename: 'b.png' }], other: 'ignored' },
    },
  }
  const images = collectImages(entry)
  assert.equal(images.length, 2)
  assert.deepEqual(images[0], { nodeId: '9', filename: 'a.png', subfolder: 'dsh', type: 'output' })
  assert.deepEqual(images[1], { nodeId: '12', filename: 'b.png', subfolder: '', type: 'output' })
  assert.deepEqual(collectImages(undefined), [])
})

test('resolveModels 不点名就用文件夹里第一个', () => {
  const index = { diffusion_models: ['d1', 'd2'], text_encoders: ['t1'], vae: ['v1'] }
  assert.deepEqual(resolveModels(index), { unet: 'd1', clip: 't1', vae: 'v1' })
})

test('resolveModels 认得 checkpoints 里的整合包，一个名字就够了', () => {
  const index = {
    diffusion_models: ['d1'],
    checkpoints: ['Illustrious-XL-v2.0.safetensors'],
    text_encoders: ['t1'],
    vae: ['v1'],
  }
  // 点整合包的名字 → 走 CheckpointLoaderSimple，不再需要 clip/vae
  assert.deepEqual(resolveModels(index, { unet: 'Illustrious-XL-v2.0.safetensors' }), {
    checkpoint: 'Illustrious-XL-v2.0.safetensors',
  })
  // 点三件套的名字 → 还是三件套
  assert.deepEqual(resolveModels(index, { unet: 'd1' }), { unet: 'd1', clip: 't1', vae: 'v1' })
  // 不点名时 diffusion_models 优先
  assert.deepEqual(resolveModels(index), { unet: 'd1', clip: 't1', vae: 'v1' })
})

test('resolveModels 只有 checkpoints 时退回整合包，不再要求 text_encoders / vae', () => {
  const index = { diffusion_models: [], checkpoints: ['ck1.safetensors'], text_encoders: [], vae: [] }
  assert.deepEqual(resolveModels(index), { checkpoint: 'ck1.safetensors' })
  assert.deepEqual(resolveModels(index, { unet: 'ck1.safetensors' }), { checkpoint: 'ck1.safetensors' })
})

test('resolveModels 点名了就必须存在，否则把可选清单报出来', () => {
  const index = { diffusion_models: ['d1', 'd2'], text_encoders: ['t1'], vae: ['v1'] }
  assert.deepEqual(resolveModels(index, { unet: 'd2' }).unet, 'd2')
  assert.throws(
    () => resolveModels(index, { unet: 'nope' }),
    (error) => error instanceof ComfyError && error.code === 'MODEL' && /d1, d2/.test(error.message),
  )
  assert.throws(
    () => resolveModels({ diffusion_models: [], checkpoints: [], text_encoders: ['t1'], vae: ['v1'] }),
    (error) => error instanceof ComfyError && /一个模型都没有/.test(error.message),
  )
})

test('buildTxt2Img 给 checkpoint 时只用一个 CheckpointLoaderSimple 带出三件', () => {
  const graph = buildTxt2Img({ checkpoint: 'ck.safetensors', prompt: 'p', negative: 'n' })
  assert.equal(Object.keys(graph).length, 7)
  assert.equal(graph[1].class_type, 'CheckpointLoaderSimple')
  assert.equal(graph[1].inputs.ckpt_name, 'ck.safetensors')
  assert.equal(graph[2].class_type, 'CLIPTextEncode')
  assert.equal(graph[4].class_type, 'EmptyLatentImage')
  assert.deepEqual(graph[5].inputs.model, ['1', 0])
  assert.deepEqual(graph[5].inputs.positive, ['2', 0])
  assert.deepEqual(graph[6].inputs.vae, ['1', 2])
  assert.equal(graph[7].class_type, 'SaveImage')
})

test('buildTxt2Img 的整合包分支挂 LoRA 时插节点 8 并改接 model/clip', () => {
  const graph = buildTxt2Img({ checkpoint: 'ck.safetensors', prompt: 'p', negative: 'n', lora: 'style.safetensors', loraStrength: 0.7 })
  assert.equal(graph[8].class_type, 'LoraLoader')
  assert.equal(graph[8].inputs.lora_name, 'style.safetensors')
  assert.deepEqual(graph[2].inputs.clip, ['8', 1])
  assert.deepEqual(graph[3].inputs.clip, ['8', 1])
  assert.deepEqual(graph[5].inputs.model, ['8', 0])
})

test('buildImg2Img 给 checkpoint 时节点号跟着换，且连线仍用字符串 id', () => {
  const graph = buildImg2Img({ checkpoint: 'ck.safetensors', imageName: 'src.png', prompt: 'p', negative: 'n', denoise: 0.4 })
  assert.equal(graph[1].class_type, 'CheckpointLoaderSimple')
  assert.equal(graph[4].class_type, 'LoadImage')
  assert.equal(graph[5].class_type, 'VAEEncode')
  assert.equal(graph[6].class_type, 'KSampler')
  assert.equal(graph[6].inputs.denoise, 0.4)
  assert.equal(graph[8].class_type, 'SaveImage')
  for (const link of links(graph)) assert.equal(typeof link.to, 'string')
})

test('humanDuration 转成人话，非法输入返回空串', () => {
  assert.equal(humanDuration(45_000), '45s')
  assert.equal(humanDuration(125_000), '2m05s')
  assert.equal(humanDuration(-1), '')
  assert.equal(humanDuration(Number.NaN), '')
})

test('createClient 把 baseUrl 的尾斜杠去掉，方法齐全', () => {
  const client = createClient({ baseUrl: 'http://example.test:8188/' })
  const methods = [
    'systemStats', 'models', 'modelIndex', 'nodeInfo', 'objectInfo', 'queue', 'prompt',
    'jobs', 'job', 'historyEntry', 'history', 'submit', 'view', 'uploadImage',
    'interrupt', 'free', 'clearQueue', 'cancelJob',
  ]
  for (const method of methods) {
    assert.equal(typeof client[method], 'function', `缺 ${method}`)
  }
  assert.equal(client.baseUrl, 'http://example.test:8188')
  assert.equal(createClient({ baseUrl: 'http://example.test:8188' }).baseUrl, 'http://example.test:8188')
})

test('ComfyError 带 code/status/detail', () => {
  const error = new ComfyError('boom', { code: 'OFFLINE', status: 503, detail: { a: 1 } })
  assert.equal(error.name, 'ComfyError')
  assert.equal(error.code, 'OFFLINE')
  assert.equal(error.status, 503)
  assert.deepEqual(error.detail, { a: 1 })
  assert.ok(error instanceof Error)
})
