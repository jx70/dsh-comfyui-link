/**
 * registration.test.mjs —— 把 apply() 跑在假 ctx 上，检查注册出来的东西
 * ============================================================================
 * 宿主对 tools.register 的入参有硬约束（字段白名单、output.schema、render 形状），
 * 违反了是运行时才炸。这里提前钉住：
 *   · 9 个工具都在，名字不重复
 *   · 每个工具的字段只用了宿主认的那几个
 *   · output.schema 是宿主能接受的最小 object schema
 *   · render 能吐 text 块，带图时吐 text + image
 *   · systemPrompt 段注册了，且文本里带服务地址
 *   · 只读路由挂在 /api/comfyui/vision-models，且能筛出「能看图」的模型
 *   · 功能开关默认全关（img2img / LoRA / upscale 会被拦）
 *   · LoRA 提示词目录：路由报「几篇候选 / 其中几篇像提示词」，comfy_lora_doc 给打分表
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createExec, createFakeCtx } from './helpers/fake-ctx.mjs'

const plugin = await import('../index.js')

const EXPECTED_TOOLS = [
  'comfy_status', 'comfy_models', 'comfy_node', 'comfy_run',
  'comfy_result', 'comfy_control', 'comfy_review', 'comfy_upscale', 'comfy_lora_doc',
]

const ALLOWED_KEYS = [
  'name', 'description', 'parameters', 'output', 'execute', 'isConcurrencySafe',
  'timeoutMs', 'presentCall', 'presentResult', 'projectContent', 'finalizeContent', 'deferLoading',
]

function boot(config = {}) {
  const fake = createFakeCtx()
  plugin.apply(fake.ctx, config)
  return fake
}

/**
 * 起一个假的 ComfyUI HTTP 服务，把 /models/* 与 /prompt 接住。
 * 这样能把「挂 LoRA → 查文档 → 并入提示词 → 提交」跑到底，不用真的连本机 ComfyUI。
 * 返回 { baseUrl, promptIds, close }。
 */
function startFakeComfy() {
  const promptIds = []
  const lists = {
    diffusion_models: ['a.safetensors'],
    text_encoders: ['t.safetensors'],
    vae: ['v.safetensors'],
    checkpoints: [],
    loras: [],
  }
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/models/')) {
      const folder = decodeURIComponent(req.url.slice('/models/'.length))
      const list = lists[folder] ?? []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
      return
    }
    if (req.method === 'POST' && req.url === '/prompt') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        promptIds.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ prompt_id: `fake-${promptIds.length}`, number: promptIds.length }))
      })
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        promptIds,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

test('插件身份：name 固定是 comfyui，inject 声明 tools 与 systemPrompt', () => {
  assert.equal(plugin.name, 'comfyui')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
})

test('不能有 default 导出（cordis 的 unwrapExports 会丢掉 inject）', () => {
  assert.equal(plugin.default, undefined)
})

test('9 个工具全部注册，名字与文档一致', () => {
  const { tools } = boot()
  assert.deepEqual([...tools.keys()], EXPECTED_TOOLS)
})

test('每个工具只用宿主认的字段', () => {
  const { tools } = boot()
  for (const [name, definition] of tools) {
    for (const key of Object.keys(definition)) {
      assert.ok(ALLOWED_KEYS.includes(key), `${name} 用了不认识的字段 ${key}`)
    }
  }
})

test('每个工具都有非空 description、object 类型的 parameters、可调用的 execute', () => {
  const { tools } = boot()
  for (const [name, definition] of tools) {
    assert.equal(typeof definition.description, 'string', `${name} 缺 description`)
    assert.ok(definition.description.length > 0, `${name} 的 description 是空的`)
    assert.equal(definition.parameters?.type, 'object', `${name} 的 parameters 不是 object`)
    assert.equal(typeof definition.execute, 'function', `${name} 缺 execute`)
  }
})

