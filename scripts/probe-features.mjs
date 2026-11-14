/**
 * probe-features.mjs —— 用真实 ComfyUI 验 img2img / LoRA / upscale 三条链路
 * ============================================================================
 * 这三条在插件里被设置页开关挡着（默认关）。这里直接以「开关全开」的 config
 * 调一次 apply()，绕开 UI 验证逻辑本身：工作流构造、上传底图、LoRA 节点、
 * ImageScale 放大是否都真的能出图。
 *
 * 环境：
 *   COMFY_URL     ComfyUI 地址，默认 http://127.0.0.1:8188
 *   COMFY_LORA    要挂的 LoRA 文件名（相对 loras 目录）。没设就跳过 LoRA 段
 *                 —— 每台机器的 LoRA 文件名都不一样，不该写死在仓库里。
 *
 * 会真出 4~5 张 512×512 小图，8 GiB 卡大约 5 分钟。
 * ============================================================================
 */
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
        async saveImage({ data, mediaType, name: fileName, width, height }) {
          return { attachmentId: `att_${fileName}`, mediaType, bytes: data.length, width, height, name: fileName }
        },
      }
    }
    if (name === 'llm') {
      // 让 imageCapable() 判定为「能看图」，这样 comfy_result 才会把图塞进 images
      return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
    }
    return undefined
  },
  effect: (fn) => { fn(); return () => {} },
}

const baseUrl = comfyUrl()
console.log(`· ComfyUI ${baseUrl}`)

const plugin = await import('../index.js')
plugin.apply(fakeCtx, {
  baseUrl,
  img2img: { enabled: true },
  // 绘图控件里的 LoRA 开关（对话栏那个），不是设置页开关
  draw: { unet: '', lora: true },
  upscale: { enabled: true },
  review: { enabled: false },
})

const agent = { options: { provider: 'probe', model: 'probe-vision' }, session: { requestHeader: () => ({ config: {} }) } }
const makeExec = () => ({ signal: AbortSignal.timeout(900_000), agent })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const run = registered.get('comfy_run')
const result = registered.get('comfy_result')

/* ── 1. 先出一张底图（template） ─────────────────────────────────────── */
console.log('\n=== 底图（template）===')
const base = await run.execute({
  mode: 'template',
  prompt: 'a calm mountain lake at dawn, soft pastel sky, detailed landscape painting',
  width: 512, height: 512, steps: 4, seed: 20261107,
  title: '功能验证底图',
}, makeExec())
const baseId = /prompt_id:\s*([0-9a-f-]+)/.exec(base.text)?.[1]
check('template 提交', Boolean(baseId), baseId ?? base.text.slice(0, 80))
const baseGot = await result.execute({ prompt_id: baseId, wait_seconds: 180 }, makeExec())
check('template 出图', baseGot.images?.length > 0, baseGot.images?.[0]?.filename ?? '')

/* ── 2. img2img：基于底图重绘 ────────────────────────────────────────── */
console.log('\n=== 图生图（img2img）===')
try {
  const img = await run.execute({
    mode: 'img2img',
    image_prompt_id: baseId,
    prompt: 'the same mountain lake but at golden sunset, warm orange sky',
    denoise: 0.55,
    steps: 6,
    title: '功能验证 img2img',
  }, makeExec())
  const imgId = /prompt_id:\s*([0-9a-f-]+)/.exec(img.text)?.[1]
  check('img2img 提交', Boolean(imgId), imgId ?? img.text.slice(0, 120))
  if (imgId) {
    const got = await result.execute({ prompt_id: imgId, wait_seconds: 240 }, makeExec())
    check('img2img 出图', got.images?.length > 0, got.images?.[0]?.filename ?? '')
  }
} catch (error) {
  check('img2img', false, String(error?.message ?? error))
}

/* ── 3. LoRA：挂一个角色 LoRA ─────────────────────────────────────────── */
console.log('\n=== LoRA ===')
const loraName = process.env.COMFY_LORA
if (!loraName) {
  console.log('· 跳过 LoRA：没设 COMFY_LORA=<loras 目录里的文件名>')
} else {
  try {
    const lora = await run.execute({
      mode: 'template',
      prompt: 'anime girl portrait, soft light, detailed face',
      lora: loraName,
      lora_strength: 0.7,
      width: 512, height: 512, steps: 6, seed: 424242,
      title: '功能验证 LoRA',
    }, makeExec())
    const loraId = /prompt_id:\s*([0-9a-f-]+)/.exec(lora.text)?.[1]
    check('LoRA 提交', Boolean(loraId), lora.text.match(/Lora[^\n]*/)?.[0] ?? '')
    if (loraId) {
      const got = await result.execute({ prompt_id: loraId, wait_seconds: 240 }, makeExec())
      check('LoRA 出图', got.images?.length > 0, got.images?.[0]?.filename ?? '')
    }
  } catch (error) {
    check('LoRA', false, String(error?.message ?? error))
  }
}

/* ── 4. upscale：算法放大 ────────────────────────────────────────────── */
console.log('\n=== 放大（upscale）===')
try {
  const up = await registered.get('comfy_upscale').execute({
    image_prompt_id: baseId, width: 1024, height: 1024, method: 'lanczos',
  }, makeExec())
  check('upscale', Boolean(up.images?.length), up.text?.split('\n')[0] ?? '')
} catch (error) {
  check('upscale', false, String(error?.message ?? error))
}

/* ── 5. 开关真的会挡：关掉 img2img 再试一次 ──────────────────────────── */
console.log('\n=== 开关校验（关掉 img2img 应被拒）===')
{
  const registered2 = new Map()
  const ctx2 = {
    tools: { register: (d) => { registered2.set(d.name, d); return () => {} }, get: (n) => registered2.get(n) },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 3000 },
    get: (n) => (n === 'attachments' ? { saveImage: async () => ({}) } : undefined),
    effect: (fn) => { fn(); return () => {} },
  }
  const mod = await import(`../index.js?off=${Date.now()}`)
  mod.apply(ctx2, { baseUrl })
  let blocked = false
  try {
    await registered2.get('comfy_run').execute({ mode: 'img2img', image_prompt_id: baseId, prompt: 'x' }, makeExec())
  } catch (error) {
    blocked = /没开启|开启/.test(String(error?.message ?? ''))
    if (blocked) check('默认关闭时 img2img 被拒', true, String(error.message).slice(0, 40))
    else check('默认关闭时 img2img 被拒', false, String(error?.message ?? error))
  }
  if (!blocked) check('默认关闭时 img2img 被拒', false, '没报错，可能开关没生效')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✓ 全部通过' : `✗ ${failed.length} 项失败`}`)
process.exitCode = failed.length === 0 ? 0 : 1
