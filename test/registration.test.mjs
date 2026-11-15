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
function startFakeComfy(overrides = {}) {
  const promptIds = []
  const lists = {
    diffusion_models: ['a.safetensors'],
    text_encoders: ['t.safetensors'],
    vae: ['v.safetensors'],
    checkpoints: [],
    loras: [],
    ...overrides,
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

test('comfy_lora_doc：多段 tag 装不下时，rest:true 给出没并进去的那几段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-lora-rest-'))
  try {
    // 真实文档的形态：每套服装一整段 tag，段间空行隔开；另有散文段要跳过
    const outfit = (name, n) =>
      [`belle_anima_v1, ${name}`, Array.from({ length: n }, (_, i) => `${name}_part_${i}`).join(', ')].join('\n')
    const docText = [
      '这套是 Belle Anima v1 训的。',
      '',
      '【一】模型信息',
      '作者：某人。训练集 200 张。',
      '',
      '## 提示词',
      outfit('school', 12),
      '',
      outfit('roomwear', 12),
      '',
      outfit('battle', 12),
      '',
      '【九】踩坑清单',
      '这一套要额外压短发回流。',
    ].join('\n')
    await writeFile(join(root, 'belle_anima_v1.txt'), docText)
    const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, loraDocs: { dir: root, maxChars: 300 } })
    const doc = tools.get('comfy_lora_doc')
    const head = await doc.execute({ lora: 'belle_anima_v1.safetensors' }, createExec())
    // 说清「挑了几段 / 共多少字 / 预算多少 / 还有几段没并」
    assert.match(head.text, /段 tag、共 \d+ 字（预算 300/)
    assert.match(head.text, /另有 \d+ 段没并/)
    assert.match(head.text, /rest:true/)
    assert.match(head.text, /full:true/)
    // 散文段绝不进 prompt
    assert.doesNotMatch(head.text, /训练集 200 张/)
    assert.doesNotMatch(head.text, /压短发回流/)
    // 默认视图里「没并进来的那段」不在正文里
    const headBody = head.text.split('\n\n').slice(-1)[0]
    assert.ok(!/battle_part_11/.test(headBody), '没并的段不该出现在默认视图正文里')

    const rest = await doc.execute({ lora: 'belle_anima_v1.safetensors', rest: true }, createExec())
    assert.match(rest.text, /另有 \d+ 段没并/)
    // rest 给的正是没进默认视图的那段
    const missing = ['school', 'roomwear', 'battle'].filter((name) => !headBody.includes(`${name}_part_11`))
    assert.ok(missing.length > 0, 'fixture 没造出「装不下的段」')
    for (const name of missing) assert.match(rest.text, new RegExp(`${name}_part_11`))

    const full = await doc.execute({ lora: 'belle_anima_v1.safetensors', full: true }, createExec())
    assert.match(full.text, /训练集 200 张/)
    assert.match(full.text, /belle_anima_v1, battle/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('comfy_lora_doc：整篇只有一段超长 tag 时，按边界切到预算内（不整篇白读）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-lora-one-line-'))
  try {
    const tags = Array.from({ length: 100 }, (_, i) => `tag_${i}`)
    await writeFile(join(root, 'belle_anima_v1.txt'), [
      '这套是 Belle Anima v1 训的。',
      '',
      '## 提示词',
      `masterpiece, best quality, 1girl, ${tags.join(', ')}`,
    ].join('\n'))
    const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, loraDocs: { dir: root, maxChars: 300 } })
    const head = await tools.get('comfy_lora_doc').execute({ lora: 'belle_anima_v1.safetensors' }, createExec())
    // 单段超长 tag 走「整段按边界收口」的 plain 口径：并进多少 / 原文多少 / 切在哪种边界
    assert.match(head.text, /并进 prompt \d+ \/ 原文 \d+ 字/)
    assert.match(head.text, /上限 300/)
    assert.match(head.text, /余下 \d+ 字没并/)
    // 正文里确实带了开头那几个 tag，而且没超预算
    assert.match(head.text, /masterpiece, best quality/)
    assert.doesNotMatch(head.text, /整篇都是空白/)
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

