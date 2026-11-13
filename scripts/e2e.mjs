/**
 * e2e.mjs —— 真的出一张图，把 comfy_run → comfy_result 全链路跑通
 * ============================================================================
 *   node scripts/e2e.mjs
 *
 * 参数故意设得很小（512×512、4 步），只为验证链路，不追求画质。
 * 需要 ComfyUI 在跑（COMFY_URL，默认 http://127.0.0.1:8188），且服务端装了
 * 至少一组 diffusion_models / text_encoders / vae。
 * ============================================================================
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comfyUrl } from './env.mjs'

const registered = new Map()
const fakeCtx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => {}
    },
    get: (name) => registered.get(name),
  },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 3000 },
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
        resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
        listProviders: async () => [{ id: 'mock-provider', name: 'Mock' }],
        listModels: async (provider) => [
          { provider, id: 'mock-vision', name: 'Mock Vision', inputModalities: ['text', 'image'] },
        ],
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: '{"satisfied":true,"score":9,"feedback":"ok","new_prompt":""}' }
        },
      }
    }
    return undefined
  },
  effect: (fn) => {
    fn()
    return () => {}
  },
}

const plugin = await import('../index.js')
plugin.apply(fakeCtx, {})

const agent = { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => ({ config: {} }) } }
const makeExec = () => ({ signal: AbortSignal.timeout(600_000), agent })

const outDir = await mkdtemp(join(tmpdir(), 'comfy-e2e-'))
console.log(`· ComfyUI ${comfyUrl()}`)
console.log(`· 另存目录 ${outDir}`)

// 1) 提交
const run = registered.get('comfy_run')
const submitted = await run.execute({
  mode: 'template',
  prompt: 'a tiny teal cube floating above a dark desk, soft studio light, product photo',
  width: 512,
  height: 512,
  steps: 4,
  batch: 1,
  seed: 1234567,
  title: '插件端到端测试',
}, makeExec())
console.log('\n[comfy_run]')
console.log(submitted.text)

const promptId = /prompt_id:\s*([0-9a-f-]+)/.exec(submitted.text)?.[1]
if (!promptId) {
  console.error('\n✗ 没从输出里解析到 prompt_id')
  process.exit(1)
}

// 2) 等结果
const result = registered.get('comfy_result')
const got = await result.execute({ prompt_id: promptId, wait_seconds: 240, save_to: outDir }, makeExec())
console.log('\n[comfy_result]')
console.log(got.text)

// 3) 校验 render 能吐图片块
const blocks = result.output.render({}, got)
console.log(`\n[render] ${blocks.length} 个块：${blocks.map((b) => b.type).join(', ')}`)

// 4) 校验另存真的落盘了
let files = []
try {
  files = await readdir(outDir)
} catch {
  files = []
}
console.log(`[磁盘] ${files.length} 个文件：${files.join(', ')}`)

const imageBlocks = blocks.filter((b) => b.type === 'image')
const ok = imageBlocks.length > 0 && files.length > 0
console.log(ok ? '\n✓ 端到端通过' : '\n✗ 端到端失败：没拿到图块或没落盘')

await rm(outDir, { recursive: true, force: true })
process.exitCode = ok ? 0 : 1
