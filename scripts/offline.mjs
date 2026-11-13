/**
 * offline.mjs —— 不装进 DSH、也不联网的情况下把插件「跑一遍」
 * ============================================================================
 * 它做三件事：
 *   1. 用假的 ctx 调 apply()，看注册的工具有没有问题
 *   2. 拿宿主真实的 assertSupportedJsonSchema 校验每个工具的 output.schema
 *      （宿主 ctx.tools.register 就是这么校验的，这里提前拦下来）
 *   3. 渲染每个工具的 render()，确认它能吐合法 ContentBlock
 *
 * 用法：node scripts/offline.mjs [--live]
 *   --live  额外真打一遍只读工具（需要 ComfyUI 在跑）
 * ============================================================================
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { comfyUrl, hostModulesDir } from './env.mjs'

let assertSupportedJsonSchema = null
const hostModules = hostModulesDir()
const toolsEntry = hostModules ? join(hostModules, 'dsh-tools', 'lib', 'index.js') : null
if (toolsEntry && existsSync(toolsEntry)) {
  try {
    const mod = await import(pathToFileURL(toolsEntry).href)
    assertSupportedJsonSchema = mod.assertSupportedJsonSchema
    console.log('· 拿到宿主的 assertSupportedJsonSchema')
  } catch (error) {
    console.log(`· 宿主模块读不到（${error?.code ?? error?.message}），跳过真实校验`)
  }
} else {
  console.log('· 没找到宿主包目录，跳过真实校验')
  console.log('  设 DSH_HOST_MODULES=<.../node_modules/@deepseek-ai> 可开启')
}

const registered = new Map()
const sections = []

const fakeCtx = {
  tools: {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`工具名重复：${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    get(name) {
      return registered.get(name)
    },
  },
  systemPrompt: {
    section(spec) {
      sections.push(spec)
      return () => {}
    },
    getSectionOrder(name) {
      const table = { TOOL_COMPUTER_USE: 3000, TOOL_WEB_FETCH: 2100 }
      const order = table[name]
      if (order === undefined) throw new Error(`未知的 section 名：${name}`)
      return order
    },
  },
  get(name) {
    if (name === 'attachments') {
      return {
        imageLimits: { maxImageBytes: 8 * 1024 * 1024, maxMessageImageBytes: 8 * 1024 * 1024 },
        async saveImage({ data, mediaType, name: fileName }) {
          return { attachmentId: `att_${fileName}`, mediaType, bytes: data.length, width: 512, height: 512, name: fileName }
        },
      }
    }
    if (name === 'llm') {
      return {
        async resolveModelInfo() {
          return { inputModalities: ['text', 'image'] }
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
    }
    return undefined
  },
  effect(fn) {
    const disposer = fn()
    return () => disposer?.()
  },
}

const plugin = await import('../index.js')
console.log(`· 插件 name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`)

plugin.apply(fakeCtx, {})

console.log(`· 注册了 ${registered.size} 个工具：${[...registered.keys()].join(', ')}`)

const ALLOWED_KEYS = [
  'name', 'description', 'parameters', 'output', 'execute', 'isConcurrencySafe',
  'timeoutMs', 'presentCall', 'presentResult', 'projectContent', 'finalizeContent', 'deferLoading',
]

let failures = 0
for (const [toolName, definition] of registered) {
  const problems = []

  if (typeof definition.description !== 'string' || definition.description.length === 0) {
    problems.push('缺 description')
  }
  if (typeof definition.execute !== 'function') problems.push('缺 execute')
  if (!definition.output || typeof definition.output.render !== 'function') {
    problems.push('output.render 不是函数（宿主会抛 TypeError）')
  }
  if (!definition.parameters || definition.parameters.type !== 'object') {
    problems.push('parameters 不是 object')
  }
  for (const key of Object.keys(definition)) {
    if (!ALLOWED_KEYS.includes(key)) problems.push(`多了不认识的字段 ${key}`)
  }

  if (assertSupportedJsonSchema) {
    try {
      assertSupportedJsonSchema(definition.output.schema)
    } catch (error) {
      problems.push(`output.schema 不合规：${error.message}`)
    }
  }

  // render 冒烟：空值也要能吐出文本块
  try {
    const blocks = definition.output.render({}, { text: 'hello' })
    if (!Array.isArray(blocks) || blocks.length === 0) problems.push('render 没返回块数组')
    else if (blocks[0]?.type !== 'text') problems.push('render 第一块不是 text')
  } catch (error) {
    problems.push(`render 抛错：${error.message}`)
  }

  // render 带图
  try {
    const blocks = definition.output.render({}, {
      text: 'x',
      images: [{ attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }],
    })
    if (blocks.length !== 2 || blocks[1]?.type !== 'image') problems.push('render 没把图片块吐出来')
  } catch (error) {
    problems.push(`render(带图) 抛错：${error.message}`)
  }

  if (problems.length === 0) {
    console.log(`  ✓ ${toolName}`)
  } else {
    failures += 1
    console.log(`  ✗ ${toolName}`)
    for (const problem of problems) console.log(`      - ${problem}`)
  }
}

console.log(`· systemPrompt 段：${sections.map((section) => `${section.name}@${section.order}`).join(', ') || '无'}`)
for (const section of sections) {
  const text = typeof section.text === 'function' ? section.text({ scope: undefined }) : section.text
  console.log(`  渲染结果 ${text.length} 字符：${text.split('\n')[0] || '（空）'}`)
}

// 真实跑一遍只读工具
if (process.argv.includes('--live')) {
  console.log(`\n· 真实调用只读工具（${comfyUrl()}）`)
  const exec = {
    signal: AbortSignal.timeout(30_000),
    agent: { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => ({ config: {} }) } },
  }
  for (const toolName of ['comfy_status', 'comfy_models']) {
    const definition = registered.get(toolName)
    try {
      const value = await definition.execute({}, exec)
      const text = String(value?.text ?? '')
      console.log(`  ✓ ${toolName}（${text.length} 字符）`)
      console.log(text.split('\n').slice(0, 6).map((line) => `      ${line}`).join('\n'))
    } catch (error) {
      failures += 1
      console.log(`  ✗ ${toolName}: ${error.message}`)
    }
  }
  const node = registered.get('comfy_node')
  try {
    const value = await node.execute({ node_class: 'KSampler' }, exec)
    console.log(`  ✓ comfy_node（${String(value.text).length} 字符）`)
    console.log(String(value.text).split('\n').slice(0, 8).map((line) => `      ${line}`).join('\n'))
  } catch (error) {
    failures += 1
    console.log(`  ✗ comfy_node: ${error.message}`)
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 个问题`)
process.exitCode = failures === 0 ? 0 : 1