test('comfy_lora_doc：传 prompt 就按贴题程度预演，跟 comfy_run 实际并进去的一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-lora-probe-'))
  try {
    // 两套服装，预算只装得下一套：谁入选完全取决于 prompt 里提到哪个词。
    // maxChars 的 schema 下限是 200，所以夹具把两段各写到 ~138 字（合计 271 > 200）。
    const docText = [
      '## 提示词',
      ['belle_anima_v1, school', 'school_uniform, yellow necktie, pleated skirt, white socks, loafers, cardigan, hair ribbon, brown hair, twin braids'].join('\n'),
      '',
      ['belle_anima_v1, battle', 'battle_uniform, combat boots, fingerless gloves, ammo belt, holster, shoulder pads, tactical vest, silver hair'].join('\n'),
    ].join('\n')
    await writeFile(join(root, 'belle_anima_v1.txt'), docText)
    const { tools } = boot({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, loraDocs: { dir: root, maxChars: 200 } })
    const doc = tools.get('comfy_lora_doc')

    const school = await doc.execute({ lora: 'belle_anima_v1.safetensors', prompt: '1girl, school uniform' }, createExec())
    assert.match(school.text, /school_uniform/)
    assert.doesNotMatch(school.text.split('\n\n').slice(-1)[0], /battle_uniform/)

    const battle = await doc.execute({ lora: 'belle_anima_v1.safetensors', prompt: '1girl, battle uniform' }, createExec())
    assert.match(battle.text, /battle_uniform/)
    assert.doesNotMatch(battle.text.split('\n\n').slice(-1)[0], /school_uniform/)
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

test('comfy_models：开头报「当前绘图配置」，LoRA 附角色别名，且不再点名某个模型', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-models-alias-'))
  const server = await startFakeComfy({ loras: ['natsume-000016.safetensors'], diffusion_models: ['anima-base-v1.0.safetensors'] })
  try {
    await writeFile(join(root, '四季夏目_Anima_LoRA_提示词清单.txt'), [
      '========================================================================',
      '四季夏目（四季 ナツメ / Shiki Natsume）Anima LoRA 提示词清单',
      '',
      '## 提示词',
      'shiki natsume, long light blue hair, yellow eyes, braid',
    ].join('\n'))
    await writeFile(join(root, 'natsume-000016.safetensors'), '')
    const { tools } = boot({
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      draw: { unet: 'anima-base-v1.0.safetensors', lora: true },
      loraDocs: { dir: root },
    })
    const result = await tools.get('comfy_models').execute({}, createExec())
    // 模型看不到对话栏选了什么，只能靠这一行知道「到底在用哪个模型」
    assert.match(result.text, /当前绘图配置/)
    assert.match(result.text, /生图模型：anima-base-v1\.0\.safetensors/)
    assert.match(result.text, /不会覆盖/)
    assert.match(result.text, /LoRA：允许挂/)
    // LoRA 后面要跟角色别名，否则模型没法把「四季夏目」和 natsume-000016 联系起来
    assert.match(result.text, /natsume-000016\.safetensors[^\n]*四季夏目/)
    // 别再往模型脑子里灌「Illustrious / 光辉 更懂 danbooru tag」这类联想
    const description = tools.get('comfy_models').description
    assert.doesNotMatch(description, /光辉/)
    assert.doesNotMatch(description, /Illustrious/i)
    assert.match(description, /lora:"auto"/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await server.close()
  }
})

test('comfy_run：没传 lora 但配了文档目录 —— 结果里说清「这次没读文档」，并指路 lora:"auto"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-run-nolora-'))
  const server = await startFakeComfy()
  try {
    await writeFile(join(root, '铃.txt'), '## 提示词\nbellezzz, baseout, black shirt, long sleeves\n')
    const { tools } = boot({
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      draw: { unet: 'a.safetensors', lora: true },
      loraDocs: { dir: root },
    })
    const result = await tools.get('comfy_run').execute({ mode: 'template', prompt: 'a cat' }, createExec())
    assert.match(result.text, /这次没传 lora，没读文档/)
    assert.match(result.text, /lora:"auto"/)
    // 没挂 LoRA 时结果里不该出现「LoRA：」那一行
    assert.doesNotMatch(result.text, /^LoRA：/m)
  } finally {
    await rm(root, { recursive: true, force: true })
    await server.close()
  }
})