test('工具名都带 comfy_ 前缀，避免和别的插件撞名', () => {
  const { tools } = boot()
  for (const name of tools.keys()) assert.match(name, /^comfy_/)
})

test('output.schema 是最小 object schema，render 吐合法 ContentBlock', () => {
  const { tools } = boot()
  for (const [name, definition] of tools) {
    assert.deepEqual(definition.output.schema, { type: 'object', additionalProperties: true }, `${name} 的 schema`)

    const plain = definition.output.render({}, { text: 'hello' })
    assert.ok(Array.isArray(plain), `${name} 的 render 没返回数组`)
    assert.equal(plain.length, 1, `${name} 无图时应该只有文本块`)
    assert.deepEqual(plain[0], { type: 'text', text: 'hello' })

    const ref = { attachmentId: 'att_1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
    const withImage = definition.output.render({}, { text: 'x', images: [ref] })
    assert.equal(withImage.length, 2, `${name} 带图时应该有 2 块`)
    assert.equal(withImage[0].type, 'text')
    assert.deepEqual(withImage[1], { type: 'image', attachment: ref })

    // 没有 text 也要能渲染，且不能把 undefined 吐成字符串
    const empty = definition.output.render({}, {})
    assert.deepEqual(empty, [{ type: 'text', text: '' }])

    // images 里混入垃圾不该炸
    const dirty = definition.output.render({}, { text: 'y', images: [null, {}, 'str', ref] })
    assert.equal(dirty.length, 2)
  }
})

test('注册了 tool:comfyui 系统提示段，顺序取 TOOL_COMPUTER_USE，文本带服务地址', () => {
  const { sections } = boot({ baseUrl: 'http://comfy.example:9999' })
  assert.equal(sections.length, 1)
  const [section] = sections
  assert.equal(section.name, 'tool:comfyui')
  assert.equal(section.order, 3000)
  const text = section.text({ scope: undefined })
  assert.match(text, /ComfyUI/)
  assert.match(text, /comfy_run/)
  assert.match(text, /comfy_result/)
})

test('只读路由挂上 /api/comfyui/vision-models，且只留能看图的模型', async () => {
  const { routes } = boot()
  const route = routes.find((r) => r.path === '/api/comfyui/vision-models')
  assert.ok(route, '路由没注册')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')

  const response = await route.fetch(new Request('http://localhost/api/comfyui/vision-models'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const body = await response.json()
  assert.equal(body.ok, true)
  // fake ctx 的 llm 只给了一个 provider、两个模型，其中只有 vision 那个能看图
  assert.equal(body.providers.length, 1)
  assert.equal(body.providers[0].id, 'mock-provider')
  assert.deepEqual(body.providers[0].models.map((m) => m.id), ['mock-vision-model'])
})

test('只读路由挂上 /api/comfyui/draw-models，给对话栏的生图模型下拉供数据', async () => {
  // 死端口：既保证不会碰到真在跑的 ComfyUI（否则本机会返回 200），也保证快速失败
  const { routes } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  const route = routes.find((r) => r.path === '/api/comfyui/draw-models')
  assert.ok(route, '生图模型清单路由没注册')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')

  // ComfyUI 没跑时必须给一份「空清单 + 原因」，而不是抛出去变成 500 崩栈
  const response = await route.fetch(new Request('http://localhost/api/comfyui/draw-models'))
  assert.equal(response.status, 502)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(typeof body.error, 'string')
  assert.ok(body.error.length > 0)
  assert.deepEqual(body.folders, {})
})

test('只读路由挂上 /api/comfyui/lora-docs，给设置页报「识别到几篇」', async () => {
  // 没配目录时必须立刻回 200 + 空清单：一个文件都不读，也不碰 ComfyUI
  const { routes } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  const route = routes.find((r) => r.path === '/api/comfyui/lora-docs')
  assert.ok(route, 'LoRA 提示词目录路由没注册')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')

  const response = await route.fetch(new Request('http://localhost/api/comfyui/lora-docs'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.dir, '')
  assert.equal(body.maxChars, 4000)
  assert.equal(body.count, 0)
  assert.equal(body.promptish, 0)
  assert.deepEqual(body.docs, [])
})

test('配了不存在的 LoRA 提示词目录时，路由给 502 + 原因，不崩栈', async () => {
  const { routes } = boot({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 2000,
    loraDocs: { dir: 'no-such-dir-here' },
  })
  const route = routes.find((r) => r.path === '/api/comfyui/lora-docs')
  // 相对路径 + 认不出 ComfyUI 的 output → resolveConfiguredDir 抛错，这里必须接住
  const response = await route.fetch(new Request('http://localhost/api/comfyui/lora-docs'))
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(typeof body.error, 'string')
  assert.equal(body.count, 0)
  assert.equal(body.promptish, 0)
  assert.deepEqual(body.docs, [])
})

test('配了真目录时，路由顺带报「几篇候选 / 其中几篇像提示词」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-lora-route-'))
  try {
    await writeFile(join(root, '角色笔记.md'), [
      '# 银发角色',
      '',
      '这套是 Belle Anima v1 训的。',
      '',
      '## 提示词',
      'masterpiece, best quality, 1girl, silver long hair',
    ].join('\n'))
    await writeFile(join(root, 'notes.txt'), '这里记一点杂事。\n买牛奶，修图，回消息。')
    const { routes } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, loraDocs: { dir: root, maxChars: 6000 } })
    const route = routes.find((r) => r.path === '/api/comfyui/lora-docs')
    const response = await route.fetch(new Request('http://localhost/api/comfyui/lora-docs'))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    // 设置页要能看出「判定用的是多少字的预算」，否则改了预算它也不会重算
    assert.equal(body.maxChars, 6000)
    assert.equal(body.count, 2)
    // 只有「角色笔记.md」里那串 tag 像提示词；notes.txt 是散文
    assert.equal(body.promptish, 1)
    assert.equal(body.docs.find((doc) => doc.name === '角色笔记.md').promptish, true)
    assert.equal(body.docs.find((doc) => doc.name === 'notes.txt').promptish, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('comfy_lora_doc：给了 lora 就返回打分表，名字不对齐也能挑中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-lora-pick-'))
  try {
    await writeFile(join(root, '角色笔记.md'), [
      '# 银发角色',
      '',
      '这套是 Belle Anima v1 训的。',
      '',
      '## 提示词',
      'masterpiece, best quality, 1girl, silver long hair, red eyes',
    ].join('\n'))
    await writeFile(join(root, '画风随笔.txt'), '最近在试一种更冷的色调。\n画面的光比很大，阴影偏蓝。')
    const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, loraDocs: { dir: root } })
    const result = await tools.get('comfy_lora_doc').execute({ lora: 'belle_anima_v1.safetensors' }, createExec())
    // 打分表 + 挑中的那篇 + 正文里那段提示词
    assert.match(result.text, /打分（前 5）：/)
    assert.match(result.text, /角色笔记\.md/)
    assert.match(result.text, /挑中：角色笔记\.md/)
    assert.match(result.text, /按内容匹配/)
    assert.match(result.text, /silver long hair/)
    // 散文那篇也出现在打分表里（透明），但 0 分、不会被挑中
    assert.match(result.text, /0\s+画风随笔\.txt/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('comfy_lora_doc：长文档说清并了多少字，rest:true 给出被截掉的后半段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-lora-rest-'))
  try {
    const tags = Array.from({ length: 100 }, (_, i) => `tag_${i}`)
    const docText = [
      '这套是 Belle Anima v1 训的。',
      '',
      '## 提示词',
      'masterpiece, best quality, 1girl, silver long hair,',
      tags.join(', '),
      '',
      '## 参数建议',
      'steps 28, cfg 5',
    ].join('\n')
    await writeFile(join(root, 'belle_anima_v1.txt'), docText)
    const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, loraDocs: { dir: root, maxChars: 300 } })
    const doc = tools.get('comfy_lora_doc')
    const head = await doc.execute({ lora: 'belle_anima_v1.safetensors' }, createExec())
    assert.match(head.text, /并进 prompt 300 字? ?\/原文|\/ 原文 \d+ 字/)
    assert.match(head.text, /上限 300/)
    assert.match(head.text, /rest:true/)
    assert.match(head.text, /full:true/)
    // 默认视图只给收口后的那一段，后半段不在里面
    assert.doesNotMatch(head.text, /参数建议/)

    const rest = await doc.execute({ lora: 'belle_anima_v1.safetensors', rest: true }, createExec())
    assert.match(rest.text, /后面还剩 \d+ 字没并/)
    // 后半段确实接着默认视图的末尾
    assert.match(rest.text, /tag_9\d/)
    assert.doesNotMatch(rest.text, /masterpiece/)

    const full = await doc.execute({ lora: 'belle_anima_v1.safetensors', full: true }, createExec())
    assert.match(full.text, /masterpiece/)
    assert.match(full.text, /参数建议/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('comfy_lora_doc：短文档 rest:true 说明「没有剩余内容」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-lora-rest-short-'))
  try {
    await writeFile(join(root, 'belle_anima_v1.txt'), '## 提示词\nmasterpiece, 1girl')
    const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, loraDocs: { dir: root } })
    const result = await tools.get('comfy_lora_doc').execute({ lora: 'belle_anima_v1.safetensors', rest: true }, createExec())
    assert.match(result.text, /没有剩余内容/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('comfy_lora_doc：没配目录只说明怎么配，不抛错也不读文件', async () => {
  const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  const result = await tools.get('comfy_lora_doc').execute({}, createExec())
  assert.match(result.text, /还没指定 LoRA 提示词目录/)
  assert.match(result.text, /设置页/)
})

test('comfy_lora_doc：目录读不了也只回一句说明', async () => {
  const { tools } = boot({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 2000,
    loraDocs: { dir: 'no-such-dir-here' },
  })
  const result = await tools.get('comfy_lora_doc').execute({}, createExec())
  assert.match(result.text, /LoRA 提示词目录用不了/)
})

test('comfy_run / comfy_review 的 lora_doc 只认 auto 与 off', () => {
  const { tools } = boot()
  for (const name of ['comfy_run', 'comfy_review']) {
    const schema = tools.get(name).parameters.properties.lora_doc
    assert.ok(schema, `${name} 没有 lora_doc 参数`)
    assert.deepEqual(schema.enum, ['auto', 'off'])
  }
})

test('挂了 LoRA 但没配提示词目录：结果里交代「没查文档」，不再静默', async () => {
  const server = await startFakeComfy()
  try {
    const { tools } = boot({ baseUrl: server.baseUrl, timeoutMs: 2000, draw: { unet: 'a.safetensors', lora: true } })
    const result = await tools.get('comfy_run').execute(
      { mode: 'template', prompt: 'a cat', lora: 'belle.safetensors' },
      createExec(),
    )
    assert.match(result.text, /没配「LoRA 提示词」目录/)
    assert.match(result.text, /没查文档/)
  } finally {
    await server.close()
  }
})

test('挂了 LoRA 但传 lora_doc:"off"：结果里交代「跳过了文档」', async () => {
  const server = await startFakeComfy()
  try {
    const { tools } = boot({ baseUrl: server.baseUrl, timeoutMs: 2000, draw: { unet: 'a.safetensors', lora: true } })
    const result = await tools.get('comfy_run').execute(
      { mode: 'template', prompt: 'a cat', lora: 'belle.safetensors', lora_doc: 'off' },
      createExec(),
    )
    assert.match(result.text, /lora_doc:"off"/)
    assert.match(result.text, /跳过了文档/)
  } finally {
    await server.close()
  }
})

test('graph 模式里有 LoraLoader：长文档按边界收口，结果里写明原文多少字 / 并了多少字', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-graph-doc-'))
  const server = await startFakeComfy()
  try {
    // 一篇真实规模的角色卡：正文里提到 LoRA 名，提示词段远超过 500 字的上限
    const tags = Array.from({ length: 200 }, (_, i) => `tag_${i}`)
    const docText = [
      '这套是 Belle Anima v1 训的。',
      '',
      '## 提示词',
      'masterpiece, best quality, 1girl, silver long hair,',
      tags.join(', '),
    ].join('\n')
    await writeFile(join(root, 'belle_anima_v1.txt'), docText)
    await writeFile(join(root, 'belle_anima_v1.safetensors'), '')
    const { tools } = boot({
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      draw: { unet: 'a.safetensors', lora: true },
      loraDocs: { dir: root, maxChars: 500 },
    })
    const graph = {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ckpt.safetensors' } },
      2: { class_type: 'LoraLoader', inputs: { lora_name: 'belle_anima_v1.safetensors', model: ['1', 0], clip: ['1', 1], strength_model: 0.8, strength_clip: 0.8 } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: 'a girl', clip: ['2', 1] } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: ['2', 1] } },
    }
    const result = await tools.get('comfy_run').execute({ mode: 'graph', graph }, createExec())
    // 结果里交代命中了哪篇，并且写明预算
    assert.match(result.text, /belle_anima_v1\.txt/)
    assert.match(result.text, /已并入/)
    assert.match(result.text, /上限 500/)
    assert.match(result.text, /没并/)
    assert.match(result.text, /rest:true/)
    // 提交给 ComfyUI 的正面 CLIPTextEncode 真的并进了文档里的提示词，且不超过预算
    const submitted = JSON.parse(server.promptIds[0])
    const positive = Object.values(submitted.prompt).find((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text.includes('a girl'))
    assert.ok(positive, '没找到正面 CLIPTextEncode 节点')
    assert.match(positive.inputs.text, /silver long hair/)
    const docPart = positive.inputs.text.slice('a girl\n\n'.length)
    assert.ok(docPart.length <= 500, `并进 prompt 的文档段超了上限：${docPart.length}`)
    // 收口必须落在边界上：并进去的这段是原文的前缀，且原文紧接着的字符是分隔符 —— 没切半个 tag
    const sourceSection = docText.split('## 提示词\n')[1].trim()
    assert.ok(sourceSection.startsWith(docPart), '并进的不是原文前缀')
    const nextChar = sourceSection.slice(docPart.length, docPart.length + 1)
    assert.ok(nextChar === '' || /[\s,，、;；]/.test(nextChar), `切在字符中间，后面是 ${JSON.stringify(nextChar)}`)
  } finally {
    await rm(root, { recursive: true, force: true })
    await server.close()
  }
})

