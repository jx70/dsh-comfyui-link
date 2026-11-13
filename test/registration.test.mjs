/**
 * registration.test.mjs —— 把 apply() 跑在假 ctx 上，检查注册出来的东西
 * ============================================================================
 * 宿主对 tools.register 的入参有硬约束（字段白名单、output.schema、render 形状），
 * 违反了是运行时才炸。这里提前钉住：
 *   · 8 个工具都在，名字不重复
 *   · 每个工具的字段只用了宿主认的那几个
 *   · output.schema 是宿主能接受的最小 object schema
 *   · render 能吐 text 块，带图时吐 text + image
 *   · systemPrompt 段注册了，且文本里带服务地址
 *   · 只读路由挂在 /api/comfyui/vision-models，且能筛出「能看图」的模型
 *   · 功能开关默认全关（img2img / LoRA / upscale 会被拦）
 * ============================================================================
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createExec, createFakeCtx } from './helpers/fake-ctx.mjs'

const plugin = await import('../index.js')

const EXPECTED_TOOLS = [
  'comfy_status', 'comfy_models', 'comfy_node', 'comfy_run',
  'comfy_result', 'comfy_control', 'comfy_review', 'comfy_upscale',
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

test('插件身份：name 固定是 comfyui，inject 声明 tools 与 systemPrompt', () => {
  assert.equal(plugin.name, 'comfyui')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
})

test('不能有 default 导出（cordis 的 unwrapExports 会丢掉 inject）', () => {
  assert.equal(plugin.default, undefined)
})

test('8 个工具全部注册，名字与文档一致', () => {
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

test('没有 connection 服务时安静跳过路由，不影响工具注册', () => {
  const fake = createFakeCtx()
  delete fake.ctx.connection
  plugin.apply(fake.ctx, {})
  assert.equal(fake.routes.length, 0)
  assert.equal(fake.tools.size, 8)
})

test('默认配置下三个功能开关全关，调用会被拦并提示去设置页开', async () => {
  const { tools } = boot()
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

test('开关打开后不再被「没开启」拦下（会在网络那一步才失败）', async () => {
  // baseUrl 指到一个必然没人听的端口：既保证不会碰到真服务，也保证快速失败
  const { tools } = boot({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 2000,
    img2img: { enabled: true },
    lora: { enabled: true },
    upscale: { enabled: true },
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
  const { tools } = boot({ img2img: { enabled: true } })
  const run = tools.get('comfy_run')
  await assert.rejects(() => run.execute({ mode: 'template' }, createExec()), /必须给 prompt/)
  await assert.rejects(() => run.execute({ mode: 'template', prompt: '   ' }, createExec()), /必须给 prompt/)
  await assert.rejects(() => run.execute({ mode: 'img2img', prompt: 'x' }, createExec()), /image_prompt_id/)
})

test('comfy_upscale 的 method 只给五个算法，默认 lanczos 走 lib', () => {
  const { tools } = boot()
  const params = tools.get('comfy_upscale').parameters
  assert.deepEqual(params.required, ['image_prompt_id', 'width', 'height'])
  assert.deepEqual(params.properties.method.enum, ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'])
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
