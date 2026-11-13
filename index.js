/**
 * index.js —— ComfyUI 控制插件（Host 侧）
 * ============================================================================
 * 装好之后模型会多出 6 个工具：
 *   comfy_status   服务 / 显存 / 队列 / 任务状态
 *   comfy_models   有哪些模型文件可用
 *   comfy_node     某个节点类接受哪些输入（搭自定义工作流时查）
 *   comfy_run      提交任务（内置文生图模板，或直接给它一份 API 格式的工作流）
 *   comfy_result   等任务跑完，取回输出图（图真的会交给模型看）
 *   comfy_control  取消 / 中断 / 清队列 / 放显存
 *
 * 这里**不 import 任何 @deepseek-ai/* 包**：工具定义直接用标准 JSON Schema 写。
 * ctx.tools.register 只校验 output.schema 和名字，不要求 defineTool 那层包装，
 * 所以插件在任何 profile 里都能加载，不会因为宿主树解析不到依赖而整个挂掉。
 * ============================================================================
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  ComfyError,
  MODEL_FOLDERS,
  buildImg2Img,
  buildTxt2Img,
  buildUpscale,
  collectImages,
  createClient,
  humanDuration,
  injectPrompt,
  normalizeGraph,
  resolveModels,
  sleep,
  summarizeGraph,
} from './lib/comfy.mjs'

export const name = 'comfyui'
export const inject = ['tools', 'systemPrompt']

/**
 * 配置 schema（schemastery）。设置页会据此自动生成可编辑表单：
 * 只有标了 `.volatile()` 的字段（或其父对象）会出现在表单里，改完热生效。
 * baseUrl 之类的静态字段留在 cordis.patch.yml 里配。
 */
export const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8188').description('ComfyUI 服务地址'),
  review: z.object({
    enabled: z.boolean().default(false).description('开启「生图后审图、不满自动重画」'),
    provider: z.string().default('').description('审图模型 provider；留空回退当前会话模型'),
    model: z.string().default('').description('审图模型 id；留空回退当前会话模型'),
    maxAttempts: z.number().step(1).min(1).max(5).default(1).description('最多重生成几次（1–5）'),
    extra: z.string().default('').description('额外审图要求，如「角色必须还原银色长发」'),
  }).volatile(),
  img2img: z.object({ enabled: z.boolean().default(false).description('开启图生图（comfy_run mode="img2img"）') }).volatile(),
  lora: z.object({ enabled: z.boolean().default(false).description('开启 LoRA（comfy_run 的 lora 参数）') }).volatile(),
  upscale: z.object({ enabled: z.boolean().default(false).description('开启算法放大（comfy_upscale）') }).volatile(),
})

/** 默认配置；用户可以在 profile 的 patch 层覆盖（升级不丢） */
export const DEFAULTS = {
  /** ComfyUI 服务地址 */
  baseUrl: 'http://127.0.0.1:8188',
  /** 单次 HTTP 请求超时（毫秒）。出图本身不受这个限制 */
  timeoutMs: 20000,
  /** comfy_result 轮询间隔（毫秒） */
  pollMs: 2500,
  /** comfy_result 单次最多等多久（秒） */
  maxWaitSeconds: 900,
  /** ComfyUI 的 output 目录；给了就能把图报成绝对路径。留空则只报文件名 */
  outputRoot: '',
}

const DEFAULT_NEGATIVE =
  'lowres, worst quality, low quality, jpeg artifacts, blurry, text, watermark, signature, '
  + 'bad anatomy, bad hands, extra fingers, missing limbs, deformed, ugly, nsfw'

// ── 输出与 schema 的小工具 ────────────────────────────────────────────────

/**
 * 工具输出形状。execute 返回 { text, images? }：
 *   text   —— 一行行给人看的说明
 *   images —— 要在回答里展示的图片引用（attachments 服务的 ImageAttachmentRef）
 * render 把 text 变成第一个文本块，再把每张图变成图片块。
 * （图片块只能由 render 产出，不能在 execute 里直接返回，这是这套框架的规矩。）
 */
function output() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const parts = [{ type: 'text', text: String(value?.text ?? '') }]
      const images = Array.isArray(value?.images) ? value.images : []
      for (const ref of images) {
        if (ref && typeof ref === 'object' && typeof ref.attachmentId === 'string') {
          parts.push({ type: 'image', attachment: ref })
        }
      }
      return parts
    },
  }
}

/** 参数对象：不写 additionalProperties，等于「允许多余字段」，最不容易被各家 API 挑刺 */
function params(properties, required) {
  const schema = { type: 'object', properties: properties ?? {} }
  if (required && required.length > 0) schema.required = required
  return schema
}

const s = (description) => ({ type: 'string', description })
const n = (description) => ({ type: 'number', description })
const i = (description) => ({ type: 'integer', description })

/** 把错误翻译成模型能照着改的说法 */
function explain(error) {
  if (error instanceof ComfyError) {
    const tail = error.detail ? `\n细节：${JSON.stringify(error.detail).slice(0, 2000)}` : ''
    return `${error.message}${tail}`
  }
  return error?.message ?? String(error)
}

/** 根据文件头判断图片类型 */
function sniffMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  return undefined
}

/** 这次对话的当前模型能不能收图（照 dsh-tool-fs 的判定方式） */
async function imageCapable(ctx, exec) {
  const attachments = ctx.get('attachments')
  if (!attachments) return { ok: false, reason: '没有 attachments 服务' }
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    return { ok: false, reason: '当前模型路由解析不到' }
  }
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    const modalities = info?.inputModalities
    if (!Array.isArray(modalities) || !modalities.includes('image')) {
      return { ok: false, reason: `当前模型 ${model} 不接受图片输入` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `模型信息读取失败：${error?.message ?? error}` }
  }
}

/**
 * 解包 volatile 引用：schemastery 的 .volatile() 字段在 apply() 里是
 * cosmokit 的引用对象，得 .get() 才能拿到当前值（这样设置页热编辑才即时生效）。
 * 非 volatile 的普通值原样返回。
 */