test('graph 模式里有 LoraLoader：短文档全篇并入，结果里说「全篇并进去了」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-graph-doc-short-'))
  const server = await startFakeComfy()
  try {
    await writeFile(join(root, '铃.txt'), [
      '这套是 Belle Anima v1 训的。',
      '',
      '## 提示词',
      'masterpiece, best quality, 1girl, silver long hair',
    ].join('\n'))
    await writeFile(join(root, 'belle_anima_v1.safetensors'), '')
    const { tools } = boot({
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      draw: { unet: 'a.safetensors', lora: true },
      loraDocs: { dir: root },
    })
    const graph = {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ckpt.safetensors' } },
      2: { class_type: 'LoraLoader', inputs: { lora_name: 'belle_anima_v1.safetensors', model: ['1', 0], clip: ['1', 1], strength_model: 0.8, strength_clip: 0.8 } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: 'a girl', clip: ['2', 1] } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: ['2', 1] } },
    }
    const result = await tools.get('comfy_run').execute({ mode: 'graph', graph }, createExec())
    assert.match(result.text, /铃\.txt/)
    assert.match(result.text, /全篇并进去了/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await server.close()
  }
})

test('没有 connection 服务时安静跳过路由，不影响工具注册', () => {
  const fake = createFakeCtx()
  delete fake.ctx.connection
  plugin.apply(fake.ctx, {})
  assert.equal(fake.routes.length, 0)
  assert.equal(fake.tools.size, 9)
})