test('comfy_run：lora:"auto" 认得出角色就自动挂上，并读该角色的提示词文档', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-run-auto-'))
  const server = await startFakeComfy({ loras: ['natsume-000016.safetensors', 'belle_anima_v1.safetensors'] })
  try {
    await writeFile(join(root, '四季夏目_Anima_LoRA_提示词清单.txt'), [
      '四季夏目（四季 ナツメ / Shiki Natsume）Anima LoRA 提示词清单',
      '',
      '## 提示词',
      'shiki natsume, long light blue hair, yellow eyes, braid, serafuku',
    ].join('\n'))
    await writeFile(join(root, 'natsume-000016.safetensors'), '')
    const { tools } = boot({
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      draw: { unet: 'a.safetensors', lora: true },
      loraDocs: { dir: root },
    })
    // 用户说的是中文，LoRA 文件名是罗马音 —— auto 要能把两者对上
    const result = await tools.get('comfy_run').execute(
      { mode: 'template', prompt: '画个四季夏目，站姿，白背景', lora: 'auto' },
      createExec(),
    )
    assert.match(result.text, /LoRA：natsume-000016\.safetensors/)
    assert.match(result.text, /四季夏目/)
    // 文档里的 tag 真的并进了提交的正面提示词
    const submitted = JSON.parse(server.promptIds[0])
    const positive = Object.values(submitted.prompt).find(
      (node) => node.class_type === 'CLIPTextEncode' && node.inputs.text.includes('画个四季夏目'),
    )
    assert.ok(positive, '没找到正面 CLIPTextEncode 节点')
    assert.match(positive.inputs.text, /long light blue hair/)
    assert.ok(Object.values(submitted.prompt).some((node) => node.class_type === 'LoraLoader'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await server.close()
  }
})

test('comfy_run：lora:"auto" 认不出角色就不挂，并说明「认不出 / 认出多个」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-run-auto-miss-'))
  const server = await startFakeComfy({ loras: ['natsume-000016.safetensors', 'meguru_anima_base_v1.0.safetensors'] })
  try {
    for (const [doc, line] of [
      ['四季夏目.txt', '四季夏目（四季 ナツメ / Shiki Natsume）'],
      ['因幡巡.txt', '因幡巡（因幡 めぐる / Inaba Meguru）'],
    ]) await writeFile(join(root, doc), `${line}\n\n## 提示词\n1girl, solo\n`)
    await writeFile(join(root, 'natsume-000016.safetensors'), '')
    await writeFile(join(root, 'meguru_anima_base_v1.0.safetensors'), '')
    const { tools } = boot({
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      draw: { unet: 'a.safetensors', lora: true },
      loraDocs: { dir: root },
    })
    // 认不出：不挂，说明原因，不抛错
    const miss = await tools.get('comfy_run').execute(
      { mode: 'template', prompt: '画个美少女', lora: 'auto' },
      createExec(),
    )
    assert.match(miss.text, /没认出能对上 loras 名单的角色名/)
    // 「LoRA：<文件名>」那一行只在真挂上时才有；这里只该有解释
    assert.doesNotMatch(miss.text, /^LoRA：\S+\.safetensors$/m)
    // 认出多个：列候选，也不挂 —— 绝不替你猜
    const both = await tools.get('comfy_run').execute(
      { mode: 'template', prompt: '画个四季夏目和因幡巡', lora: 'auto' },
      createExec(),
    )
    assert.match(both.text, /认出了 2 个候选/)
    assert.match(both.text, /natsume-000016\.safetensors/)
    assert.match(both.text, /不替你猜/)
    // 两次都没挂 LoRA 节点
    for (const body of server.promptIds) {
      const graph = JSON.parse(body)
      assert.ok(!Object.values(graph.prompt).some((node) => node.class_type === 'LoraLoader'))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await server.close()
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
    // 收口必须落在 tag 边界上：并进去的每一个 tag 都必须是原文里的完整 tag（没切半个）
    const sourceTags = new Set(docText.split('## 提示词\n')[1].split(/[,\n]/).map((t) => t.trim()).filter(Boolean))
    const sentTags = docPart.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)
    assert.ok(sentTags.length > 0, '一个 tag 都没并进去')
    for (const tag of sentTags) assert.ok(sourceTags.has(tag), `并进去的「${tag}」不是原文里的完整 tag`)
  } finally {
    await rm(root, { recursive: true, force: true })
    await server.close()
  }
})

test('graph 模式里有 LoraLoader：短文档全篇并入，结果里说「全挑完了」', async () => {
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
    // 单段 tag 走 plain 口径：短文档「全篇并进去了」
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
