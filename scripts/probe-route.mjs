/**
 * probe-route.mjs —— 单独验证「设置页列能看图模型」这条只读路由
 * ============================================================================
 * 用假的 ctx（带 connection.fetch / llm）把 route 抓出来，直接调 route.fetch 跑一遍。
 *
 * 注意：这条路由注册在 DSH 的 /api 信任栅栏内部（ctx.connection.fetch.register），
 * 鉴权由 connection.admit 负责，所以这里只验数据与形状，不验 cookie/同源
 * （那些由宿主统一处理，未登录请求在到达 fetch 之前就被 401 掉了）。
 *
 * 不需要 DSH 在跑，也不读凭据 —— 纯内存。
 * ============================================================================
 */
import { dshBase } from './env.mjs'

const captured = []

const llmMock = {
  listProviders: () => [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'google-antigravity', name: 'Antigravity' },
    { id: 'textonly', name: 'Text Only' },
  ],
  listModels: async (provider) => {
    if (provider === 'deepseek-official') {
      return [
        { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { provider, id: 'deepseek-vl-1', name: 'DeepSeek VL' },
      ]
    }
    if (provider === 'google-antigravity') {
      return [{ provider, id: 'gemini-3-pro', name: 'Gemini 3 Pro' }]
    }
    if (provider === 'textonly') {
      return [{ provider, id: 'plain-text', name: 'Plain Text' }]
    }
    throw new Error('boom')
  },
  resolveModelInfo: async (provider, model) => {
    const image = model === 'deepseek-vl-1' || model === 'gemini-3-pro'
    return { inputModalities: image ? ['text', 'image'] : ['text'] }
  },
}

const fakeCtx = {
  get(name) {
    if (name === 'llm') return llmMock
    return undefined
  },
  connection: {
    fetch: {
      register(route) {
        captured.push(route)
        return () => {}
      },
    },
  },
  tools: {
    register() {},
    get() {
      return { name: 'comfy_run' }
    },
  },
  systemPrompt: {
    section() {},
    getSectionOrder: () => 3000,
  },
  effect(fn) {
    const out = fn()
    return () => { if (typeof out === 'function') out() }
  },
  logger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  },
}

// 没有 ctx.inject ⇒ 走「ctx.connection 已在」那一支
const plugin = await import('../index.js')
plugin.apply(fakeCtx, {})

const route = captured.find((r) => r.path === '/api/comfyui/vision-models')
if (!route) {
  console.error('✗ 路由没注册上')
  process.exit(1)
}
console.log(`✓ 路由已注册 path=${route.path} methods=${JSON.stringify(route.methods)} body=${route.requestBody}`)

const request = new Request(`${dshBase()}/api/comfyui/vision-models`, { method: 'GET' })

;(async () => {
  // ① 正常 GET
  const res = await route.fetch(request)
  const body = await res.json()
  console.log(`GET → ${res.status} ok=${body.ok} cache=${res.headers.get('cache-control')}`)
  const providers = body.providers ?? []
  console.log(`  分组：${providers.map((p) => `${p.id}(${p.models.length})`).join(', ') || '（空）'}`)
  for (const p of providers) {
    for (const m of p.models) console.log(`    ${p.id} / ${m.id} — ${m.name}`)
  }
  const ids = providers.flatMap((p) => p.models.map((m) => m.id)).sort()
  const expected = ['deepseek-vl-1', 'gemini-3-pro']
  const filtered = JSON.stringify(ids) === JSON.stringify(expected)
  console.log(filtered ? '✓ 只筛出能看图的模型' : `✗ 模型筛选不对：${JSON.stringify(ids)}`)
  console.log(providers.every((p) => p.id !== 'textonly') ? '✓ textonly 服务商被正确剔除' : '✗ textonly 没被剔除')

  // ② 没有 llm 服务时的退化
  const saved = llmMock.listProviders
  llmMock.listProviders = () => {
    throw new Error('llm 挂了')
  }
  const bad = await route.fetch(request)
  const badBody = await bad.json()
  console.log(`llm 抛错 → ${bad.status} ok=${badBody.ok} error=${badBody.error}`)
  llmMock.listProviders = saved

  const allPass = filtered && res.status === 200 && body.ok === true
    && bad.status === 500 && badBody.ok === false
    && providers.every((p) => p.id !== 'textonly')
  console.log(allPass ? '\n全部通过' : '\n有失败项')
  process.exit(allPass ? 0 : 1)
})()