test('默认配置下三个功能开关全关，调用会被拦并提示去设置页 / 对话栏开', async () => {
  // baseUrl 指到必然没人听的端口：这些校验必须发生在联网之前，
  // 否则开着 ComfyUI 的机器上测试会假通过，CI 上才炸。
  const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  const exec = createExec()

  await assert.rejects(
    () => tools.get('comfy_run').execute({ mode: 'img2img', prompt: 'x', image_prompt_id: 'p1' }, exec),
    /没开启|开启/,
  )
  await assert.rejects(
    () => tools.get('comfy_run').execute({ mode: 'template', prompt: 'x', lora: 'a.safetensors' }, exec),
    /没开启|开启/,
  )
  await assert.rejects(
    () => tools.get('comfy_upscale').execute({ image_prompt_id: 'p1', width: 1024, height: 1024 }, exec),
    /没开启|开启/,
  )
})

test('LoRA 闸指向对话栏（不是设置页），文案说清去哪儿打开', async () => {
  const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  await assert.rejects(
    () => tools.get('comfy_run').execute({ mode: 'template', prompt: 'x', lora: 'a.safetensors' }, createExec()),
    (error) => {
      const message = String(error?.message ?? error)
      assert.match(message, /LoRA/)
      assert.match(message, /输入框左侧/)
      assert.doesNotMatch(message, /设置页/)
      return true
    },
  )
})

