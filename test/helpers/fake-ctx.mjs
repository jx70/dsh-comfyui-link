/**
 * fake-ctx.mjs —— 测试用的假宿主上下文
 * ============================================================================
 * 把 `apply(ctx, config)` 需要的服务都做成最小可用的假货：
 *   tools.register / tools.get     收注册，按名字取
 *   systemPrompt.section           收集 section 规格
 *   get('attachments' | 'llm')     图片附件与模型信息
 *   effect(fn)                     立即执行（真宿主是等 scope 就绪再执行）
 *   connection.fetch.register      收只读路由
 *
 * 用法：
 *   const ctx = createFakeCtx()
 *   plugin.apply(ctx, {})
 *   ctx.tools.get('comfy_run')
 * ============================================================================
 */

export function createFakeCtx() {
  const tools = new Map()
  const sections = []
  const routes = []
  const effects = []

  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`工具名重复：${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (name) => tools.get(name),
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
      // 宿主里 TOOL_COMPUTER_USE = 3000；未知名字会抛错，这里照做
      getSectionOrder(name) {
        const table = { TOOL_COMPUTER_USE: 3000, TOOL_WEB_FETCH: 2100 }
        const order = table[name]
        if (order === undefined) throw new Error(`未知的 section 名：${name}`)
        return order
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    },
    get(name) {
      if (name === 'attachments') return attachmentsMock
      if (name === 'llm') return llmMock
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
  }

  return { ctx, tools, sections, routes, effects }
}

const attachmentsMock = {
  imageLimits: { maxImageBytes: 8 * 1024 * 1024, maxMessageImageBytes: 8 * 1024 * 1024 },
  async saveImage({ data, mediaType, name }) {
    return { attachmentId: `att_${name}`, mediaType, bytes: data.length, width: 512, height: 512, name }
  },
}

const llmMock = {
  // 只有 id 里带 vision 的那个能收图，其余按纯文本算 —— 跟真实 provider 一样按模型区分
  async resolveModelInfo(provider, model) {
    return { inputModalities: String(model).includes('vision') ? ['text', 'image'] : ['text'] }
  },
  async listProviders() {
    return [{ id: 'mock-provider', name: 'Mock Provider' }]
  },
  async listModels(provider) {
    return [
      { provider, id: 'mock-vision-model', name: 'Mock Vision', inputModalities: ['text', 'image'] },
      { provider, id: 'mock-text-model', name: 'Mock Text', inputModalities: ['text'] },
    ]
  },
  async * stream() {
    yield { type: 'text-delta', index: 0, text: '{"satisfied":true,"score":9,"feedback":"ok","new_prompt":""}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

/** 造一个像工具执行上下文那样的 exec 对象（execute 的第二个参数）。 */
export function createExec({ timeoutMs = 30_000 } = {}) {
  return {
    signal: AbortSignal.timeout(timeoutMs),
    agent: {
      options: { provider: 'mock-provider', model: 'mock-vision-model' },
      session: { requestHeader: () => ({ config: {} }) },
    },
  }
}