function unwrapVolatile(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/**
 * 读取当前功能开关（每次都现读 volatile 引用，热编辑即时生效）。
 * 默认：review/img2img/lora/upscale 全关闭。
 * @returns {{review:{enabled,provider,model,maxAttempts,extra}, img2img:boolean, lora:boolean, upscale:boolean}}
 */
function readFeatureConfig(config) {
  const review = unwrapVolatile(config?.review) ?? {}
  return {
    review: {
      enabled: review.enabled === true,
      provider: typeof review.provider === 'string' ? review.provider : '',
      model: typeof review.model === 'string' ? review.model : '',
      maxAttempts: Number.isInteger(review.maxAttempts) ? review.maxAttempts : 1,
      extra: typeof review.extra === 'string' ? review.extra : '',
    },
    img2img: (unwrapVolatile(config?.img2img) ?? {}).enabled === true,
    lora: (unwrapVolatile(config?.lora) ?? {}).enabled === true,
    upscale: (unwrapVolatile(config?.upscale) ?? {}).enabled === true,
  }
}

/**
 * 拿到当前对话的模型路由（provider + model），供审图回退用。
 * 与 imageCapable 取路由的方式一致。
 */
function currentRoute(exec) {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  return { provider, model }
}

/** 输出图在磁盘上的位置（ComfyUI 已经把 SaveImage 写过去了） */
function onDiskPath(image, outputRoot) {
  if (!outputRoot) return null
  const root = String(outputRoot).replace(/[\\/]+$/, '')
  const parent = root.slice(0, Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\')))
  const base = image.type === 'temp' ? (parent ? join(parent, 'temp') : 'temp') : root
  return [base, image.subfolder, image.filename].filter((p) => p && p.length > 0).join(sep)
}

/**
 * 从 /system_stats 的 argv 里认出 ComfyUI 装在哪，从而推出 output 目录。
 * argv[0] 就是 main.py 的绝对路径（启动参数里那一串也一并给了）。
 * 认不出来就返回空串，调用方退回「只报文件名」。
 */
function deriveOutputRoot(stats) {
  const argv = stats?.system?.argv
  if (!Array.isArray(argv)) return ''
  const mainPy = argv.find((a) => typeof a === 'string' && /[\\/]main\.py$/i.test(a))
  if (!mainPy) return ''
  const dir = mainPy.slice(0, Math.max(mainPy.lastIndexOf('/'), mainPy.lastIndexOf('\\')))
  return dir ? join(dir, 'output') : ''
}

const FINISHED = new Set(['completed', 'failed', 'cancelled'])

// ── 设置页用的只读路由 ────────────────────────────────────────────────────
// 浏览器半端拿不到宿主服务（client 侧没有 llm），所以「列出能看图的模型」得由
// 宿主开一条路由给它取。这里只暴露只读的模型清单，不碰任何写操作。
//
// 注册方式必须是 ctx.connection.fetch.register：DSH 把整个 /api 前缀挂在
// connection 的信任栅栏后面，而栅栏里的 admit() 要求请求带浏览器 cookie
// （或 API token），否则一律 401。fetch 路由正好注册在栅栏内部，由
// createSharedFetchHandler 按 pathname 精确分发、要求 principal 是 owner——
// 也就是「浏览器带 cookie 打开这个页面」的那种请求。用 webServer.register
// 自己挂 /api/... 会被外层前缀路由先吃掉，永远走不到。

/** 路由路径：GET /api/comfyui/vision-models */
const VISION_ROUTE = '/api/comfyui/vision-models'

/** 统一的 JSON 响应（禁缓存：模型清单会随 provider 变化）。 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * 列出所有能看图的模型，按 provider 分组。
 * @returns {Promise<Array<{id: string, name: string, models: Array<{id,name,description}>}>>}
 */
async function collectVisionModels(service, signal) {
  const providers = await service.listProviders()
  const out = []
  for (const p of providers ?? []) {
    let models
    try {
      models = await service.listModels(p.id)
    } catch {
      continue
    }
    const keep = []
    for (const m of models ?? []) {
      let info
      try {
        info = await service.resolveModelInfo(m.provider ?? p.id, m.id, signal)
      } catch {
        info = m
      }
      const modalities = info?.inputModalities ?? m.inputModalities
      if (!Array.isArray(modalities) || !modalities.includes('image')) continue
      keep.push({
        id: m.id,
        name: m.name ?? m.id,
        description: m.description ?? '',
      })
    }
    if (keep.length > 0) out.push({ id: p.id, name: p.name ?? p.id, models: keep })
  }
  return out
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  const client = createClient({ baseUrl: settings.baseUrl, timeoutMs: settings.timeoutMs })

  // 保存一份最近一次用过的客户端配置，方便 comfy_status 报地址
  const where = () => client.baseUrl

  // outputRoot 没配就自己从 /system_stats 的 argv 认一次，认出来后缓存住
  let derivedRoot = null
  async function resolvedOutputRoot(signal) {
    if (settings.outputRoot) return settings.outputRoot
    if (derivedRoot === null) {
      try {
        derivedRoot = deriveOutputRoot(await client.systemStats({ signal }))
      } catch {
        derivedRoot = '' // 认不出来就算了，下次再试
      }
    }
    return derivedRoot
  }

  // ── 审图核心：取图 / 定模型 / 问模型 / 提交并等结果 ─────────────────────

  const attachments = () => ctx.get('attachments')
  const llm = () => ctx.get('llm')

  /** 从某个 prompt_id 的历史里把第一张输出图取回来，存成附件引用 */
  async function fetchImageRef(promptId, signal) {
    const att = attachments()
    if (!att) throw new Error('没有 attachments 服务，取不到图')
    let entry = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      entry = await client.historyEntry(promptId, { signal })
      if (entry) break
      await sleep(500, signal)
    }
    if (!entry) throw new Error(`任务 ${promptId} 的历史里没有输出，等几秒再试`)
    const images = collectImages(entry)
    if (images.length === 0) throw new Error(`任务 ${promptId} 没有产出图片`)
    const image = images[0]
    const bytes = await client.view(image, { signal })
    const mediaType = sniffMediaType(bytes)
    if (!mediaType) throw new Error(`任务 ${promptId} 的第一张输出不是认识的图片格式`)
    const ref = await att.saveImage({ data: bytes, mediaType, name: image.filename })
    return { ref, image, bytes, mediaType }
  }

  /** 把一张图片上传到 ComfyUI input 目录，返回 LoadImage 用的文件名 */
  async function uploadImage(bytes, hint) {
    const safe = (hint || 'img2img.png').replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'input.png'
    const uploaded = await client.uploadImage(bytes, { filename: safe, overwrite: true })
    return uploaded?.name ?? safe
  }

  /**
   * 定审图模型：显式指定 provider/model 就用它；留空回退当前会话模型。
   * 校验目标模型能看图（inputModalities 含 image）。
   * @returns {Promise<{provider: string, model: string}>}
   */
  async function resolveReviewer(exec, review) {
    const service = llm()
    if (!service) throw new Error('没有 llm 服务，审图用不了')
    let provider = review.provider
    let model = review.model
    if (!provider || !model) {
      const routed = currentRoute(exec)
      provider = routed.provider
      model = routed.model
      if (provider === undefined || model === undefined) {
        throw new Error('审图模型没指定，且当前会话路由也解析不到。请在设置页填审图 provider/model。')
      }
    }
    try {
      const info = await service.resolveModelInfo(provider, model, exec.signal)
      const modalities = info?.inputModalities
      if (!Array.isArray(modalities) || !modalities.includes('image')) {
        throw new Error(`审图模型 ${model}（${provider}）不接受图片输入，审不了图。请在设置页换一个能看图的模型。`)
      }
    } catch (error) {
      if (error?.message?.includes('不接受图片输入')) throw error
      throw new Error(`审图模型信息读取失败：${error?.message ?? error}`)
    }
    return { provider, model }
  }

  /**
   * 让审图模型看一张图，判断是否满足要求。
   * 给了 referenceRef 时，同时把参考图交给它，让它对照判断「角色/形象是否还原」。
   * @returns {Promise<{satisfied: boolean, score: number, feedback: string, newPrompt: string, raw: string}>}
   */
  async function askReviewer(exec, { provider, model, imageRef, referenceRef, requirement, extra }) {
    const service = llm()
    const system =
      '你是一个严格的图像审阅员。看图，对照用户的要求，判断这张图是否达标（满意/角色是否还原/要求是否满足）。'
      + (referenceRef
        ? '消息里有两张图：第一张是这次生成的结果，第二张是角色参考图。请重点比对第一张是否还原了参考图里的角色（发型、发色、瞳色、服饰、配色、气质等）。参考图里多余的东西不算要求。'
        : '')
      + '只输出一个 JSON 对象，不要输出任何别的文字，字段如下：'
      + '{"satisfied": true 或 false, "score": 0 到 10 的整数, "feedback": "一句话说清楚哪里不行（满意就给简短好评）", "new_prompt": "不满意时给出用于重画的、更具体完整的英文正向提示词；满意时给空字符串"}'
    const text = `用户要求：${requirement}${extra ? `\n额外要求：${extra}` : ''}`
    const content = [
      { type: 'text', text },
      { type: 'image', attachment: imageRef },
    ]
    if (referenceRef) {
      content.push({ type: 'text', text: '下面是角色参考图（角色应当还原成这个样子）：' })
      content.push({ type: 'image', attachment: referenceRef })
    }
    const messages = [{ role: 'user', content }]

    let collected = ''
    try {
      for await (const chunk of service.stream({
        provider,
        model,
        system,
        messages,
        signal: exec.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          collected += chunk.text
        }
      }
    } catch (error) {
      throw new Error(`审图模型调用失败：${error?.message ?? error}`)
    }

    const raw = collected.trim()
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    let parsed = null
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object') {
      return {
        satisfied: parsed.satisfied === true,
        score: Number.isFinite(parsed.score) ? parsed.score : 0,
        feedback: String(parsed.feedback ?? ''),
        newPrompt: String(parsed.new_prompt ?? ''),
        raw,
      }
    }
    // 降级：审图模型没吐 JSON，就按「不满意 + 文本反馈」处理
    return {
      satisfied: false,
      score: 0,
      feedback: raw || '（审图模型未给出结构化反馈）',
      newPrompt: '',
      raw,
    }
  }

  /**
   * 提交一张图并等到它跑完，取回第一张输出图的附件引用。
   * @returns {Promise<{promptId: string, ref: any, filename: string}>}
   */
  async function submitAndFetch(graph, signal, deadlineMs = 0) {
    const submitted = await client.submit(graph, { signal })
    if (!submitted.ok) {
      const detail = submitted.nodeErrors
        ? `\n节点报错：${JSON.stringify(submitted.nodeErrors).slice(0, 2000)}`
        : ''
      throw new Error(`ComfyUI 拒了这张工作流：${submitted.error}${detail}`)
    }
    const promptId = submitted.promptId
    const deadline = deadlineMs > 0 ? deadlineMs : Date.now() + settings.maxWaitSeconds * 1000
    let job = await client.job(promptId, { signal })
    while (job && !FINISHED.has(job.status) && Date.now() < deadline) {
      await sleep(Math.min(settings.pollMs, Math.max(250, deadline - Date.now())), signal)
      job = (await client.job(promptId, { signal })) ?? job
    }
    if (job?.status === 'failed') {
      throw new Error(`重生成任务 ${promptId} 失败了（可能是显存不够，用 comfy_status 看）`)
    }
    const { ref, image } = await fetchImageRef(promptId, signal)
    return { promptId, ref, filename: image.filename }
  }

  // ── 1. comfy_status ────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_status',
    description:
      '看本地 ComfyUI 活着没、显存还剩多少、队列里有什么、最近几个任务跑到哪了。'
      + '不传 prompt_id 给整体快照；传了就只盯那一个任务。',
    parameters: params({
      prompt_id: s('只查这一个任务（就是提交时返回的 prompt_id）。省略则看整体'),
      recent: i('顺带列最近几条任务，默认 5，最多 20'),
    }),
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = exec.signal
      let stats
      try {
        stats = await client.systemStats({ signal })
      } catch (error) {
        if (error instanceof ComfyError && error.code === 'OFFLINE') {
          return { text: `ComfyUI 没在跑（${where()}）。\n${explain(error)}\n先把 ComfyUI 启动起来再试。` }
        }
        throw new Error(explain(error))
      }

      const system = stats?.system ?? {}
      const dev = stats?.devices?.[0]
      const gib = (v) => (typeof v === 'number' ? (v / 2 ** 30).toFixed(1) : '?')
      const lines = [
        `ComfyUI ${system.comfyui_version ?? '?'} · Python ${String(system.python_version ?? '?').split(' ')[0]} · ${where()}`,
      ]
      if (dev) {
        const used = typeof dev.vram_total === 'number' && typeof dev.vram_free === 'number'
          ? dev.vram_total - dev.vram_free
          : undefined
        lines.push(`GPU ${dev.name ?? '?'}`)
        lines.push(`显存空闲 ${gib(dev.vram_free)} / ${gib(dev.vram_total)} GiB${used !== undefined ? `（已用 ${gib(used)} GiB）` : ''}`)
      }

      if (args.prompt_id) {
        const job = await client.job(args.prompt_id, { signal })
        if (!job) {
          lines.push(`\n任务 ${args.prompt_id} 查不到。它可能已经跑完被清出列表了 —— 用 comfy_result 按 prompt_id 去历史里找。`)
        } else {
          const took = job.execution_end_time && job.execution_start_time
            ? ` · 耗时 ${humanDuration(job.execution_end_time - job.execution_start_time)}`
            : ''
          lines.push(`\n任务 ${job.id}`)
          lines.push(`状态：${job.status}${took} · 输出 ${job.outputs_count ?? 0} 个`)
          if (job.preview_output?.filename) lines.push(`预览：${job.preview_output.filename}`)
          if (!FINISHED.has(job.status)) lines.push('还在跑或排队中；要结果就用 comfy_result。')
        }
        return { text: lines.join('\n') }
      }

      const queue = await client.queue({ signal })
      lines.push(`队列：正在跑 ${queue?.queue_running?.length ?? 0} 个，排队 ${queue?.queue_pending?.length ?? 0} 个`)

      const recent = Math.max(1, Math.min(20, args.recent ?? 5))
      const jobs = await client.jobs({ limit: recent }, { signal })
      if (jobs.length === 0) {
        lines.push('\n最近没有任务记录。')
      } else {
        lines.push('\n最近任务：')
        for (const job of jobs) {
          const took = job.execution_end_time && job.execution_start_time
            ? ` · ${humanDuration(job.execution_end_time - job.execution_start_time)}`
            : ''
          lines.push(`  ${job.id}  ${job.status}${took}  输出 ${job.outputs_count ?? 0}`)
        }
      }
      return { text: lines.join('\n') }
    },
  })

  // ── 2. comfy_models ────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_models',
    description:
      '列出 ComfyUI 里装了哪些模型文件。内置文生图模板会自动用每个文件夹里的第一个；'
      + '要换模型就把这里的文件名传给 comfy_run 的 unet / clip / vae。',
    parameters: params({}),
    output: output(),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      let index
      try {
        index = await client.modelIndex({ signal: exec.signal })
      } catch (error) {
        throw new Error(explain(error))
      }
      const lines = ['可用模型：']
      for (const folder of MODEL_FOLDERS) {
        const list = index[folder] ?? []
        lines.push(`${folder}：${list.length ? `${list.length} 个` : '（空）'}`)
        for (const file of list.slice(0, 40)) lines.push(`  - ${file}`)
        if (list.length > 40) lines.push(`  …还有 ${list.length - 40} 个`)
      }
      const missing = ['diffusion_models', 'text_encoders', 'vae'].filter((f) => (index[f] ?? []).length === 0)
      if (missing.length > 0) {
        lines.push(`注意：${missing.join('、')} 是空的，内置模板跑不了（它要这三样）——改用 comfy_run 的 graph 模式传自己的工作流。`)
      }
      return { text: lines.join('\n') }
    },
  })

  // ── 3. comfy_node ──────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_node',
    description:
      '查一个 ComfyUI 节点类接受哪些输入、默认值和取值范围、有哪些枚举值。'
      + '自己搭工作流（comfy_run 的 graph 模式）之前用它确认参数名和连线口。',
    parameters: params({ node_class: s('节点类名，例如 KSampler、CLIPTextEncode、SaveImage') }, ['node_class']),
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      let info
      try {
        info = await client.nodeInfo(args.node_class, { signal: exec.signal })
      } catch (error) {
        throw new Error(explain(error))
      }
      if (!info) {
        throw new Error(
          `没有叫 "${args.node_class}" 的节点类。常见的有：UNETLoader、CLIPLoader、VAELoader、`
          + 'CheckpointLoaderSimple、CLIPTextEncode、EmptySD3LatentImage、KSampler、VAEDecode、SaveImage、PreviewImage。',
        )
      }

      const lines = [`${info.name}${info.display_name ? `（${info.display_name}）` : ''}${info.output_node ? ' [输出节点]' : ''}`]
      if (info.description) lines.push(`说明：${String(info.description).slice(0, 300)}`)
      if (info.category) lines.push(`类别：${info.category}`)
      const outputs = (info.output ?? []).map((type, idx) => `${type}#${idx}${info.output_name?.[idx] ? `(${info.output_name[idx]})` : ''}`)
      lines.push(`输出：${outputs.length ? outputs.join(', ') : '无'}`)

      const describe = (group, key) => {
        const raw = info.input?.[group]?.[key]
        if (raw === undefined) return
        const [type, meta = {}] = Array.isArray(raw) ? raw : [raw, {}]
        let detail
        if (Array.isArray(type)) {
          const head = type.slice(0, 24).join(', ')
          detail = `枚举 ${type.length} 个：${head}${type.length > 24 ? ', …' : ''}`
        } else if (type === 'INT' || type === 'FLOAT') {
          const bits = []
          if (meta.default !== undefined) bits.push(`默认 ${meta.default}`)
          if (meta.min !== undefined) bits.push(`最小 ${meta.min}`)
          if (meta.max !== undefined) bits.push(`最大 ${meta.max}`)
          if (meta.step !== undefined) bits.push(`步长 ${meta.step}`)
          detail = `${type}${bits.length ? `（${bits.join('，')}）` : ''}`
        } else if (type === 'STRING') {
          detail = `STRING${meta.default ? `（默认 "${String(meta.default).slice(0, 40)}"）` : ''}`
        } else if (type === 'BOOLEAN') {
          detail = `BOOLEAN${meta.default !== undefined ? `（默认 ${meta.default}）` : ''}`
        } else {
          detail = `${type} —— 连线口，值要写成 ["上游节点id", 输出序号]`
        }
        const tip = meta.tooltip ? ` — ${String(meta.tooltip).slice(0, 160)}` : ''
        lines.push(`  ${key}: ${detail}${tip}`)
      }

      for (const group of ['required', 'optional']) {
        const keys = info.input_order?.[group] ?? Object.keys(info.input?.[group] ?? {})
        if (keys.length === 0) continue
        lines.push('')
        lines.push(group === 'required' ? '必填输入：' : '可选输入：')
        for (const key of keys) describe(group, key)
      }
      return { text: lines.join('\n') }
    },
  })

  // ── 4. comfy_run ───────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_run',
    description:
      '把一张工作流提交给 ComfyUI 排队，立刻返回 prompt_id。三种用法：\n'
      + '· mode="template"（默认）：内置文生图 —— 加载模型 → 正负提示词 → 采样 → 解码 → 存图。'
      + '只要写 prompt，可选 lora / lora_strength 挂角色 LoRA。\n'
      + '· mode="img2img"：基于一张已有图重绘（先在设置页开启）。给 image_prompt_id（之前出图的 prompt_id），'
      + 'denoise 控制改动幅度（越小越贴近原图）。\n'
      + '· mode="graph"：传自己的 API 格式工作流 { "节点id": { class_type, inputs } }。\n'
      + '提交完不会等图 —— 用 comfy_result 拿结果。',
    parameters: params({
      mode: { type: 'string', enum: ['template', 'img2img', 'graph'], description: 'template=文生图（默认）；img2img=基于已有图重绘；graph=自己传工作流' },
      prompt: s('正面提示词。template/img2img 时必填；graph 时给了就写进 CLIPTextEncode'),
      negative: s('负面提示词，template/img2img 有效。省略用通用质量兜底'),
      width: i('宽，默认 1024，要 16 的倍数'),
      height: i('高，默认 1024，要 16 的倍数'),
      batch: i('一次出几张，默认 1。显存吃紧就保持 1'),
      steps: i('采样步数，默认 30'),
      cfg: n('CFG，默认 4.9'),
      seed: i('随机种子，默认随机。想复现同一张图就传同一个值'),
      sampler: s('采样器，默认 euler；可选值查 comfy_node KSampler'),
      scheduler: s('调度器，默认 simple；可选值查 comfy_node KSampler'),
      unet: s('扩散模型文件名，省略用 diffusion_models 里第一个'),
      clip: s('文本编码器文件名，省略用 text_encoders 里第一个'),
      vae: s('VAE 文件名，省略用 vae 里第一个'),
      lora: s('LoRA 文件名（template 模式，需在设置页开启 lora）。用 comfy_models 查 loras 文件夹'),
      lora_strength: n('LoRA 强度，默认 0.8'),
      image_prompt_id: s('img2img 模式的底图来源：之前出图的 prompt_id'),
      denoise: n('img2img 的 denoise，默认 0.6。越小越贴近原图，越大改得越狠'),
      graph: { type: 'object', additionalProperties: true, description: 'mode=graph 的工作流：{ "1": { class_type, inputs } }' },
      prompt_node: s('mode=graph 时，提示词写到哪个节点 id。省略就找第一个 CLIPTextEncode'),
      title: s('给这次任务起个名字，只用于展示'),
    }, ['mode']),
    output: output(),
    async execute(args, exec) {
      const signal = exec.signal
      const mode = args.mode ?? 'template'
      const features = readFeatureConfig(config)
      let graph
      let injectedNode = null

      if (mode === 'graph') {
        if (!args.graph) throw new Error('mode="graph" 时必须给 graph（API 格式的节点表）')
        graph = normalizeGraph(args.graph)
        if (args.prompt) {
          injectedNode = injectPrompt(graph, args.prompt, args.prompt_node)
          if (injectedNode === null) {
            throw new Error('提示词没写进去：这张图里没有 CLIPTextEncode 节点，请用 prompt_node 指定节点 id')
          }
        }
      } else if (mode === 'template' || mode === 'img2img') {
        // 先把不需要联网的校验全部走完，再去问 ComfyUI 要模型清单。
        // 否则服务没跑的时候，参数错和开关没开都会被 ECONNREFUSED 盖住，
        // 用户看到的是「连不上」，而不是真正该改的那个参数。
        if (!args.prompt || args.prompt.trim().length === 0) {
          throw new Error(`mode="${mode}" 时必须给 prompt（正面提示词）`)
        }
        if (mode === 'img2img') {
          if (!features.img2img) {
            throw new Error('图生图（img2img）没开启，请在插件设置页把「img2img」开关打开。')
          }
          if (!args.image_prompt_id) {
            throw new Error('mode="img2img" 必须给 image_prompt_id（底图来源，之前出图的 prompt_id）')
          }
        } else if (args.lora && !features.lora) {
          throw new Error('LoRA 没开启，请在插件设置页把「lora」开关打开。')
        }

        const index = await client.modelIndex({ signal })
        const models = resolveModels(index, { unet: args.unet, clip: args.clip, vae: args.vae })

        if (mode === 'img2img') {
          const { bytes } = await fetchImageRef(args.image_prompt_id, signal)
          const imageName = await uploadImage(bytes, `dsh_src_${args.image_prompt_id.slice(0, 8)}.png`)
          graph = buildImg2Img({
            unet: models.unet,
            clip: models.clip,
            vae: models.vae,
            imageName,
            prompt: args.prompt,
            negative: args.negative ?? DEFAULT_NEGATIVE,
            denoise: args.denoise ?? 0.6,
            steps: args.steps ?? 30,
            cfg: args.cfg ?? 4.9,
            seed: args.seed ?? Math.floor(Math.random() * 2 ** 47),
            sampler: args.sampler ?? 'euler',
            scheduler: args.scheduler ?? 'simple',
            filenamePrefix: 'dsh/img2img',
          })
        } else {
          graph = buildTxt2Img({
            unet: models.unet,
            clip: models.clip,
            vae: models.vae,
            prompt: args.prompt,
            negative: args.negative ?? DEFAULT_NEGATIVE,
            width: args.width ?? 1024,
            height: args.height ?? 1024,
            batch: args.batch ?? 1,
            steps: args.steps ?? 30,
            cfg: args.cfg ?? 4.9,
            seed: args.seed ?? Math.floor(Math.random() * 2 ** 47),
            sampler: args.sampler ?? 'euler',
            scheduler: args.scheduler ?? 'simple',
            filenamePrefix: 'dsh/comfy',
            lora: args.lora || undefined,
            loraStrength: args.lora_strength ?? 0.8,
          })
        }
      } else {
        throw new Error(`不认识的 mode "${mode}"，只能是 template、img2img 或 graph`)
      }

      const submitted = await client.submit(graph, { signal })
      if (!submitted.ok) {
        const detail = submitted.nodeErrors
          ? `\n节点报错：${JSON.stringify(submitted.nodeErrors).slice(0, 2000)}`
          : ''
        throw new Error(`ComfyUI 拒了这张工作流：${submitted.error}${detail}`)
      }

      const summary = summarizeGraph(graph)
      const byClass = Object.entries(summary.byClass)
        .map(([klass, count]) => `${klass}×${count}`)
        .join(' ')
      const lines = [
        `已提交${args.title ? `「${args.title}」` : ''} · prompt_id: ${submitted.promptId}`,
        `队列号 ${submitted.number ?? '?'} · ${summary.count} 个节点：${byClass}`,
      ]
      if (mode === 'template' || mode === 'img2img') {
        const loader = graph[1]?.inputs ?? {}
        lines.push(`模型：${loader.unet_name} + ${graph[2]?.inputs?.clip_name} + ${graph[3]?.inputs?.vae_name}`)
        if (mode === 'img2img') {
          const samplerNode = graph[8]?.inputs ?? {}
          lines.push(`img2img · denoise ${samplerNode.denoise} · ${samplerNode.steps} 步 · seed ${samplerNode.seed}`)
        } else {
          const latent = graph[6]?.inputs ?? {}
          const samplerNode = graph[7]?.inputs ?? {}
          lines.push(
            `${latent.width}×${latent.height} ×${latent.batch_size} · ${samplerNode.steps} 步 · CFG ${samplerNode.cfg}`
            + ` · ${samplerNode.sampler_name}/${samplerNode.scheduler} · seed ${samplerNode.seed}`,
          )
          if (graph[10]) lines.push(`LoRA：${graph[10]?.inputs?.lora_name}`)
        }
      } else if (injectedNode !== null) {
        lines.push(`提示词写进了节点 ${injectedNode}`)
      }
      lines.push('')
      lines.push('拿结果用 comfy_result（传这个 prompt_id 和 wait_seconds）。1024×1024 单张通常几十秒起，按自己机器的速度给等待时间。')
      return { text: lines.join('\n') }
    },
  })

  // ── 5. comfy_result ────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_result',
    description:
      '等一个任务跑完，然后取回它的输出图。'
      + '给了 wait_seconds 就一直等到跑完或等够那么久，不给就只看当前状态。'
      + '图会以图片形式交给模型看，同时报出磁盘上的路径；给 save_to 还会另存一份。',
    parameters: params({
      prompt_id: s('comfy_run 返回的 prompt_id'),
      wait_seconds: i('最多等多少秒，0 表示不等待只看状态。1024×1024 单张常见 60–120 秒，多张按张数加'),
      max_images: i('最多取回几张，默认 4，最多 12'),
      show_images: { type: 'boolean', description: '是否把图交给模型看，默认 true；只想看路径和状态就传 false' },
      save_to: s('把图另存到这个目录（会自己建目录）。不给就只报 ComfyUI 那边的原有路径'),
    }, ['prompt_id']),
    output: output(),
    timeoutMs: settings.maxWaitSeconds * 1000 + 120_000,
    async execute(args, exec) {
      const signal = exec.signal
      const waitSeconds = Math.max(0, Math.min(args.wait_seconds ?? 0, settings.maxWaitSeconds))
      const maxImages = Math.max(1, Math.min(12, args.max_images ?? 4))
      const wantImages = args.show_images !== false
      const saveTo = typeof args.save_to === 'string' && args.save_to.length > 0 ? args.save_to : ''

      const started = Date.now()
      const deadline = started + waitSeconds * 1000

      let job = await client.job(args.prompt_id, { signal })
      if (!job) {
        // 可能已经跑完、被挪出 jobs 列表了，去历史里找
        const entry = await client.historyEntry(args.prompt_id, { signal })
        if (!entry) {
          throw new Error(`找不到任务 ${args.prompt_id}：既不在任务列表里，历史里也没有。确认 prompt_id 没写错。`)
        }
        job = { id: args.prompt_id, status: 'completed', outputs_count: 0 }
      }

      while (!FINISHED.has(job.status) && Date.now() < deadline) {
        await sleep(Math.min(settings.pollMs, Math.max(250, deadline - Date.now())), signal)
        job = (await client.job(args.prompt_id, { signal })) ?? job
      }

      const took = job.execution_end_time && job.execution_start_time
        ? ` · 耗时 ${humanDuration(job.execution_end_time - job.execution_start_time)}`
        : ''
      const lines = [`任务 ${args.prompt_id}`, `状态：${job.status}${took}`]

      if (!FINISHED.has(job.status)) {
        lines.push(`还在跑（已等 ${humanDuration(Date.now() - started)}）。再调一次 comfy_result，把 wait_seconds 给大一点。`)
        return { text: lines.join('\n') }
      }
      if (job.status === 'failed') {
        lines.push('这个任务失败了。ComfyUI 的控制台窗口里有具体报错；也可以 comfy_status 看看是不是显存不够。')
        return { text: lines.join('\n') }
      }

      // 历史记录会比任务状态晚一拍写进去
      let entry = null
      for (let attempt = 0; attempt < 8; attempt += 1) {
        entry = await client.historyEntry(args.prompt_id, { signal })
        if (entry) break
        await sleep(500, signal)
      }
      if (!entry) {
        lines.push('任务跑完了，但历史里还没出现输出。等几秒再查一次，或者去 ComfyUI 的输出目录看。')
        return { text: lines.join('\n') }
      }

      const images = collectImages(entry).slice(0, maxImages)
      if (images.length === 0) {
        lines.push('任务跑完了，但没有产出图片（这张工作流可能只输出别的东西）。')
        return { text: lines.join('\n') }
      }

      const saved = []
      if (saveTo) {
        try {
          await mkdir(saveTo, { recursive: true })
        } catch (error) {
          lines.push(`另存目录建不出来（${saveTo}）：${error?.message ?? error}`)
        }
      }

      const capable = wantImages ? await imageCapable(ctx, exec) : { ok: false, reason: '没要求看图' }
      const attachments = capable.ok ? ctx.get('attachments') : null
      const limit = attachments
        ? Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
        : 0

      const refs = []
      const outputRoot = await resolvedOutputRoot(signal)
      lines.push(`输出 ${images.length} 张：`)
      for (const image of images) {
        const disk = onDiskPath(image, outputRoot)
        lines.push(`  ${image.filename}${disk ? `\n    路径 ${disk}` : `（ComfyUI 的 ${image.type} 目录下）`}`)

        let bytes
        try {
          bytes = await client.view(image, { signal })
        } catch (error) {
          lines.push(`    ! 取不到这张图：${explain(error)}`)
          continue
        }

        if (saveTo) {
          try {
            const target = join(saveTo, image.filename)
            await writeFile(target, bytes)
            saved.push(target)
            lines.push(`    另存 ${target}`)
          } catch (error) {
            lines.push(`    ! 另存失败：${error?.message ?? error}`)
          }
        }

        if (!capable.ok) continue
        if (bytes.length > limit) {
          lines.push(`    ! 这张 ${(bytes.length / 2 ** 20).toFixed(1)} MiB，超过模型能收的上限，没交给模型`)
          continue
        }
        const mediaType = sniffMediaType(bytes)
        if (!mediaType) {
          lines.push('    ! 不是认识的图片格式，没交给模型')
          continue
        }
        try {
          refs.push(await attachments.saveImage({ data: bytes, mediaType, name: image.filename }))
        } catch (error) {
          lines.push(`    ! 存不进附件：${error?.message ?? error}`)
        }
      }

      if (!capable.ok && wantImages) lines.push(`\n这次没把图交给模型：${capable.reason}`)
      return { text: lines.join('\n'), images: refs }
    },
  })

  // ── 6. comfy_control ───────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_control',
    description:
      '管 ComfyUI 的队列：取消某个任务、打断正在跑的那个、清空排队、或者把显存放出来。',
    parameters: params({
      action: {
        type: 'string',
        enum: ['cancel', 'interrupt', 'clear_queue', 'free_vram'],
        description:
          'cancel=取消指定任务（在跑就打断，在排队就删掉）；interrupt=打断当前正在跑的那个；'
          + 'clear_queue=清空还在排队的；free_vram=卸载模型释放显存',
      },
      prompt_id: s('action=cancel 时必填，要取消的任务 id'),
    }, ['action']),
    output: output(),
    async execute(args, exec) {
      const signal = exec.signal
      switch (args.action) {
        case 'cancel': {
          if (!args.prompt_id) throw new Error('action="cancel" 时必须给 prompt_id')
          const result = await client.cancelJob(args.prompt_id, { signal })
          return {
            text: result?.cancelled
              ? `已取消任务 ${args.prompt_id}`
              : `任务 ${args.prompt_id} 没被取消 —— 它可能已经跑完或不在队列里了。用 comfy_status 看看当前状态。`,
          }
        }
        case 'interrupt': {
          await client.interrupt({ signal })
          return { text: '已给 ComfyUI 发中断，正在跑的那个任务会停下。' }
        }
        case 'clear_queue': {
          await client.clearQueue({ signal })
          return { text: '排队中的任务已清空（正在跑的不受影响）。' }
        }
        case 'free_vram': {
          await client.free({ unloadModels: true, freeMemory: true }, { signal })
          const stats = await client.systemStats({ signal }).catch(() => null)
          const dev = stats?.devices?.[0]
          const extra = dev
            ? `现在显存空闲 ${(dev.vram_free / 2 ** 30).toFixed(1)} / ${(dev.vram_total / 2 ** 30).toFixed(1)} GiB。`
            : ''
          return { text: `已卸载模型并释放显存。${extra}下一次出图会重新加载，头一张慢一些。` }
        }
        default:
          throw new Error(`不认识的 action "${args.action}"`)
      }
    },
  })

  // ── 7. comfy_review ────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_review',
    description:
      '让指定模型看一张刚生成的图，判断是否满足要求；不满意就按模型的修改意见自动重生成，'
      + '循环到满意或达到最大重试次数。需先在设置页开启 review 并指定审图模型。'
      + '给了 reference_prompt_id 就同时把角色参考图交给它比对「角色是否还原」'
      + '（发型/发色/瞳色/服饰/配色/气质）。'
      + '返回每轮的判定/评分/反馈/新提示词，以及最终那张图。',
    parameters: params({
      prompt_id: s('刚生成的那张图的 prompt_id（审图对象）'),
      requirement: s('用户最初的要求，审图就按这个判'),
      reference_prompt_id: s('角色参考图来源：之前出图的 prompt_id。给了就把它一并交给审图模型，用来比对角色是否还原'),
      max_attempts: i('最多重生成几次（不含首次），省略用设置页里的值'),
      lora: s('重画时挂的角色 LoRA 文件名（需在设置页开启 lora）。留空则不带 LoRA'),
      lora_strength: n('LoRA 强度，默认 0.8'),
    }, ['prompt_id', 'requirement']),
    output: output(),
    timeoutMs: settings.maxWaitSeconds * 1000 + 600_000,
    async execute(args, exec) {
      const signal = exec.signal
      const features = readFeatureConfig(config)
      if (!features.review.enabled) {
        throw new Error('审图功能没开启，请在插件设置页把「review」开关打开。')
      }
      const reviewer = await resolveReviewer(exec, features.review)
      const maxAttempts = Math.max(0, Math.min(5, args.max_attempts ?? features.review.maxAttempts ?? 1))

      let current = await fetchImageRef(args.prompt_id, signal)
      // 参考图：只取一次，之后每轮都拿同一张去比对，保证「角色还原」的判据稳定
      let referenceRef = null
      if (args.reference_prompt_id) {
        const reference = await fetchImageRef(args.reference_prompt_id, signal)
        referenceRef = reference.ref
      }
      // 重画时默认沿用这张底图的尺寸/参数，别把 768 的图重画成 1024 的比例
      const size = (() => {
        const w = Number(current.ref?.width)
        const h = Number(current.ref?.height)
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          return { width: Math.round(w / 16) * 16, height: Math.round(h / 16) * 16 }
        }
        return { width: 1024, height: 1024 }
      })()
      const lora = args.lora
      if (lora && !features.lora) {
        throw new Error('LoRA 没开启，请在插件设置页把「lora」开关打开。')
      }
      const reviewLog = []

      let satisfied = false
      let round = 0
      for (; round <= maxAttempts; round += 1) {
        const verdict = await askReviewer(exec, {
          provider: reviewer.provider,
          model: reviewer.model,
          imageRef: current.ref,
          referenceRef,
          requirement: args.requirement,
          extra: features.review.extra,
        })
        reviewLog.push({
          attempt: round,
          satisfied: verdict.satisfied,
          score: verdict.score,
          feedback: verdict.feedback,
          new_prompt: verdict.newPrompt,
        })
        if (verdict.satisfied) {
          satisfied = true
          break
        }
        if (round >= maxAttempts) break
        // 不满意 → 重生成。new_prompt 优先，否则拿原始要求拼接反馈。
        const newPrompt = verdict.newPrompt && verdict.newPrompt.trim().length > 0
          ? verdict.newPrompt
          : `${args.requirement}${verdict.feedback ? `（修正：${verdict.feedback}）` : ''}`
        const index = await client.modelIndex({ signal })
        const models = resolveModels(index, {})
        const graph = buildTxt2Img({
          unet: models.unet,
          clip: models.clip,
          vae: models.vae,
          prompt: newPrompt,
          negative: DEFAULT_NEGATIVE,
          width: size.width,
          height: size.height,
          batch: 1,
          steps: 30,
          cfg: 4.9,
          seed: Math.floor(Math.random() * 2 ** 47),
          sampler: 'euler',
          scheduler: 'simple',
          filenamePrefix: 'dsh/review',
          lora: lora || undefined,
          loraStrength: args.lora_strength ?? 0.8,
        })
        current = await submitAndFetch(graph, signal)
      }

      const lines = [
        `审图模型：${reviewer.model}（${reviewer.provider}）`,
        `结论：${satisfied ? '满意' : '仍未满意'}`,
      ]
      if (referenceRef) lines.push('已附角色参考图，审图时一并比对角色还原度。')
      lines.push('')
      for (const item of reviewLog) {
        lines.push(`第 ${item.attempt} 轮：${item.satisfied ? '✓ 满意' : '✗ 不满意'} · 评分 ${item.score}/10`)
        if (item.feedback) lines.push(`  反馈：${item.feedback}`)
        if (item.new_prompt) lines.push(`  重画提示词：${item.new_prompt}`)
      }
      if (!satisfied) lines.push(`\n已达到最大重试 ${maxAttempts} 次，下面是最后一次的图。`)
      return { text: lines.join('\n'), images: [current.ref] }
    },
  })

  // ── 8. comfy_upscale ────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_upscale',
    description:
      '用算法（ImageScale，默认 lanczos）放大一张已生成的图。'
      + '需先在设置页开启 upscale。给 image_prompt_id（之前出图的 prompt_id）和宽高。',
    parameters: params({
      image_prompt_id: s('要放大的图的 prompt_id'),
      width: i('目标宽，正整数'),
      height: i('目标高，正整数'),
      method: { type: 'string', enum: ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'], description: '放大算法，默认 lanczos' },
    }, ['image_prompt_id', 'width', 'height']),
    output: output(),
    timeoutMs: settings.maxWaitSeconds * 1000 + 120_000,
    async execute(args, exec) {
      const signal = exec.signal
      const features = readFeatureConfig(config)
      if (!features.upscale) {
        throw new Error('放大功能没开启，请在插件设置页把「upscale」开关打开。')
      }
      const { bytes } = await fetchImageRef(args.image_prompt_id, signal)
      const imageName = await uploadImage(bytes, `dsh_up_${args.image_prompt_id.slice(0, 8)}.png`)
      const graph = buildUpscale({
        imageName,
        width: args.width,
        height: args.height,
        method: args.method ?? 'lanczos',
        filenamePrefix: 'dsh/upscale',
      })
      const { ref, filename } = await submitAndFetch(graph, signal)
      return {
        text: `已放大到 ${args.width}×${args.height}（${args.method ?? 'lanczos'}）。\n输出：${filename}`,
        images: [ref],
      }
    },
  })

  // ── 设置页用的只读路由：列出能看图的模型 ────────────────────────────────
  // 浏览器半端没有 llm 服务（client 侧只有 slots/locale/configForms 等），
  // 所以「设置页里选出审图模型」必须由宿主开一条只读路由给它取。
  // connection.fetch 已自带鉴权（栅栏内的 admit），这里只管数据。
  const mountVisionRoute = (scope) => {
    const log = (msg) => {
      try { scope.logger('comfyui').info(msg) } catch { /* 忽略 */ }
    }
    const connection = scope.connection
      ?? (typeof scope.get === 'function' ? scope.get('connection') : undefined)
    if (!connection || typeof connection.fetch?.register !== 'function') {
      log('没有 connection.fetch，设置页的模型清单路由挂不上（审图模型改成跟随当前会话）')
      return
    }
    try {
      scope.effect(() => connection.fetch.register({
        path: VISION_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const service = llm()
          if (!service) {
            return jsonResponse({ ok: false, error: '没有 llm 服务，列不了模型', providers: [] })
          }
          try {
            const providers = await collectVisionModels(service)
            return jsonResponse({ ok: true, providers })
          } catch (error) {
            return jsonResponse({ ok: false, error: error?.message ?? String(error), providers: [] }, 500)
          }
        },
      }), 'comfyui: /api/comfyui/vision-models 路由')
    } catch (error) {
      log(`HTTP 路由没挂上：${error?.message ?? error}`)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], mountVisionRoute)
  } else {
    // 极简 ctx（离线冒烟测试）走这一支；没有 connection 就静静地跳过
    mountVisionRoute(ctx)
  }

  // ── 给模型的一段说明（这个 profile 里没这些工具时自动空着） ───────────
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'tool:comfyui',
      order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: ({ scope }) =>
        ctx.tools.get('comfy_run', scope) === undefined
          ? ''
          : [
              '# ComfyUI',
              `本机 ComfyUI 在 ${where()}。出图流程：comfy_run 提交（拿 prompt_id）→ comfy_result 等它跑完并取图。`,
              '文生图直接用 comfy_run 的 template 模式写 prompt；要更复杂的图先 comfy_node 查节点再走 graph 模式。',
              'img2img：comfy_run mode="img2img" + image_prompt_id（底图）+ denoise 做重绘；LoRA：comfy_run 的 lora 参数挂角色 LoRA（都要先在设置页开开关）。',
              'comfy_review：让审图模型看一张图判断是否满足要求、不满意自动重画（设置页开启 review 并指定模型）。',
              '要判断「角色是否还原」时，把参考图的 prompt_id 一起传给 comfy_review 的 reference_prompt_id —— 它会把两张图一起交给审图模型比对。',
              'comfy_upscale：用算法放大一张图。审图模型在插件设置页的「ComfyUI 桥 → 选择审图模型」下拉框里挑。',
              '1024×1024 在消费级显卡上单张通常要几十秒到两分钟，所以 comfy_result 要带 wait_seconds（单张 120，多张按张数加）。',
              '显存吃紧时 batch 保持 1；要腾地方用 comfy_control free_vram。',
            ].join('\n'),
    }),
  )
}