test('开关打开后不再被「没开启」拦下（会在网络那一步才失败）', async () => {
  // baseUrl 指到一个必然没人听的端口：既保证不会碰到真服务，也保证快速失败
  const { tools } = boot({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 2000,
    img2img: { enabled: true },
    upscale: { enabled: true },
    draw: { unet: '', lora: true },
  })
  const exec = createExec()

  // 走不到网络就该报别的错；这里只确认不再是「没开启」
  const cases = [
    () => tools.get('comfy_run').execute({ mode: 'img2img', prompt: 'x' }, exec),
    () => tools.get('comfy_upscale').execute({ image_prompt_id: 'p1', width: 1024, height: 1024 }, exec),
  ]
  for (const run of cases) {
    await run().then(
      () => {},
      (error) => assert.doesNotMatch(String(error?.message ?? error), /没开启/),
    )
  }
})

test('comfy_run 的 graph 模式：空图 / 界面版工作流被提前拦下', async () => {
  const { tools } = boot()
  const exec = createExec()
  const run = tools.get('comfy_run')

  await assert.rejects(() => run.execute({ mode: 'graph' }, exec), /必须给 graph/)
  await assert.rejects(() => run.execute({ mode: 'graph', graph: { nodes: [], links: [] } }, exec), /API/)
  await assert.rejects(() => run.execute({ mode: 'graph', graph: {} }, exec), /空/)
  await assert.rejects(
    () => run.execute({ mode: 'graph', graph: { 1: { class_type: 'VAELoader', inputs: {} } }, prompt: 'x' }, exec),
    /prompt_node/,
  )
})

test('comfy_run 拒绝不认识的 mode', async () => {
  const { tools } = boot()
  await assert.rejects(
    () => tools.get('comfy_run').execute({ mode: 'nope', prompt: 'x' }, createExec()),
    /不认识的 mode/,
  )
})

test('template / img2img 模式缺 prompt 会被拦', async () => {
  // 同上：参数校验不能排在联网之后，所以这里也把 baseUrl 指向死端口。
  const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, img2img: { enabled: true } })
  const run = tools.get('comfy_run')
  await assert.rejects(() => run.execute({ mode: 'template' }, createExec()), /必须给 prompt/)
  await assert.rejects(() => run.execute({ mode: 'template', prompt: '   ' }, createExec()), /必须给 prompt/)
  await assert.rejects(() => run.execute({ mode: 'img2img', prompt: 'x' }, createExec()), /image_prompt_id/)
})

test('参数校验排在联网之前：ComfyUI 没跑也不影响报错内容', async () => {
  // 这条守的是「别把纯参数校验放到 await 网络请求后面」。
  // 本机开着 ComfyUI 时，顺序写反了也照样能过，只有 CI 那种干净环境才暴露。
  const dead = { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 }
  const cases = [
    { config: dead, tool: 'comfy_run', args: { mode: 'img2img', prompt: 'x', image_prompt_id: 'p1' }, want: /没开启/ },
    { config: dead, tool: 'comfy_run', args: { mode: 'template', prompt: 'x', lora: 'a.safetensors' }, want: /没开启/ },
    { config: dead, tool: 'comfy_upscale', args: { image_prompt_id: 'p1', width: 1024, height: 1024 }, want: /没开启/ },
    { config: { ...dead, img2img: { enabled: true } }, tool: 'comfy_run', args: { mode: 'img2img', prompt: 'x' }, want: /image_prompt_id/ },
    { config: dead, tool: 'comfy_run', args: { mode: 'template' }, want: /必须给 prompt/ },
  ]
  for (const { config, tool, args, want } of cases) {
    const { tools } = boot(config)
    await assert.rejects(() => tools.get(tool).execute(args, createExec()), want, `工具 ${tool} 的参数校验被网络错误盖住了`)
  }
})

test('ComfyUI 没跑时，参数全对的调用才会走到网络那一步', async () => {
  const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  await assert.rejects(
    () => tools.get('comfy_run').execute({ mode: 'template', prompt: '一只猫' }, createExec()),
    (error) => {
      const message = String(error?.message ?? error)
      // 具体文案随平台变（ECONNREFUSED / fetch failed），关键是它已经是网络错，
      // 而不是参数校验或开关拦截。
      assert.match(message, /ComfyUI/)
      assert.doesNotMatch(message, /没开启|必须给 prompt|image_prompt_id/)
      return true
    },
  )
})

test('comfy_upscale 的 method 只给五个算法，默认 lanczos 走 lib', () => {
  const { tools } = boot()
  const params = tools.get('comfy_upscale').parameters
  assert.deepEqual(params.required, ['image_prompt_id', 'width', 'height'])
  assert.deepEqual(params.properties.method.enum, ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'])
})

test('三个取图入口都能收 save_to，且它不是必填项', () => {
  const { tools } = boot()
  for (const [name, required] of [
    ['comfy_result', ['prompt_id']],
    ['comfy_review', ['prompt_id', 'requirement']],
    ['comfy_upscale', ['image_prompt_id', 'width', 'height']],
  ]) {
    const params = tools.get(name).parameters
    assert.deepEqual(params.required, required, `${name} 的必填项变了`)
    assert.equal(params.properties.save_to?.type, 'string', `${name} 少了 save_to 参数`)
    assert.doesNotMatch(
      params.properties.save_to.description,
      /设置页把/,
      `${name} 的 save_to 说明要指向设置页的输出目录，不是开关`,
    )
  }
})

test('comfy_run 的 mode 是唯一必填项，其余都可选', () => {
  const { tools } = boot()
  const params = tools.get('comfy_run').parameters
  assert.deepEqual(params.required, ['mode'])
  assert.deepEqual(params.properties.mode.enum, ['template', 'img2img', 'graph'])
})

test('带 timeoutMs 的工具都给了正的毫秒数', () => {
  const { tools } = boot()
  for (const [name, definition] of tools) {
    if (definition.timeoutMs === undefined) continue
    assert.equal(typeof definition.timeoutMs, 'number', `${name} 的 timeoutMs 不是数字`)
    assert.ok(definition.timeoutMs > 0, `${name} 的 timeoutMs 不是正数`)
  }
})
