/**
 * index.js —— ComfyUI 控制插件（Host 侧）
 * ============================================================================
 * 装好之后模型会多出 10 个工具：
 *   comfy_status   服务 / 显存 / 队列 / 任务状态
 *   comfy_models   有哪些模型文件可用
 *   comfy_node     某个节点类接受哪些输入（搭自定义工作流时查）
 *   comfy_run      提交任务（内置文生图模板，或直接给它一份 API 格式的工作流）
 *   comfy_result   等任务跑完，取回输出图（图真的会交给模型看）
 *   comfy_control  取消 / 中断 / 清队列 / 放显存
 *   comfy_inspect  工作流分析器：读工作流 JSON，识别关键节点 / 连线 / 可改参数 / 诊断 / 子图
 *
 * 这里**不 import 任何 @deepseek-ai/* 包**：工具定义直接用标准 JSON Schema 写。
 * ctx.tools.register 只校验 output.schema 和名字，不要求 defineTool 那层包装，
 * 所以插件在任何 profile 里都能加载，不会因为宿主树解析不到依赖而整个挂掉。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import { parseWorkflow } from './lib/format-adapter.mjs'
import { describeInspection, inspectWorkflow } from './lib/inspector.mjs'
import {
  applyWorkflowParams,
  createWorkspaceStore,
  extractWorkflowParams,
  resolveWorkflow,
  safeFilename,
  historyToRecord,
} from './lib/workspace-store.mjs'

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
  }).volatile(),
  img2img: z.object({ enabled: z.boolean().default(false).description('开启图生图（comfy_run mode="img2img"）') }).volatile(),
  upscale: z.object({ enabled: z.boolean().default(false).description('开启算法放大（comfy_upscale）') }).volatile(),
  draw: z.object({
    unet: z.string().default('').description('默认生图模型（diffusion_models 或 checkpoints 里的文件名）；留空用 diffusion_models 里第一个，没有就用 checkpoints 里第一个'),
    lora: z.boolean().default(false).description('允许 comfy_run / comfy_review 挂 LoRA'),
  }).volatile(),
  output: z.object({
    dir: z.string().default('').description('图片输出目录；绝对路径直接用，相对路径相对 ComfyUI 的 output；留空＝留在 ComfyUI 的 output'),
  }).volatile(),
  loraDocs: z.object({
    dir: z.string().default('').description('LoRA 提示词文档目录；绝对路径直接用，相对路径相对 ComfyUI 的 output；留空＝不查文档'),
    maxChars: z.number().step(1).min(200).max(20000).default(4000)
      .description('一篇文档最多并入 prompt 多少字（200–20000）；超了按空行/换行/逗号边界收口，不切半个 tag'),
  }).volatile(),
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
 * 默认：review/img2img/upscale 全关闭；draw.unet 留空（用文件夹里第一个）、draw.lora 关闭；
 * output.dir 留空（图就留在 ComfyUI 自己的 output 里，不额外复制）；
 * loraDocs.dir 留空（挂 LoRA 时不去找提示词文档），maxChars 默认 4000。
 * @returns {{review:{enabled,provider,model,maxAttempts}, img2img:boolean, upscale:boolean, draw:{unet:string,lora:boolean}, output:{dir:string}, loraDocs:{dir:string,maxChars:number}}}
 */
function readFeatureConfig(config) {
  const review = unwrapVolatile(config?.review) ?? {}
  const draw = unwrapVolatile(config?.draw) ?? {}
  const output = unwrapVolatile(config?.output) ?? {}
  const loraDocs = unwrapVolatile(config?.loraDocs) ?? {}
  return {
    review: {
      enabled: review.enabled === true,
      provider: typeof review.provider === 'string' ? review.provider : '',
      model: typeof review.model === 'string' ? review.model : '',
      maxAttempts: Number.isInteger(review.maxAttempts) ? review.maxAttempts : 1,
    },
    img2img: (unwrapVolatile(config?.img2img) ?? {}).enabled === true,
    upscale: (unwrapVolatile(config?.upscale) ?? {}).enabled === true,
    draw: {
      unet: typeof draw.unet === 'string' ? draw.unet : '',
      lora: draw.lora === true,
    },
    output: {
      dir: typeof output.dir === 'string' ? output.dir.trim() : '',
    },
    loraDocs: {
      dir: typeof loraDocs.dir === 'string' ? loraDocs.dir.trim() : '',
      // 越界值在 schema 层就会被拒；这里再夹一层，防 cordis.patch.yml 里手写非法值时整插件加载失败
      maxChars: Number.isInteger(loraDocs.maxChars)
        ? Math.min(LORA_DOC_CHARS_MAX, Math.max(LORA_DOC_CHARS_MIN, loraDocs.maxChars))
        : LORA_DOC_MAX_CHARS,
    },
  }
}

/**
 * 生图模型优先级：对话栏里选的（draw.unet）是用户当面点的，优先级最高；
 * 只有它留空（= 自动）时，模型通过 comfy_run 的 unet 参数临时指定的才生效。
 * 两者都空就 undefined，交给 resolveModels 走「文件夹里第一个」。
 */
export function preferModel(drawUnet, argUnet) {
  if (typeof drawUnet === 'string' && drawUnet.trim() !== '') return drawUnet
  if (typeof argUnet === 'string' && argUnet.trim() !== '') return argUnet
  return undefined
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

/**
 * 判断「看起来是绝对路径」——**故意不用 path.isAbsolute**。
 * path.isAbsolute 跟平台走：同一份配置 `X:\pics` 在 Windows 上为真、在 Linux 上为假，
 * 会让同一个设置在两台机器上落到完全不同的地方，双平台的 CI 也会给出相反结论。
 * 这里按写法判断：盘符开头 / UNC 开头 / POSIX 根开头，三者任一即视为绝对。
 */
export function looksAbsolute(p) {
  const value = typeof p === 'string' ? p.trim() : ''
  if (value.length === 0) return false
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/**
 * 把「配置里的目录」解析成最终目录。label 只用于报错文案，让用户知道是哪一栏写错了。
 * - 空 → ''（不动作）
 * - 绝对 → 原样
 * - 相对 + 知道 ComfyUI 的 output 根 → 拼在它下面
 * - 相对 + 不知道根 → 报错（否则会落到进程 cwd 里，用户根本找不到）
 */
export function resolveConfiguredDir(configured, comfyRoot, label = '目录') {
  const raw = typeof configured === 'string' ? configured.trim() : ''
  if (raw.length === 0) return ''
  if (looksAbsolute(raw)) return raw
  const root = typeof comfyRoot === 'string' ? comfyRoot.trim() : ''
  if (root.length === 0) {
    throw new Error(
      `${label}写的是相对路径，但认不出 ComfyUI 的 output 目录在哪。`
      + '改成绝对路径，或用参数直接给绝对路径。',
    )
  }
  return join(root.replace(/[\\/]+$/, ''), raw)
}

/**
 * 把「配置里的输出目录」解析成最终目录（相对路径以 ComfyUI 的 output 为基准）。
 */
export function resolveOutputDir(configured, comfyRoot) {
  return resolveConfiguredDir(configured, comfyRoot, '输出目录')
}

/**
 * 给目标文件找一个不撞名的位置：同名已存在就依次试 -1、-2…
 * 不覆盖用户已有的文件（出图是幂等的，覆盖反而丢东西）。
 */
export async function uniqueTarget(dir, filename) {
  const name = String(filename || 'image.png').replace(/[\\/]+$/, '') || 'image.png'
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 0; n < 1000; n += 1) {
    const candidate = join(dir, n === 0 ? name : `${stem}-${n}${ext}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, `${stem}-${Date.now()}${ext}`)
}

/**
 * 把一张图的字节写到目标目录（目录不存在就建）。
 * dir 为空时什么都不做、返回 '' —— 「没配输出目录」时这一整条路径都走不到。
 */
export async function saveImageCopy(dir, image, bytes) {
  const target0 = typeof dir === 'string' ? dir.trim() : ''
  if (target0.length === 0) return ''
  if (!bytes || bytes.length === 0) return ''
  await mkdir(target0, { recursive: true })
  const target = await uniqueTarget(target0, image?.filename || 'image.png')
  await writeFile(target, bytes)
  return target
}

const FINISHED = new Set(['completed', 'failed', 'cancelled'])
/**
 * 非终态但合法的中间态。状态是这些之外的非空值（比如某个新构建多出来的
 * `interrupted`/`execution_error`）时，若 history 已经有记录就当完成处理，
 * 避免插件抱着一个看不懂的状态空等到 deadline。
 */
const KNOWN_NONFINAL = new Set(['pending', 'in_progress', 'queued', 'running'])

/** 把 ComfyUI 各版本的状态字段归一到我们的终态/中间态口径。纯函数，可单测。 */
export function normalizeStatus(status) {
  const s = String(status ?? '').toLowerCase()
  if (s === 'interrupted' || s === 'execution_interrupted' || s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'error' || s === 'execution_error' || s === 'failed' || s === 'failure') return 'failed'
  if (s === 'success' || s === 'completed') return 'completed'
  if (s === 'running' || s === 'in_progress') return 'in_progress'
  if (s === 'queued' || s === 'pending') return 'pending'
  return s
}

/** 队列里某个 id 是否还在（running / pending 都算）。查不到就当不在。 */
async function jobInQueue(client, promptId, signal) {
  const q = await client.queue({ signal }).catch(() => null)
  if (!q) return false
  const items = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])]
  return items.some((item) => {
    const id = Array.isArray(item) ? item[1] : item?.prompt_id ?? item?.id
    return id === promptId
  })
}

/** 给超时文案附一句队列快照；快照失败不影响主流程。 */
export async function queueSnapshot(client, signal) {
  const q = await client.queue({ signal }).catch(() => null)
  if (!q) return ''
  const running = q.queue_running?.length ?? 0
  const pending = q.queue_pending?.length ?? 0
  return `（队列：正在跑 ${running} 个，排队 ${pending} 个）`
}

/**
 * 造一个「等任务结束」的函数。submitAndFetch 与 comfy_result 共用同一套判断，
 * 避免两处各写一份、改一处漏一处。
 *
 * 返回 { job, reason, lastStatus, queueInfo }：
 *   reason = finished | timeout | lost
 *   - finished：job.status 已归一，调用方看 failed / completed 即可
 *   - timeout ：到 deadline 还在跑；queueInfo 带队列快照
 *   - lost    ：/api/jobs、history、/queue 三处都找不到（多半被取消或历史被挤出）
 *
 * 关键修复：client.job 返回 null 时不再用旧状态冒充继续空转，而是三级兜底；
 * 状态字段是没见过的非空值时，只要 history 有记录也当成跑完，堵住「状态丢了」
 * 导致的死等。所有兜底请求都带 signal 并 catch 降级，abort 会直接向上抛 CANCELLED。
 */
export function createJobWaiter(client, settings = {}) {
  const pollMs = Math.max(250, settings.pollMs ?? 2500)
  return async function waitForJob(promptId, { signal, deadline, historyFallback = true } = {}) {
    const end = deadline ?? Date.now() + (settings.maxWaitSeconds ?? 900) * 1000
    let missing = 0
    let lastStatus = 'unknown'

    const probe = async () => {
      const job = await client.job(promptId, { signal })
      const status = normalizeStatus(job?.status)
      if (status) lastStatus = status

      if (!job) {
        // 状态从 /api/jobs 消失了：先去 history 找，有记录就是跑完了
        if (historyFallback) {
          const entry = await client.historyEntry(promptId, { signal }).catch(() => null)
          if (entry) {
            return { done: true, result: { job: { id: promptId, status: 'completed', outputs_count: 0 }, reason: 'finished', lastStatus: 'completed' } }
          }
        }
        // 再看队列：还在跑/排队就继续等；连着两次三处都找不到才判丢失（躲开刚提交的竞态）
        const inQueue = await jobInQueue(client, promptId, signal)
        missing = inQueue ? 0 : missing + 1
        if (missing >= 2) {
          return { done: true, result: { job: null, reason: 'lost', lastStatus } }
        }
        return { done: false }
      }

      missing = 0
      if (FINISHED.has(status)) {
        return { done: true, result: { job: { ...job, status }, reason: 'finished', lastStatus: status } }
      }
      if (!KNOWN_NONFINAL.has(status) && historyFallback) {
        // 没见过的状态：history 有记录就当完成，别抱着看不懂的词死等
        const entry = await client.historyEntry(promptId, { signal }).catch(() => null)
        if (entry) {
          return { done: true, result: { job: { ...job, status: 'completed' }, reason: 'finished', lastStatus: 'completed' } }
        }
      }
      return { done: false }
    }

    // 先探一次：wait_seconds=0 时也要给当前状态，不能因为循环不进而什么都不返回
    while (true) {
      const { done, result } = await probe()
      if (done) return result
      if (Date.now() >= end) break
      await sleep(Math.min(pollMs, end - Date.now()), signal)
    }
    const queueInfo = await queueSnapshot(client, signal)
    return { job: null, reason: 'timeout', lastStatus, queueInfo }
  }
}

// ── LoRA 提示词文档 ───────────────────────────────────────────────────────
// 目录里可能什么都有：角色说明、画风笔记、随手记的 tag 清单、完全无关的东西。
// 文件名也不保证跟 LoRA 名对得上，所以这里不靠命名约定 —— 把每篇读进来打分：
// 「文件名像不像 + 正文提没提到这个 LoRA + 内容像不像提示词」，挑最靠谱的一篇。
// 这一节全是纯函数 / 纯文件读取，不碰 ComfyUI，方便单测。

/** 认的文档扩展名（小写比较） */
const LORA_DOC_EXTS = new Set(['.md', '.markdown', '.txt'])
/** 认的模型文件扩展名：用来判断「文档和 LoRA 文件放在同一个文件夹」 */
const LORA_MODEL_EXTS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.sft'])
/** 递归最多往下走几层，防止有人把整个盘指进来 */
const LORA_DOC_MAX_DEPTH = 3
/** 单篇文档超过这个字节数就跳过（提示词文档没有这么大） */
const LORA_DOC_MAX_BYTES = 256 * 1024
/** 并进 prompt 的提示词段默认最多多少字（设置页可改，见 Config.loraDocs.maxChars） */
const LORA_DOC_MAX_CHARS = 4000
/** 字数上限的允许范围：太小等于不喂，太大就把整篇说明塞进 prompt */
const LORA_DOC_CHARS_MIN = 200
const LORA_DOC_CHARS_MAX = 20000
/**
 * 按边界收口时，边界位置至少要占到上限的这个比例才用它。
 * 否则「最后一个逗号在 3 个字处」会把 4000 的预算浪费成 3 个字。
 */
const LORA_DOC_BOUNDARY_MIN_RATIO = 0.6
/** 一次最多读多少篇来打分（目录里塞了几百篇时别把 IO 打满） */
const LORA_DOC_SCAN_LIMIT = 120
/** 打分阶段累计读入的字节上限，超了就只看前若干篇 */
const LORA_DOC_SCAN_BYTES = 4 * 1024 * 1024
/** 分数到这个数才算「确实指向这个 LoRA」，可以直接并进 prompt */
const LORA_DOC_STRONG_SCORE = 45

/** 这些扩展名一定是文件后缀，对齐前先剥掉（模型文件的后缀普遍超过 8 个字母） */
const KNOWN_EXTS = new Set([
  'safetensors', 'ckpt', 'pt', 'pth', 'bin', 'gguf', 'sft',
  'md', 'markdown', 'txt',
])

/**
 * 把 LoRA 名或文档名规范化成同一个 key，用来对齐。
 * 'Belle Anima v1.safetensors' → 'belle_anima_v1'
 * '提示词-Belle_Anima-v1.MD'   → '提示词_belle_anima_v1'
 */
export function normalizeLoraKey(name) {
  const raw = typeof name === 'string' ? name : ''
  const dot = raw.lastIndexOf('.')
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase() : ''
  // 先按已知后缀剥（safetensors 有 11 个字母），再兜一个短后缀
  const strip = dot > 0 && (KNOWN_EXTS.has(ext) || /^[A-Za-z0-9]{1,8}$/.test(ext))
  const noExt = strip ? raw.slice(0, dot) : raw
  return noExt
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * 从一篇文档里取出「提示词段」的原始正文（不截断），供 extractPromptSection 与
 * comfy_lora_doc 的 rest 分支共用 —— 标题判定只写一份。
 * 有 `# 提示词` / `## Prompt` 这类标题就取它下面的内容，没有就取全文。
 * @returns {{body:string, heading:string}}
 */
export function promptBody(text) {
  const raw = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  if (raw.trim().length === 0) return { body: '', heading: '' }
  const lines = raw.split(/\r?\n/)
  const headingRe = /^(#{1,6})\s*(prompt|positive\s*prompt|提示词|正面提示词)\s*[:：]?\s*$/i
  let start = -1
  let level = 0
  let heading = ''
  for (let index = 0; index < lines.length; index += 1) {
    const matched = headingRe.exec(lines[index].trim())
    if (!matched) continue
    start = index + 1
    level = matched[1].length
    heading = lines[index].trim()
    break
  }
  if (start < 0) return { body: raw, heading: '' }
  const out = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    const next = /^(#{1,6})\s+/.exec(line.trim())
    // 遇到同级或更高级的标题就收工，子标题（更深）算正文
    if (next && next[1].length <= level) break
    out.push(line)
  }
  return { body: out.join('\n'), heading }
}

/**
 * 从一篇文档里取出「提示词段」，超过上限就**按边界收口**，不切半个 tag。
 * 边界优先级：空行 > 换行 > 逗号/顿号/分号 > 空格 > 硬切；
 * 边界位置必须 >= 上限 * LORA_DOC_BOUNDARY_MIN_RATIO，太靠前就换下一档。
 *
 * 返回 { text, truncated, heading, totalChars, keptChars, cut }：
 *   truncated=false ⟺ keptChars === totalChars ⟺ cut === ''
 *   cut ∈ '' | 'blank' | 'line' | 'comma' | 'space' | 'hard'
 */
export function extractPromptSection(text, { maxChars = LORA_DOC_MAX_CHARS } = {}) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : LORA_DOC_MAX_CHARS
  const { body, heading } = promptBody(text)
  const trimmed = body.trim()
  const totalChars = trimmed.length
  if (totalChars === 0) {
    return { text: '', truncated: false, heading, totalChars: 0, keptChars: 0, cut: '' }
  }
  if (totalChars <= limit) {
    return { text: trimmed, truncated: false, heading, totalChars, keptChars: totalChars, cut: '' }
  }
  const window = trimmed.slice(0, limit)
  const floor = Math.floor(limit * LORA_DOC_BOUNDARY_MIN_RATIO)
  const atLeastFloor = (pos) => pos >= floor
  const plan = [
    // promptBody 已经把所有换行归一成 \n，所以空行就是 \n\n
    { cut: 'blank', find: (w) => w.lastIndexOf('\n\n') },
    { cut: 'line', find: (w) => w.lastIndexOf('\n') },
    { cut: 'comma', find: (w) => Math.max(...[',', '，', '、', ';', '；'].map((sep) => w.lastIndexOf(sep))) },
    { cut: 'space', find: (w) => w.lastIndexOf(' ') },
  ]
  let cut = 'hard'
  let head = window
  for (const step of plan) {
    const pos = step.find(window)
    if (pos < 0 || !atLeastFloor(pos)) continue
    cut = step.cut
    head = window.slice(0, pos)
    break
  }
  const kept = head.replace(/[\s,，、;；]+$/u, '').trim()
  if (kept.length === 0) {
    // 极端：上限极小而开头全是分隔符 —— 宁可硬切也不返回空串
    return { text: window.trim(), truncated: true, heading, totalChars, keptChars: window.trim().length, cut: 'hard' }
  }
  return { text: kept, truncated: true, heading, totalChars, keptChars: kept.length, cut }
}

// ── 从文档里挑「真正的提示词段」 ─────────────────────────────────────────
// 现实里的提示词文档很少只有 tag：前面是模型信息表、作者原话、拆解、踩坑清单，
// 后面才是可以照抄的 tag 块。按顺序截前 N 字，等于优先喂散文、把真正该喂的挤到门外
// （实测：4000 字预算下 15.7% 是汉字，「可直接复制的完整 prompt」整段在门外）。
// 所以这里先按行判定「这一行是不是 tag 串」，把 tag 段挑出来，再在预算内拼。

/** 汉字/假名：用来区分「中文叙述」与「英文 tag 串」 */
const CJK_RE = /[\u3400-\u9FFF\u3040-\u30FF]/
/** 小标题前面的装饰：`## 负面`、`—— 可用负面词 ——`、`▍负面`、`**负面**`、`==== 负面 ====` */
const HEAD_DECOR_RE = /^[—\-─═=#*>·▍\s]*/u
/** 章节分隔行：`## xxx`、`【三】…`、`── A. …`、`▍④ …`、`**xxx**`、`====`、`方案 B：…` */
const SECTION_RE = /^(?:#{1,6}\s|[【▍·•]|[—\-─═=]{2,}|\*\*|方案\s*[A-Za-z0-9一二三四五六七八九十])/u

/**
 * 认一行是不是「正面 / 负面」小标题，是的话返回 `{kind, inline}`。
 *
 * 真实文档里的写法比想象中花：`负面：`、`负面额外加：`、`负面（这一套要额外压短发回流）：`、
 * `—— 可用负面词 ——`、`negative prompt:`。共同点是「关键词之后很快就到头」。
 * 而 `对策：负面里写死 school uniform…` 这种是正文在教你怎么写，不算小标题 ——
 * 所以关键词后面只允许「短括号 + 额外 + prompt/词 + 冒号或收尾装饰」，不许再跟一整句话。
 */
function promptHead(line) {
  const text = typeof line === 'string' ? line.trim() : ''
  const decor = HEAD_DECOR_RE.exec(text)?.[0] ?? ''
  const rest = text.slice(decor.length)
  const kind = /^(?:可用)?(?:负面|负向|反向|negative)/i.test(rest)
    ? 'neg'
    : (/^(?:可用)?(?:正面|正向|positive)/i.test(rest) ? 'pos' : '')
  if (kind === '') return null
  const after = rest.replace(/^(?:可用)?(?:负面|负向|反向|negative|正面|正向|positive)/i, '')
  // 两种小标题写法：
  // ① 「关键词 + 短修饰 + 冒号」——`负面：`、`负面额外加：`、`负面（这一套要额外压短发回流）：`，
  //    还有 `负面要加上，防原服装回流：` 这种带一句提醒的（冒号前的修饰不超过 16 字）；
  // ② 「关键词 + 短修饰 + 装饰收尾」——`—— 可用负面词 ——`、`## 负面`。
  // `对策：负面里写死 school uniform, yellow necktie, suspender skirt。` 这种正文不算小标题：
  // 它不以关键词开头；即便真的以关键词开头，冒号前也会带 ASCII 逗号或超过 16 字，两条都不满足。
  const colonAt = after.search(/[:：]/)
  const beforeColon = colonAt >= 0 ? after.slice(0, colonAt) : ''
  const colonOk = colonAt >= 0
    && beforeColon.length <= 16
    && /^[\s（()）\u3400-\u9FFF\u3040-\u30FF\w·、，]*$/.test(beforeColon)
  const bareOk = /^(?:\s*[（(][^）)]{0,40}[）)])?\s*(?:额外(?:加|补)?|追加|附加|补充)?\s*(?:prompt|提示词|词)?\s*(?:[—\-─═]{2,}\s*)?$/i.test(after)
  if (!colonOk && !bareOk) return null
  // 行内紧跟 tag（`负面：low quality, blurry`）时把冒号后的部分当 tag
  const inline = colonOk ? after.slice(colonAt + 1).replace(/^[—\-─═\s]*/u, '').trim() : ''
  return { kind, inline }
}

/**
 * 一行像不像「逗号分隔的 tag 串」（而不是一句中文说明）。
 * 判据：够长、>= 3 段、不以句号收尾、汉字占比 <= 20%、ASCII 占比 >= 75%、
 * 段里没有「一句话」（超过 5 个词的段不能太多）、没有表格对齐用的连串空格、
 * 没有全角括号，且 >= 80% 的段是纯英文 tag（挡掉「中文标签 + tag」混排的说明行）。
 */
export function tagishLine(line) {
  const raw = typeof line === 'string' ? line.trim() : ''
  // 末尾挂着的分隔符不参与判定：`a, b, c,` 与 `a, b, c` 是同一行
  const text = raw.replace(/[,，、;；\s]+$/u, '')
  if (text.length < 8) return false
  if (/[。！？]$/.test(text)) return false
  // 全角括号 = 作者在解释怎么用；表格行靠连串空格对齐，这些都不是 tag
  if (/[（）]/.test(text)) return false
  if (/\S {3,}\S/u.test(text)) return false
  const parts = text.split(/[,，、;；]/).map((item) => item.trim()).filter((item) => item.length > 0)
  if (parts.length < 3) return false
  const cjk = [...text].filter((ch) => CJK_RE.test(ch)).length
  if (cjk / text.length > 0.2) return false
  const ascii = [...text].filter((ch) => /[\x20-\x7E]/.test(ch)).length
  if (ascii / text.length < 0.75) return false
  const longParts = parts.filter((part) => part.split(/\s+/).length > 5).length
  if (longParts * 4 > parts.length) return false
  // 绝大多数段必须是纯英文 tag：说明行往往「一段中文标签 + 几个 tag」混排
  const clean = parts.filter((part) => !CJK_RE.test(part)).length
  return clean * 5 >= parts.length * 4
}

/** 方括号里夹着中文的占位符：`[在这里写你要的服装标签]`、`【服装】` —— 那是模板，不是 tag */
const PLACEHOLDER_RE = /[[【][^\]】]*[\u3400-\u9FFF\u3040-\u30FF][^\]】]*[\]】]/u

/**
 * 把一行洗干净再交给 `tagishLine` 判定：
 * - 丢掉方括号占位符那一段（`[在这里写你要的服装标签]`）—— 模板槽位不该进 prompt；
 * - 去掉段首的中文标签（`军装 peaked cap, …` 里的 `军装`）—— 标签是给人看的，
 *   后面那一串 `peaked cap, black headwear, …` 才是要喂的 tag。
 * 洗不出东西时返回空串，调用方按「不是 tag 行」处理。
 */
function tidyTagLine(line) {
  const text = typeof line === 'string' ? line.trim() : ''
  if (text === '') return ''
  // 全角括号（…）是作者的中文注释（`mole under eye（眼下泪痣是最强识别点）`、
  // `外套（叠在旗袍/常服后）`），整体剥掉；半角括号 `(hair_flower, red_rose:1.3)`
  // 是 tag 权重语法，必须保留。
  let cleaned = text.replace(/[（][^）]*[）]/gu, ' ').trim()
  // `| 鞋: high heels, …` 里的 `|` 把「鞋」这个中文标签和后面的鞋 tag 切开 ——
  // 换成逗号让鞋 tag 并进同一串（作者的意思是「这一套的鞋」）。
  cleaned = cleaned.replace(/\s*\|\s*[\u3400-\u9FFF\u3040-\u30FF]{1,6}\s*[:：]\s*/gu, ', ')
  const parts = cleaned.split(/[,，、;；]/).map((item) => item.trim()).filter((item) => item.length > 0)
  const kept = parts.filter((part) => !PLACEHOLDER_RE.test(part))
  if (kept.length > 0) {
    const head = kept[0]
    const label = /^[\u3400-\u9FFF\u3040-\u30FF][\u3400-\u9FFF\u3040-\u30FF\s:：、]*/u.exec(head)
    if (label) {
      const rest = head.slice(label[0].length).trim()
      if (rest === '') kept.shift()
      else kept[0] = rest
    }
  }
  return kept.join(', ')
}

/**
 * 把一篇文档切成「正面 tag 段」与「负面 tag 段」：按空行分块，逐行判定。
 * `负面：` / `负面额外加：` / `—— 可用负面词 ——` 之后的行算负面，`正面：` 之后算正面；
 * 没有小标题时按正面算。章节分隔行（`【四】…`、`── B. …`、`## …`、`方案 D：…`）
 * 会把模式重置回正面 —— 否则一处「负面」会把后面整章的服装 tag 全算成负面。
 * @returns {{positive:Array<{text:string}>, negative:Array<{text:string}>,
 *   blocks:number, dropped:number, chars:number, totalChars:number}}
 *   blocks  —— 原文一共多少块（空行分隔）
 *   dropped —— 一块里没有任何 tag 行的块数（就是那些散文块，用来算「省下了多少」）
 *   chars   —— 正面 tag 段合计多少字
 *   totalChars —— 正文一共多少字（含散文）
 */
export function parsePromptBlocks(text) {
  const { body } = promptBody(text)
  const blocks = []
  let current = []
  for (const line of body.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current)
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) blocks.push(current)
  const positive = []
  const negative = []
  let dropped = 0
  // 「正负态」跨块延续：`负面：` 后面空一行接着写 tag，仍是负面；
  // 但遇到章节标题就归零，否则一整章服装会跟着上一处「负面」变成负面。
  let mode = 'pos'
  for (const block of blocks) {
    const pos = []
    const neg = []
    for (const line of block) {
      const trimmed = line.trim()
      const head = promptHead(trimmed)
      if (head) {
        mode = head.kind
        const inline = tidyTagLine(head.inline)
        if (tagishLine(inline)) (head.kind === 'neg' ? neg : pos).push(inline)
        continue
      }
      // 章节标题：`【四】Clothes prompt`、`── B. 常服`、`▍④ CASUAL WEAR`、`## 提示词`、`方案 D：…`
      // 它本身不是 tag（几乎都带中文说明），但要把「正负态」重置回正面
      if (SECTION_RE.test(trimmed)) {
        mode = 'pos'
        continue
      }
      const tag = tidyTagLine(trimmed)
      if (!tagishLine(tag)) continue
      if (mode === 'neg') neg.push(tag)
      else pos.push(tag)
    }
    if (pos.length > 0) positive.push({ text: pos.join('\n') })
    if (neg.length > 0) negative.push({ text: neg.join('\n') })
    if (pos.length === 0 && neg.length === 0) dropped += 1
  }
  const chars = positive.reduce((sum, item) => sum + item.text.length, 0)
  return { positive, negative, blocks: blocks.length, dropped, chars, totalChars: body.trim().length }
}

// ── 按「套」切文档：一套衣服一章，章与章互斥 ───────────────────────────────
// 真实提示词文档里，一套衣服就是一章：`── ① 常服`、`▍② ROOM WEAR（部屋着）`、`一、校服（meguru_school）`。
// 这些章是互斥的 —— 五套同时并进 prompt，编码器就收到互相打架的服装词（white shirt + maid + waitress
// + china dress 全在），画出来「不知道穿什么」。所以先切组，再一次只挑一组。

/** 开一个新组的标题行（L1）：`── ① …`、`── A. …`、`① …`、`一、…`、`▍…`、`【…】`、`# …`、`方案 A：…` */
const GROUP_L1_RES = [
  /^[-─]{2,}\s*[①②③④⑤⑥⑦⑧⑨⑩]/u,
  /^[-─]{2,}\s*[A-Z]\.\s/u,
  /^[①②③④⑤⑥⑦⑧⑨⑩][\s.、·]/u,
  /^[一二三四五六七八九十]、/u,
  /^▍/u,
  /^【[^】]*】/u,
  /^#{1,6}\s+/u,
  /^方案\s*[A-Z0-9一二三四五六七八九十]/u,
  /^[A-Z]\.\s/u,
]
/** 组内子块：`【主块】`/`基础结构：` 是正文本身，`【+ 鞋】` 要追加到主块末尾（作者明写「配件块直接接在主块后」） */
const GROUP_L2_MAIN_RE = /^(?:[【[]\s*主[^】\]]*[】\]]|主块\s*[:：]?|基础结构\s*[:：]?)$/u
const GROUP_L2_ADD_RE = /^(?:[【[]\s*[+＋][^】\]]*[】\]]|要?加上\s*[:：]?)$/u
/** 可选项 / 换装变体：不是这一套的正文，丢掉（否则同一套会有两个版本互相打架） */
const GROUP_L2_ALT_RE = /^(?:可选加|可选|变体|只要|如果想|若是|换成)[^。！？]{0,24}[:：]/u
/** `※ 完整可用 prompt` / `【拿来就用】`：质量前缀 + 场景的重复品，并进去等于把同一件事说两遍 */
const GROUP_L2_FULL_RE = /完整\s*(?:可用)?\s*prompt|拿来就用|可直接复制/iu
const GROUP_NOTE_RE = /^[※★◇◆]/u
/** 组里带质量前缀的，说明它是「完整 prompt」而不是「纯服装 tag」 */
const GROUP_QUALITY_RE = /masterpiece|best quality|amazing quality|very aesthetic/i
/** 元信息章：讲模型 / 参数 / 踩坑的，不是服装，永远不参与挑选 */
const GROUP_META_RE = /模型|作者原话|参数|踩坑|四个坑|一句话|速查|对照|替换表|对照表|使用规则|换装与串味/u
/** 角色本体章：发色/瞳色/触发词，必须永远并进去（去掉会掉还原度） */
const GROUP_ANCHOR_RE = /共通|common|锚点|角色本体|identity|基础结构/i
/** 用户明确在说「穿什么」的字眼：命中它却没认出服装，就该明说「文档里没有这套」而不是抓一套凑数 */
const OUTFIT_INTENT_RE = /穿|衣|服|装|裙|鞋|帽|cos|outfit|clothes|wear|uniform|dress|shirt|skirt|bikini|swimsuit/i

/**
 * 服装同义词桶：文档写「私服」、用户说「便服」，得能对上。
 * 只收真实文档里出现过的写法（不是通用词典），命中靠「归一后互相包含」。
 */
export const OUTFIT_BUCKETS = [
  ['常服', '私服', '便服', '日常服', 'casual', 'private clothes', 'daily'],
  ['制服', '校服', 'school uniform', '水手服'],
  ['女仆', '女仆装', 'maid', 'maid outfit'],
  ['服务员', '服务生', 'waitress'],
  ['旗袍', 'china dress', 'chinese clothes'],
  ['外套', '大衣', 'coat', 'jacket'],
  ['睡衣', '家居服', '部屋着', 'roomwear', 'pajamas'],
  ['战斗服', '战斗', 'battle', 'cosplay', '狼耳', '万圣节', '魔女服', '比基尼', 'bikini', '泳装'],
]

/** 归一到可以互相包含比较的形态：去掉分隔符与括号，全角转半角 */
function outfitKey(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-·・./\\、，,|｜+＋()（）[\]【】]/gu, '')
}

/** 两个说法是不是同一套衣服（同桶 / 互相包含） */
function sameOutfit(a, b) {
  const x = outfitKey(a)
  const y = outfitKey(b)
  if (x === '' || y === '') return false
  if (x.includes(y) || y.includes(x)) return true
  for (const bucket of OUTFIT_BUCKETS) {
    const hitX = bucket.some((item) => { const z = outfitKey(item); return z.length >= 2 && x.includes(z) })
    const hitY = bucket.some((item) => { const z = outfitKey(item); return z.length >= 2 && y.includes(z) })
    if (hitX && hitY) return true
  }
  return false
}

/** 组名里的可选名字：`▍① SCHOOL UNIFORM（制服）` → `SCHOOL UNIFORM`、`制服`；`── A. 常服 · 半身像` → `常服`、`半身像` */
function groupNames(head) {
  const text = typeof head === 'string' ? head.trim() : ''
  if (text === '') return []
  const names = []
  // 只收「小括号」里的别名（`▍① SCHOOL UNIFORM（制服）`），`（配合旗袍或常服）` 这种
  // 括号里是用法说明、以「配合/去掉/想去/注意」开头，不算别名。
  const parens = [...text.matchAll(/[（(]([^）)]*)[）)]/gu)]
    .map((m) => m[1])
    .filter((p) => !/^(?:配合|去掉|想去|注意|换掉|非原|要|应|见|作者|不加)/u.test(p.trim()))
  const main = text
    .replace(HEAD_DECOR_RE, '')
    .replace(/^[─\-—=▍【[\]()\s]+/u, '')
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩一二三四五六七八九十]+\s*[、.．·]?\s*/u, '')
    .replace(/^方案\s*[A-Z0-9]+\s*[:：]\s*/iu, '')
    .replace(/^[A-Z][.、]\s*/u, '')
    .replace(/[（(][^）)]*[）)]/gu, ' ')
    .replace(/[─\-—=【】[\]]+/gu, ' ')
    .replace(/[：:]\s*$/u, '')
    .trim()
  // 组名可能写成一串：`belle_anima_v1, school`（触发词 + 服装名）、`常服 · 半身像`（服装 + 构图）。
  // 逗号 / 中点是分隔，空格不是（`SCHOOL UNIFORM`、`school uniform` 是一个词）。
  for (const piece of main.split(/\s*[·,，]\s*/u)) if (piece.trim()) names.push(piece.trim())
  for (const group of parens) {
    for (const piece of group.split(/[/／·・|｜、]/u)) {
      const item = piece.trim()
      if (item !== '' && item.length <= 16 && !/[。！？]/u.test(item)) names.push(item)
    }
  }
  return [...new Set(names)]
}

/** 行首的中文服装标签：`军装 peaked cap, …` → `军装`（这一行其实是一个组里的「一套」） */
function lineOutfitLabel(line) {
  const match = /^([\u3400-\u9FFF\u3040-\u30FF]{1,6})\s+(?=[A-Za-z0-9])/u.exec(line)
  if (!match) return ''
  if (/^(?:可选|只要|变体|注意|基础|通用|角色|负面|作者|建议|这套|混写|四套|五套)/u.test(match[1])) return ''
  return match[1]
}

/** 软标题：`Base outfit` / `Summer Skies` / `belle_anima_v1, school` —— 短、无标点、下一行就是 tag（铃那种文档全靠这条） */
function softGroupHead(line, next) {
  const t = typeof line === 'string' ? line.trim() : ''
  if (t.length < 2 || t.length > 40) return false
  if (/[:：。！？]/u.test(t)) return false
  if (/\S {2,}\S/u.test(t)) return false
  if (tagishLine(t)) return false
  if (!tagishLine(next)) return false
  // 「触发词, 服装名」两段式软标题（belle_anima_v1, school）：两段都必须是单个词、不含空格。
  // `brown hair, green eyes` 两段都含空格，是 tag 串不是标题。
  if (/[,，]/u.test(t)) {
    const parts = t.split(/[,，]/u).map((s) => s.trim()).filter(Boolean)
    if (parts.length !== 2) return false
    return parts.every((p) => p.length <= 20 && !/\s/u.test(p))
  }
  if (/[,，、;；]/u.test(t)) return false
  return true
}

/**
 * 把文档切成「组」：每组是一套服装（或一个角色本体/元信息章）。
 * 行级判定顺序是固定的 —— `※ 完整可用 prompt` 必须先按 full 处理再按 note 处理，
 * 否则那一整条会被当成主块并进去（绫地宁宁 ① 会从 488 字涨到 979 字）。
 * @returns {{groups:Array<{index:number, head:string, text:string, chars:number, neg:string,
 *   quality:boolean, meta:boolean, anchor:boolean, names:string[],
 *   units:Array<{label:string, text:string}>}>, blocks:number, dropped:number, totalChars:number}}
 */
export function parseOutfitGroups(text) {
  const { body } = promptBody(text)
  const lines = body.split('\n')
  const groups = []
  const segmentTags = []
  let tagsInSegment = 0
  let blank = true
  let current = null
  let part = 'main'
  let mode = 'pos'
  const open = (head) => {
    current = { index: groups.length, head: String(head ?? ''), main: [], add: [], neg: [], units: [] }
    groups.push(current)
    part = 'main'
  }
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed === '') {
      if (!blank) { segmentTags.push(tagsInSegment); tagsInSegment = 0 }
      blank = true
      // `part` 是「块内子块」的态（主块 / 追加 / 完整 prompt / 变体 / 备注），
      // 空行代表换了一个块，part 要回到主块；但 `mode`（正负态）与 `current`（当前组）
      // 必须跨空行延续 —— `负面：` 后空一行接着写 tag 仍是负面，仍是同一套。
      part = 'main'
      continue
    }
    blank = false
    // 装饰行（`====`、`----`、`────`）只做视觉分隔，不是标题也不是内容：
    // 不改 part/mode/current —— 否则它会把紧跟其后的正文 tag 顶成 note 丢掉
    // （因幡巡文档就是「标题上下各夹一行 ====」，去掉这层就会丢整节）。
    if (DECOR_LINE_RE.test(trimmed)) continue
    const head = promptHead(trimmed)
    if (head) {
      mode = head.kind
      const inline = tidyTagLine(head.inline)
      if (tagishLine(inline)) {
        if (!current) open('')
        tagsInSegment += 1
        if (head.kind === 'neg') current.neg.push(inline)
        else current.main.push(inline)
      }
      continue
    }
    if (GROUP_L2_FULL_RE.test(trimmed)) { part = 'full'; continue }
    if (GROUP_NOTE_RE.test(trimmed)) { part = 'note'; continue }
    if (GROUP_L2_ALT_RE.test(trimmed)) { part = 'alt'; continue }
    if (GROUP_L2_ADD_RE.test(trimmed)) { part = 'add'; continue }
    if (GROUP_L2_MAIN_RE.test(trimmed)) { part = 'main'; continue }
    if (GROUP_L1_RES.some((re) => re.test(trimmed))) {
      open(trimmed)
      mode = 'pos'
      continue
    }
    const label = lineOutfitLabel(trimmed)
    const tag = tidyTagLine(trimmed)
    if (tagishLine(tag)) {
      if (!current) open('')
      tagsInSegment += 1
      if (mode === 'neg') { current.neg.push(tag); continue }
      if (part === 'full' || part === 'alt' || part === 'note') continue
      if (part === 'add') { current.add.push(tag); continue }
      current.main.push(tag)
      if (label) current.units.push({ label, text: tag })
      continue
    }
    let next = ''
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() !== '') { next = lines[j].trim(); break }
    }
    if (softGroupHead(trimmed, next)) { open(trimmed); mode = 'pos'; continue }
    part = 'note'
  }
  if (!blank) segmentTags.push(tagsInSegment)
  const final = groups.map((group) => {
    // `part === 'note'` 之后的行仍可能补进主块（`基础结构：` 下一行就是正文），但 note 里的
    // tag 已经被上面挡住了 —— 这里只负责把 main/add 拼起来
    const body2 = [...group.main, ...group.add].join('\n')
    const headless = group.head.trim() === ''
    const isAnchorHead = !headless && GROUP_ANCHOR_RE.test(group.head)
    const meta = !headless && !isAnchorHead && GROUP_META_RE.test(group.head)
    return {
      index: group.index,
      head: group.head.trim(),
      text: body2,
      chars: body2.length,
      neg: group.neg.join('\n'),
      quality: GROUP_QUALITY_RE.test(body2),
      meta,
      anchor: (headless || isAnchorHead) && group.units.length < 2,
      names: groupNames(group.head),
      units: group.units,
    }
  })
  return {
    groups: final,
    blocks: segmentTags.length,
    dropped: segmentTags.filter((count) => count === 0).length,
    totalChars: body.trim().length,
  }
}

/**
 * 挑组：先认服装名（组名/别名精确命中，压过同义词），再认同义词，
 * 再认组内行标签（矢来美羽那种「一章挂五套」）；都认不出就看用户是不是在说衣服 ——
 * 说了但文档没有 → 只并角色本体；没说 → 拿第一组当默认。
 * 锚点组（角色本体）永远并入。预算按整组装，装不下就不装（不切半套衣服）。
 */
export function chooseOutfitGroups(groups, prompt, limit) {
  const usable = groups.filter((group) => group.chars > 0 && !group.meta)
  const anchors = usable.filter((group) => group.anchor)
  const pool = usable.filter((group) => !group.anchor)
  const np = outfitKey(prompt)
  const words = promptWords(prompt)
  const scoreOf = (group) => words.reduce((sum, word) => sum + (group.text.toLowerCase().includes(word) ? 1 : 0), 0)
  const hits = []
  for (const group of pool) {
    let best = null
    for (const name of group.names) {
      const key = outfitKey(name)
      if (key.length < 2) continue
      if (np.includes(key)) { best = { rank: 0, how: 'name', name }; break }
    }
    if (!best) {
      for (const name of group.names) {
        if (sameOutfit(name, prompt)) { best = { rank: 2, how: 'synonym', name }; break }
      }
    }
    if (!best) {
      for (const unit of group.units) {
        const key = outfitKey(unit.label)
        if (key.length < 2) continue
        if (np.includes(key)) { best = { rank: 0, how: 'label', name: unit.label, unit }; break }
      }
    }
    if (!best) {
      for (const unit of group.units) {
        if (sameOutfit(unit.label, prompt)) { best = { rank: 2, how: 'label-synonym', name: unit.label, unit }; break }
      }
    }
    if (best) hits.push({ group, ...best })
  }
  let picked = []
  let how = 'none'
  let outfit = ''
  if (hits.length > 0) {
    // 精确名压过同义词；同档里先要「纯服装 tag」（别把质量前缀重复并进去），再按贴题度、字数取大
    hits.sort((a, b) => a.rank - b.rank
      || Number(a.group.quality) - Number(b.group.quality)
      || scoreOf(b.group) - scoreOf(a.group)
      || b.group.chars - a.group.chars
      || a.group.index - b.group.index)
    const best = hits[0]
    const text = best.unit ? best.unit.text : best.group.text
    picked = [{ ...best.group, text, chars: text.length }]
    how = best.how
    // 命中「组内行标签」时（矢来美羽/四季夏目那种一章挂多套），报告要说清是哪一套；
    // 命中组名时用「匹配到的那一个名字片段」——`belle_anima_v1, battle` 只说 `battle`，
    // 触发词前缀不是服装名。
    outfit = best.unit ? best.unit.label : (best.name || best.group.head)
  } else if (OUTFIT_INTENT_RE.test(prompt)) {
    how = 'none'
  } else {
    // 没点名服装：并锚点 + 第一套。若第一组是「一章挂多套」的 units 组，取它的第一个 unit 当默认。
    const firstUnitGroup = pool.find((group) => group.units.length > 0)
    const firstSingle = pool.find((group) => group.units.length < 2)
    if (firstUnitGroup && firstSingle && firstSingle.index < firstUnitGroup.index) {
      picked = [firstSingle]; how = 'first'; outfit = firstSingle.head
    } else if (firstUnitGroup) {
      const unit = firstUnitGroup.units[0]
      picked = [{ ...firstUnitGroup, text: unit.text, chars: unit.text.length }]
      how = 'first'
      outfit = unit.label
    } else if (firstSingle) {
      picked = [firstSingle]; how = 'first'; outfit = firstSingle.head
    }
  }
  // 说了服装但文档里没有、而且这篇连角色本体章都没有：至少给一套默认的，别整篇白读
  if (picked.length === 0 && anchors.length === 0) {
    const singles = pool.filter((group) => group.units.length < 2)
    if (singles.length > 0) { picked = [singles[0]]; how = 'none'; outfit = singles[0].head }
  }
  const ordered = [...anchors, ...picked].sort((a, b) => a.index - b.index)
  let used = 0
  const kept = []
  const skipped = []
  for (const group of ordered) {
    if (used + group.chars <= limit) { kept.push(group); used += group.chars }
    else skipped.push(group)
  }
  const negatives = []
  for (const group of kept) {
    for (const item of group.neg.split(/[,，\n]+/u)) {
      const value = item.trim()
      if (value !== '' && !negatives.some((old) => old.toLowerCase() === value.toLowerCase())) negatives.push(value)
    }
  }
  return { kept, skipped, used, how, outfit, anchorChars: anchors.reduce((sum, g) => sum + g.chars, 0), negative: negatives.join(', ') }
}

/** 用户 prompt 里的实词：用来判断「这段 tag 与这次要画的东西有多相关」 */
const PROMPT_STOP_WORDS = new Set([
  'the', 'and', 'with', 'very', 'girl', 'solo', 'best', 'quality', 'masterpiece',
  'looking', 'viewer', 'portrait', 'high', 'low', 'anime', 'illustration',
])

/** 'masterpiece, best quality, silver hair' → ['silver','hair'] */
export function promptWords(prompt) {
  const text = typeof prompt === 'string' ? prompt : ''
  const words = text
    .toLowerCase()
    .split(/[,，、;；\n]/)
    .flatMap((seg) => seg.replace(/[(){}[\]:]/g, ' ').trim().split(/\s+/))
    // 纯数字/纯权重的段（`1.2`、`0.8`）不是内容词，别拿它去给段打相关度
    .filter((word) => word.length >= 3 && !/^[\d.]+$/.test(word) && !PROMPT_STOP_WORDS.has(word))
  return [...new Set(words)]
}

/** 把一段 tag 切成集合，用来判断两段是不是「基本同一件事」 */
function tagSetOf(text) {
  return new Set(
    text.toLowerCase().split(/[,，、;；\n]/).map((item) => item.trim()).filter((item) => item.length >= 2),
  )
}

/** 两段 tag 的重合度：按较大那段的规模归一，避免「三个词的短段」把整篇都判成重复 */
function tagOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const item of a) if (b.has(item)) inter += 1
  return inter / Math.max(a.size, b.size)
}

/**
 * 在预算内挑 tag 段：先按与用户 prompt 的词重合度排序（重合多的优先，服装/发型更贴题），
 * 再按原文顺序拼回去（保持文档的写法），预算装不下就跳过最不相关的那段。
 * prompt 为空时退化成「按原文顺序取」——comfy_review 没有用户 prompt 走这条路。
 *
 * 兜底：如果一段都装不下（只有一段、而且它本身就超预算，常见于「一整行几百个 tag」的文档），
 * 就取最贴题的那一段、按边界收口切到预算内 —— 绝不能因为「装不下」而整篇不并。
 *
 * @returns {{text:string, picked:number, total:number, chars:number, unpicked:string[], partial:boolean}}
 *   partial=true 表示唯一挑中的那段本身超预算、被按边界切了一刀（其余情况不会切）
 */
export function pickPromptBlocks(positive, { maxChars = LORA_DOC_MAX_CHARS, prompt = '' } = {}) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : LORA_DOC_MAX_CHARS
  const words = promptWords(prompt)
  const scored = positive.map((block, index) => {
    const lower = block.text.toLowerCase()
    let score = 0
    for (const word of words) {
      if (lower.includes(word)) score += Math.min(4, word.length)
    }
    return { ...block, index, score, tags: tagSetOf(block.text) }
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  const picked = []
  const unpicked = []
  let used = 0
  for (const cand of scored) {
    if (used + cand.text.length > limit) {
      unpicked.push(cand.text)
      continue
    }
    // 已经选过一段高度重合的：换装示例/重复列举，跳过（预算留给别的）
    const duplicate = picked.some((item) => tagOverlap(item.tags, cand.tags) >= 0.5 && cand.score <= item.score)
    if (duplicate) {
      unpicked.push(cand.text)
      continue
    }
    picked.push(cand)
    used += cand.text.length
  }
  // 一段都装不下：拿最贴题的那段按边界切，别让整篇白读
  let partial = false
  if (picked.length === 0 && scored.length > 0) {
    const best = scored[0]
    const cut = extractPromptSection(best.text, { maxChars: limit })
    if (cut.text.length > 0) {
      picked.push({ ...best, text: cut.text })
      used = cut.text.length
      partial = cut.truncated === true
      const rest = best.text.slice(cut.text.length)
      unpicked.length = 0
      for (const item of scored) unpicked.push(item === best ? rest : item.text)
    }
  }
  picked.sort((a, b) => a.index - b.index)
  return {
    text: picked.map((item) => item.text).join('\n\n'),
    picked: picked.length,
    total: scored.length,
    chars: used,
    unpicked,
    partial,
  }
}

/**
 * 取一段「真正该并进 prompt」的正文：优先按「套」挑（一次只并一套服装 + 角色本体），
 * 文档里一个 tag 行都没有时才退回「整段按边界收口」（extractPromptSection），保证旧行为不丢。
 *
 * @returns {{mode:'tags'|'plain', text:string, negative:string, heading:string,
 *   totalChars:number, tagChars:number, keptChars:number, cut:string, truncated:boolean,
 *   blocks:number, dropped:number, picked:number, pickedTotal:number, unpicked:string[],
 *   negativeChars:number, outfit:string, how:string, anchorChars:number, skippedGroups:string[]}}
 *   mode='tags'  → text 是「角色本体 + 一套服装」拼出来的；cut 无意义
 *   mode='plain' → text 是整段按边界收口的结果，cut 说明切在哪种边界
 *   outfit       → 挑中的那套服装（组名），how='none' 时为空
 *   how          → 'name' 组名精确命中 / 'synonym' 同义词命中 / 'label' 组内行标签命中
 *                  / 'label-synonym' / 'first' 没点名用了第一套 / 'none' 点名了但文档里没有
 *   truncated    → 「预算装不下，有组没并进去」（skippedGroups 非空）
 */
export function composeDocSection(text, { maxChars = LORA_DOC_MAX_CHARS, prompt = '' } = {}) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : LORA_DOC_MAX_CHARS
  const parsed = parseOutfitGroups(text)
  const { heading } = promptBody(text)
  const usable = parsed.groups.filter((group) => group.chars > 0 && !group.meta)
  const pool = usable.filter((group) => !group.anchor)
  const negativeOf = (groups) => {
    const out = []
    for (const group of groups) {
      for (const item of group.neg.split(/[,，\n]+/u)) {
        const value = item.trim()
        if (value !== '' && !out.some((old) => old.toLowerCase() === value.toLowerCase())) out.push(value)
      }
    }
    return out.join(', ')
  }
  // 没有可挑的「套」（整篇只有一个 tag 块，或只有角色本体）：走整段按边界收口，
  // 负面照旧保留。这种文档不存在「多套服装打架」的问题，按套挑是多余的。
  if (pool.length === 0) {
    // 连一个 tag 组都没有（纯散文）→ 退回「整篇按边界收口」的旧行为；
    // 有 tag 组但都是锚点/单段 → 只收那一段 tag，负面照旧。
    const source = usable.length > 0
      ? usable.map((group) => group.text).join('\n\n')
      : text
    const negative = negativeOf(usable)
    const section = extractPromptSection(source, { maxChars: limit })
    return {
      mode: 'plain',
      text: section.text,
      negative,
      heading,
      totalChars: parsed.totalChars,
      tagChars: usable.reduce((sum, group) => sum + group.chars, 0),
      keptChars: section.keptChars,
      cut: section.cut,
      truncated: section.truncated === true,
      blocks: parsed.blocks,
      dropped: parsed.dropped,
      picked: 0,
      pickedTotal: 0,
      unpicked: [],
      negativeChars: negative.length,
      outfit: '',
      how: 'none',
      anchorChars: 0,
      skippedGroups: [],
    }
  }
  const chosen = chooseOutfitGroups(parsed.groups, prompt, limit)
  const pickedOutfit = chosen.kept.filter((group) => !group.anchor)
  // 「没并的套」= 所有没被挑中的服装组（不是预算 skip 的口径）—— k32 一次只挑一套，
  // 多套文档必然有「没并的套」，rest:true 和结果文案要能把它列出来。
  const keptIndices = new Set(chosen.kept.map((group) => group.index))
  const restOutfits = pool.filter((group) => !keptIndices.has(group.index))
  return {
    mode: 'tags',
    text: chosen.kept.map((group) => group.text).join('\n\n'),
    negative: chosen.negative,
    heading,
    totalChars: parsed.totalChars,
    tagChars: usable.reduce((sum, group) => sum + group.chars, 0),
    keptChars: chosen.used,
    cut: '',
    truncated: restOutfits.length > 0 || chosen.skipped.length > 0,
    blocks: parsed.blocks,
    dropped: parsed.dropped,
    picked: pickedOutfit.length,
    pickedTotal: pool.length,
    unpicked: restOutfits.map((group) => group.text),
    negativeChars: chosen.negative.length,
    outfit: chosen.outfit,
    how: chosen.how,
    anchorChars: chosen.anchorChars,
    skippedGroups: restOutfits.map((group) => group.head),
  }
}

/** 把名字切成词：'Belle Anima v1' → ['belle','anima','v1'] */
export function nameTokens(name) {
  return normalizeLoraKey(name).split('_').filter((token) => token.length > 0)
}

// ── 角色别名：把「人说的话」对上「LoRA 文件」 ────────────────────────────────
// LoRA 文件名可能是英文、罗马音、拼音或纯编号（natsume-000016、tenshi_amane），
// 用户说的是中文（四季夏目）或日文（四季 ナツメ）。直接把两者对撞是对不上的，
// 但文档标题行里几乎都写着「中文（日文 / 罗马音）」—— 那就是现成的对照表。
// 这里只从**已有证据**里取别名（文档标题、文档文件名、LoRA 文件名），不引入词典。

/** 别名匹配时不算数的词：模型泛称、文档体裁词、后缀 */
const ALIAS_STOP_WORDS = new Set([
  'anima', 'anime', 'base', 'lora', 'loras', 'illustrious', 'safetensors', 'ckpt', 'model',
  'models', 'version', 'prompt', 'prompts', 'checkpoint', 'diffusers', 'sdxl', 'best',
  'solo', 'girl', 'girls', 'resolution', 'quality',
  // 文档体裁词 / 小节名，出现在文件名或标题里但没有角色信息
  'trigger', 'words', 'outfit', 'clothes', 'wear', 'variant', 'image',
  '提示词', '提示词清单', '模型', '清单', '手册', '整理', '说明', '建议', '参数', '作者',
  '底模', '示例', '用法', '注意', '备注', '一句话', '总结', '对照', '速查',
])

/** 装饰行：`====`、`----`、`####`、`****` 这类不是标题 */
const DECOR_LINE_RE = /^[=\-─═#*_\s]{3,}$/

/**
 * 归一化一条别名或一句提示词，用来做「包含」判断。
 * 全角转半角、小写、去掉所有分隔符 —— 'Shiki Natsume' 与 'shiki_natsume' 都变成
 * 'shikinatsume'，这样空格/下划线/中点的写法差异不会影响匹配。
 */
export function normalizeAlias(text) {
  const raw = typeof text === 'string' ? text : ''
  return raw.normalize('NFKC').toLowerCase().replace(/[\s_\-·・./\\、，,|｜]+/g, '')
}

/** 一个词够不够当别名的料（停用词、纯数字、太短的英文都不要） */
function usableAlias(word) {
  const token = typeof word === 'string' ? word.trim() : ''
  if (token.length === 0) return false
  if (ALIAS_STOP_WORDS.has(token.toLowerCase())) return false
  if (/^[\d.\-_]+$/.test(token)) return false
  if (/^v\d+(?:\.\d+)*$/i.test(token)) return false
  if (/[\u3400-\u9FFF\u3040-\u30FF]/.test(token)) return token.length >= 1
  return token.length >= 3
}

/** 把一段标题切成候选别名（整段 + 按空白切开的词） */
function aliasFromPiece(piece, out) {
  const text = typeof piece === 'string' ? piece.trim() : ''
  if (text.length === 0) return
  if (usableAlias(text)) out.push(text)
  for (const word of text.split(/\s+/)) {
    if (word === text) continue
    if (usableAlias(word)) out.push(word)
  }
}

/**
 * 从文档开头几行里读「角色别名」。
 * 实测的长文档第 2 行几乎都是 `四季夏目（四季 ナツメ / Shiki Natsume）Anima LoRA 提示词清单`
 * 这种写法 —— 括号外是中文，括号里是日文与罗马音（繁简两种中文也常并排出现）。
 *
 * @returns {{line:string, aliases:string[]}}
 *   line    → 取到的那一行（没找到时为空串，方便报告「为什么没认出来」）
 *   aliases → 中文 / 日文 / 罗马音候选，顺序为「标题本体 → 括号里的各段 → 各段的词」
 */
export function docAliases(text) {
  const body = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  const out = []
  const scan = lines.slice(0, 12)
  // 只认「第一行非装饰行」，或者退一步认第一个 Markdown 标题。
  // 不能一路往下找短行：`绝区零 铃.txt` 是「一行英文说明 + 小节名 Base outfit」的结构，
  // 把 `Base outfit` / `outfit` 当别名会让「summer outfit」这种 prompt 误命中角色 LoRA。
  const first = scan.find((line) => !DECOR_LINE_RE.test(line)) ?? ''
  const heading = scan.find((line) => /^#{1,6}\s+\S/u.test(line)) ?? ''
  for (const line of [first, heading]) {
    if (line.length === 0) continue
    const paren = line.match(/[（(]([^）)]{2,160})[）)]/u)
    if (paren && /[\u3400-\u9FFF\u3040-\u30FF]/.test(line)) {
      const head = line.slice(0, paren.index).trim()
      if (head.length > 0) aliasFromPiece(head, out)
      for (const part of paren[1].split(/[/／·・|｜、]/u)) aliasFromPiece(part, out)
      return { line, aliases: dedupeAliases(out) }
    }
    // 没有括号：短标题、不是成句的说明，才当标题用
    if (line.length > 60) continue
    if (/[。！？!?]$/.test(line)) continue
    if (/^(?:use|add|note|tips?)\b/i.test(line)) continue
    // 纯 ASCII 的短行分为「名字」（全小写 tsuyuri kanao / deepseek）与「小节名」
    //（Base outfit / Summer Skies 这种给服装命名的小标题）—— 只收前者，别把小节名当角色
    const words = line.split(/\s+/).filter(Boolean)
    const asciiOnly = !/[\u3400-\u9FFF\u3040-\u30FF]/.test(line)
    if (asciiOnly && words.length > 1 && !words.every((w) => w === w.toLowerCase() || w === w.toUpperCase())) continue
    const head = line.split(/[:：]/u)[0].trim()
    if (head.length === 0) continue
    aliasFromPiece(head, out)
    return { line, aliases: dedupeAliases(out) }
  }
  return { line: '', aliases: dedupeAliases(out) }
}

/** 别名去重（按归一化后的形式比），保留先出现的写法 */
function dedupeAliases(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = normalizeAlias(item)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 一个 LoRA 文件都有哪些叫法。三个来源，按可靠性排序：
 *   1. 文件名自身的词（tenshi_amane → tenshi / amane）
 *   2. **同一个文件夹里**那篇文档的标题别名（natsume-000016.safetensors 与
 *      `四季夏目_Anima_LoRA_提示词清单.txt` 并排摆放 → 中文/日文/罗马音全拿到）
 *   3. 文档文件名本身（`栗花落香奈乎.txt`、`绝区零 铃.txt`）
 *
 * @param {string} file LoRA 文件名
 * @param {Array<{stem:string, raw:string, siblings?:string[]}>} docs 同目录下的文档
 * @returns {{file:string, aliases:string[], sources:{file:string[], docs:string[]}}}
 */
export function loraAliases(file, docs = []) {
  const key = normalizeLoraKey(file)
  const fromFile = []
  for (const token of key.split('_')) {
    if (usableAlias(token)) fromFile.push(token)
  }
  const fromDocs = []
  for (const doc of Array.isArray(docs) ? docs : []) {
    const siblings = Array.isArray(doc?.siblings) ? doc.siblings : []
    if (!siblings.includes(key)) continue
    const stem = typeof doc?.stem === 'string' ? doc.stem : ''
    if (stem.length > 0) {
      for (const piece of stem.split(/[\s_\-]+/u)) {
        if (usableAlias(piece)) fromDocs.push(piece)
      }
      const cjkRuns = stem.match(/[\u3400-\u9FFF\u3040-\u30FF]{1,}/gu) ?? []
      for (const run of cjkRuns) {
        if (usableAlias(run)) fromDocs.push(run)
      }
    }
    for (const alias of docAliases(doc?.raw ?? '').aliases) fromDocs.push(alias)
  }
  return {
    file,
    aliases: dedupeAliases([...fromFile, ...fromDocs]),
    sources: { file: dedupeAliases(fromFile), docs: dedupeAliases(fromDocs) },
  }
}

/**
 * 按 prompt 里的角色名挑一个 LoRA。**只认唯一命中**：认不出就不猜，认出多个也不猜
 * （一句话画两个角色的情况交给调用方去问人）。
 *
 * @param {string} prompt 用户这次的正面提示词
 * @param {string[]} loras `index.loras` 的文件名列表
 * @param {Array<{stem:string, raw:string, siblings?:string[]}>} docs 文档目录里的文档
 * @returns {{pick:string, candidates:Array<{file:string, aliases:string[], hit:string[]}>,
 *   reason:string, considered:number}}
 */
export function matchLoraForPrompt(prompt, loras = [], docs = []) {
  const hay = normalizeAlias(prompt)
  const list = Array.isArray(loras) ? loras : []
  const candidates = []
  for (const file of list) {
    if (typeof file !== 'string' || file.trim().length === 0) continue
    const table = loraAliases(file, docs)
    const hit = []
    for (const alias of table.aliases) {
      const needle = normalizeAlias(alias)
      if (needle.length === 0) continue
      const longEnough = needle.length >= 2
        || /[\u3400-\u9FFF\u3040-\u30FF]/.test(needle)
      if (!longEnough) continue
      if (hay.includes(needle)) hit.push(alias)
    }
    if (hit.length > 0) candidates.push({ file, aliases: table.aliases, hit: dedupeAliases(hit) })
  }
  if (candidates.length === 1) {
    return { pick: candidates[0].file, candidates, reason: `按「${candidates[0].hit.join('、')}」认出`, considered: list.length }
  }
  if (candidates.length === 0) {
    return { pick: '', candidates, reason: '没在 prompt 里认出角色名', considered: list.length }
  }
  return {
    pick: '',
    candidates,
    reason: `认出了 ${candidates.length} 个候选，不替你猜`,
    considered: list.length,
  }
}

/**
 * 当前绘图配置 —— 给模型看的那几行。模型看不见输入框左侧的控件，只能靠这里。
 * 没有这个，它就会凭世界知识猜「用 Illustrious 更懂 danbooru tag」这种事。
 *
 * @param {{draw:{unet:string, lora:boolean}, loraDocs:{dir:string, maxChars:number}}} features
 * @param {Record<string, string[]>} index `client.modelIndex()` 的结果
 * @returns {string[]}
 */
export function describeDrawConfig(features, index = {}) {
  const draw = features?.draw ?? {}
  const docs = features?.loraDocs ?? {}
  const lines = []
  const fixed = typeof draw.unet === 'string' ? draw.unet.trim() : ''
  if (fixed.length > 0) {
    lines.push(`生图模型：${fixed}（固定，comfy_run 传 unet 不会覆盖）`)
  } else {
    const diffusion = (index?.diffusion_models ?? [])[0]
    const checkpoint = (index?.checkpoints ?? [])[0]
    const fallback = diffusion ?? checkpoint
    lines.push(fallback
      ? `生图模型：自动（会用 ${fallback}）`
      : '生图模型：自动（diffusion_models 与 checkpoints 都是空的，得先装模型）')
  }
  lines.push(draw.lora === true
    ? 'LoRA：允许挂'
    : 'LoRA：已关（传 lora 会被拒绝 —— 要在输入框左侧的绘图控件里点开）')
  const dir = typeof docs.dir === 'string' ? docs.dir.trim() : ''
  lines.push(dir.length > 0
    ? `提示词文档：${dir}（字数预算 ${docs.maxChars}；挂了 LoRA 会自动把里面挑中的 tag 段并进 prompt）`
    : '提示词文档：没配目录（挂了 LoRA 也不会读文档）')
  return lines
}

/** 内容像不像「逗号分隔的提示词」，而不是一大段说明文字 */
export function looksLikePrompt(text) {
  const body = typeof text === 'string' ? text : ''
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length === 0) return false
  const separators = (body.match(/[,，、]/g) ?? []).length
  if (separators < 3) return false
  // 成句的说明文字：过半的行以句号/问号/叹号收尾，那就不是 tag 串
  const sentences = lines.filter((line) => /[。！？!?]$/.test(line)).length
  if (sentences * 2 >= lines.length) return false
  // tag 串的每一段都短（英文 tag 直接用整段判定）；成段叙述的每一段都长
  const segments = body.split(/[,，、\n]/).map((item) => item.trim()).filter((item) => item.length > 0)
  if (segments.length === 0) return false
  const tagLike = segments.filter((item) => /^[\x20-\x7E]+$/.test(item) || item.length <= 6).length
  return tagLike * 10 >= segments.length * 6
}

/** 文档的第一行标题（没有 `#` 就用第一行非空行）—— 角色说明通常把它当标题写 */
export function docTitle(text) {
  const body = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    return trimmed.replace(/^#{1,6}\s*/, '').trim()
  }
  return ''
}

/**
 * 给一篇文档打分：这个 LoRA 该不该用它。
 * 分数只用于排序与「够不够格」判断，各项权重都集中在这里，改起来一目了然。
 * 注意文件名只是「一个信号」，不再是门槛 —— 名字完全不对、正文里提到了也照样能挑中。
 * @returns {{score:number, reasons:string[], section:{text:string,truncated:boolean,heading:string,totalChars:number,keptChars:number,cut:string},
 *   promptish:boolean, hasPromptHeading:boolean, title:string}}
 */
export function scoreDocForLora(doc, text, loraName, options = {}) {
  const reasons = []
  let score = 0
  const raw = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  const section = extractPromptSection(raw, { maxChars: options.maxChars })
  const hasPromptHeading = section.heading.length > 0
  const title = docTitle(raw)
  const loraKey = normalizeLoraKey(loraName)
  const loraTokens = nameTokens(loraName)
  const stemKey = typeof doc?.key === 'string' && doc.key.length > 0
    ? doc.key
    : normalizeLoraKey(doc?.stem ?? doc?.name ?? '')
  const stemTokens = stemKey.split('_').filter((token) => token.length > 0)
  // 子目录名也算文件名信号的一部分：`belle_anima_v1/角色.md` 与 `belle_anima_v1.md` 同等对待
  const relKey = typeof doc?.rel === 'string' && doc.rel.length > 0
    ? normalizeLoraKey(doc.rel.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[\\/]/g, ' '))
    : stemKey

  if (loraKey.length > 0) {
    // ⓪ 摆放：文档和这个 LoRA 的模型文件在同一个文件夹里 —— 最硬的配对证据。
    //    「一个角色一个文件夹、模型与提示词并排放」是常见整理习惯，名字怎么起都不影响判断。
    const siblings = Array.isArray(doc?.siblings) ? doc.siblings : []
    if (siblings.includes(loraKey)) {
      const oneToOne = siblings.length === 1
      score += oneToOne ? 120 : 60
      reasons.push(oneToOne ? '和这个 LoRA 摆在同一个文件夹' : '所在文件夹里有这个 LoRA（文件夹里还有别的模型）')
    }
    // ① 文件名（含子目录名）：完全一致 > 互相包含 > 命中几个词
    //    互相包含只在短的那边够长时才算 —— 否则名字叫「a.md」的文档会因为含字母 a 就白拿 70 分
    const shorter = stemKey.length <= loraKey.length ? stemKey : loraKey
    const longer = stemKey.length <= loraKey.length ? loraKey : stemKey
    const relHit = relKey.length >= 3 && relKey !== stemKey && relKey.includes(loraKey)
    if (stemKey === loraKey) {
      score += 100
      reasons.push('文件名与 LoRA 名一致')
    } else if (shorter.length >= 3 && longer.includes(shorter)) {
      score += 70
      reasons.push('文件名包含 LoRA 名')
    } else if (relHit) {
      score += 70
      reasons.push('所在文件夹名与 LoRA 名一致')
    } else if (loraTokens.length > 0) {
      const hit = loraTokens.filter((token) => stemTokens.includes(token)).length
      if (hit > 0) {
        score += Math.round(60 * (hit / loraTokens.length))
        reasons.push(`文件名命中 ${hit}/${loraTokens.length} 个词`)
      }
    }
    // ② 正文：把空格/下划线/连字符抹平后找 LoRA 名（"Belle Anima v1" 也能命中）
    const flat = raw.toLowerCase().replace(/[\s_\-]+/g, '_')
    if (flat.includes(loraKey)) {
      score += 30
      reasons.push('正文提到 LoRA 名')
    } else if (loraTokens.length > 0) {
      const hit = loraTokens.filter((token) => flat.includes(token)).length
      if (hit > 0) {
        score += Math.round(12 * (hit / loraTokens.length))
        reasons.push(`正文命中 ${hit}/${loraTokens.length} 个词`)
      }
    }
    // ③ 标题：角色说明最常把 LoRA 名写在第一行
    const titleKey = normalizeLoraKey(title)
    if (titleKey.length > 0) {
      if (titleKey === loraKey) {
        score += 35
        reasons.push('标题就是 LoRA 名')
      } else if (titleKey.includes(loraKey)) {
        score += 25
        reasons.push('标题包含 LoRA 名')
      }
    }
  }

  // ④ 形态：有「提示词」小标题、或者内容本来就是逗号分隔的 tag
  if (hasPromptHeading) {
    score += 20
    reasons.push('有「提示词」小标题')
  }
  const promptish = looksLikePrompt(section.text.length > 0 ? section.text : raw)
  if (promptish) {
    score += 12
    reasons.push('内容像提示词')
  }

  return { score, reasons, section, promptish, hasPromptHeading, title }
}

/**
 * 逐篇读入候选文档并打分，按分数从高到低排（同分按文件名，结果可复现）。
 * 读不了的文件进 skipped，不抛。受 LORA_DOC_SCAN_LIMIT / LORA_DOC_SCAN_BYTES 约束；
 * 超限停下时把没读到的文件名放进 notScanned 并记 stoppedBy，不再静默。
 * @returns {{candidates:Array, scanned:number, total:number, skipped:string[],
 *   stoppedBy:''|'limit'|'budget', notScanned:string[]}}
 */
export async function rankLoraDocs(docs, loraName, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : LORA_DOC_SCAN_LIMIT
  const budget = Number.isInteger(options.budget) && options.budget > 0 ? options.budget : LORA_DOC_SCAN_BYTES
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : LORA_DOC_MAX_CHARS
  const list = Array.isArray(docs) ? docs : []
  const candidates = []
  const skipped = []
  let scanned = 0
  let spent = 0
  let stoppedBy = ''
  for (const doc of list) {
    if (scanned >= limit || spent >= budget) {
      stoppedBy = scanned >= limit ? 'limit' : 'budget'
      break
    }
    let raw = ''
    try {
      raw = await readFile(doc.file, 'utf8')
    } catch (error) {
      skipped.push(`${doc?.name ?? doc?.file ?? '?'}：${error?.code ?? error?.message ?? error}`)
      continue
    }
    scanned += 1
    spent += Buffer.byteLength(raw, 'utf8')
    candidates.push({ doc, ...scoreDocForLora(doc, raw, loraName, { maxChars }), raw })
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(a.doc?.name ?? '').localeCompare(String(b.doc?.name ?? ''))
  })
  // stoppedBy 非空时，扫描停下的位置之后还有文档没参与打分
  const notScanned = stoppedBy === '' ? [] : list.slice(scanned).map((doc) => String(doc?.name ?? doc?.file ?? '?'))
  return { candidates, scanned, total: list.length, skipped, stoppedBy, notScanned }
}

/**
 * 在排好序的候选里挑一篇。
 *   match → 分数够高：名字/正文/标题确实指向这个 LoRA
 *   sole  → 没有够高的，但全目录只有一篇像提示词文档，那就用它（并在结果里说明）
 *   none  → 都不像，什么都不并 —— 宁可少喂，也别把说明文字塞进 prompt
 */
export function chooseLoraDoc(ranked) {
  const list = Array.isArray(ranked) ? ranked : []
  const strong = list.find((item) => item.score >= LORA_DOC_STRONG_SCORE)
  if (strong) return { chosen: strong, mode: 'match' }
  const qualifying = list.filter((item) => (
    item.hasPromptHeading === true || item.promptish === true || item.score >= 20
  ))
  if (qualifying.length === 1) return { chosen: qualifying[0], mode: 'sole' }
  return { chosen: null, mode: 'none' }
}

/**
 * 扫目录里的提示词文档 —— 子文件夹也要走进去（角色文档常按角色/画风分子目录放）。
 * 目录不存在 / 读不了都不抛，返回 { ok:false, error }。
 * 自己走目录（不用 readdir 的 recursive）：深度、排序、循环保护都要可控，结果才可复现。
 */
export async function readLoraDocs(dir) {
  const root = typeof dir === 'string' ? dir.trim() : ''
  if (root.length === 0) return { ok: true, dir: '', docs: [] }
  const docs = []
  const skipped = []
  // 记下走过的真实路径：符号链接/联接点指回上层时别原地打转
  const seen = new Set()
  const walk = async (current, depth, rel) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (depth === 0) throw error
      skipped.push(`${current}：${error?.code ?? error?.message ?? error}`)
      return
    }
    const ordered = entries.slice().sort((a, b) => a.name.localeCompare(b.name))
    // 先扫一遍这一层的文件，记下「同目录里有哪些模型文件」—— 一个角色一个文件夹、
    // 模型与文档并排放，是最硬的配对证据，比任何名字相似度都可靠。
    const modelsHere = []
    for (const entry of ordered) {
      const dot = entry.name.lastIndexOf('.')
      const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : ''
      if (!LORA_MODEL_EXTS.has(ext)) continue
      modelsHere.push(normalizeLoraKey(entry.name))
    }
    for (const entry of ordered) {
      const full = join(current, entry.name)
      let isDir = entry.isDirectory()
      // Windows 的目录联接 / 符号链接：Dirent 只说「是个链接」，得 stat 一次才知道指向哪
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = (await stat(full)).isDirectory()
        } catch {
          isDir = false
        }
      }
      if (isDir) {
        if (depth + 1 > LORA_DOC_MAX_DEPTH) continue
        let real = full
        try {
          real = await realpath(full)
        } catch {
          real = full
        }
        if (seen.has(real)) continue
        seen.add(real)
        await walk(full, depth + 1, rel.length === 0 ? entry.name : `${rel}/${entry.name}`)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const dot = entry.name.lastIndexOf('.')
      const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : ''
      if (!LORA_DOC_EXTS.has(ext)) continue
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.size > LORA_DOC_MAX_BYTES) {
        skipped.push(`${entry.name}：${info.size} 字节，超过 ${LORA_DOC_MAX_BYTES}`)
        continue
      }
      const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name
      const docKey = normalizeLoraKey(stem)
      docs.push({
        file: full,
        name: entry.name,
        stem,
        key: docKey,
        rel: rel.length === 0 ? entry.name : `${rel}/${entry.name}`,
        // 同目录里有哪些模型（key 形式）—— 用来判断「这篇文档是不是就跟这个 LoRA 摆在一起」
        siblings: modelsHere.filter((key) => key !== docKey),
        size: info.size,
      })
    }
  }
  try {
    await walk(root, 0, '')
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return { ok: false, dir: root, docs: [], error: missing ? '目录不存在' : (error?.message ?? String(error)) }
  }
  return { ok: true, dir: root, docs, skipped }
}

/**
 * 把文档里的提示词段并进用户的 prompt。空文档原样返回（一个字符都不改）。
 */
export function composeLoraPrompt(prompt, docText) {
  const base = typeof prompt === 'string' ? prompt : ''
  const extra = typeof docText === 'string' ? docText.trim() : ''
  if (extra.length === 0) return base
  if (base.trim().length === 0) return extra
  return `${base.trim()}\n\n${extra}`
}

/**
 * 把文档里的负面 tag 并进负面提示词。负面词是逗号分隔的一长串，
 * 所以按 tag 去重合并（不像正面那样整段换行追加，免得同一批词重复两遍互相抵消）。
 * 空的一段原样返回另一段。
 */
export function composeNegative(negative, docNegative) {
  const base = typeof negative === 'string' ? negative.trim() : ''
  const extra = typeof docNegative === 'string' ? docNegative.trim() : ''
  if (extra.length === 0) return base
  const seen = new Set()
  const out = []
  for (const chunk of [base, extra]) {
    for (const raw of chunk.split(/[,，\n]/)) {
      const tag = raw.trim()
      if (tag.length === 0) continue
      const key = tag.toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(tag)
    }
  }
  return out.join(', ')
}

/**
 * 找「负面提示词」那个 CLIPTextEncode 的节点 id：从 KSampler 的 negative 输入顺藤摸瓜
 * （graph 模式里的工作流各家写法不同，不能靠节点序号猜）。摸不到就返回 null，调用方跳过。
 */
export function findNegativeNode(graph, positiveId = null) {
  const nodes = graph && typeof graph === 'object' ? graph : {}
  const encoders = new Set(
    Object.entries(nodes)
      .filter(([, node]) => node?.class_type === 'CLIPTextEncode')
      .map(([id]) => id),
  )
  if (encoders.size === 0) return null
  for (const node of Object.values(nodes)) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    const link = inputs.negative
    if (!Array.isArray(link) || link.length === 0) continue
    const id = String(link[0])
    if (!encoders.has(id)) continue
    if (positiveId !== null && id === String(positiveId)) continue
    return id
  }
  return null
}

// ── 原生文件夹选择框 ──────────────────────────────────────────────────────
// 这一节全部是纯函数（除了 pickDirectory），方便单测在不弹窗的前提下覆盖。

/**
 * 找 Windows PowerShell 的可执行文件。
 * 非 Windows 返回 ''（调用方据此走「这个平台没有对话框」分支）。
 * 32 位 node 跑在 64 位 Windows 上时 System32 会被重定向到 SysWOW64，
 * 那里没有 WindowsPowerShell，所以要再试一次 Sysnative。
 */
export function powershellPath() {
  if (process.platform !== 'win32') return ''
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidates = [
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* 忽略：权限之类的问题就当下一个候选 */ }
  }
  // 都没找到也交给 spawn 去试裸名，让 ENOENT 变成一条可读的失败原因
  return 'powershell.exe'
}

/**
 * PowerShell 单引号字面量转义：内部每个 ' 写成 ''。
 * 传路径/标题进脚本一律走这个，别用双引号（$ 会被外层吃掉）。
 */
export function quotePowerShell(value) {
  return "'" + String(value ?? '').replace(/'/g, "''") + "'"
}

/**
 * 生成「弹一个文件夹选择框，把结果写进临时文件」的 PowerShell 脚本。
 * 要点：
 *   - 必须 -STA（文件夹对话框是 COM + 模态循环）；
 *   - 用一个 1×1、TopMost、Opacity=0 的隐形 owner 保证对话框在浏览器前面弹出；
 *   - 结果写 UTF-8（无 BOM）临时文件，不走 stdout（代码页会写坏中文）。
 */
export function buildPickerScript({ tempFile, title = PICKER_TITLE, initial = '' } = {}) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    // 不关掉进度流的话，powershell 会往 stderr 吐一大段 CLIXML 进度噪音
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.FormBorderStyle = "None"',
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$owner.StartPosition = "CenterScreen"',
    '$owner.Opacity = 0',
    '$owner.Show()',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dlg.Description = ${quotePowerShell(title)}`,
    '$dlg.ShowNewFolderButton = $true',
  ]
  if (typeof initial === 'string' && initial.trim().length > 0) {
    lines.push(`$dlg.SelectedPath = ${quotePowerShell(initial.trim())}`)
  }
  lines.push(
    '$result = $dlg.ShowDialog($owner)',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    "  $text = 'OK' + [char]10 + $dlg.SelectedPath",
    '} else {',
    "  $text = 'CANCEL'",
    '}',
    `[System.IO.File]::WriteAllText(${quotePowerShell(tempFile)}, $text, (New-Object System.Text.UTF8Encoding($false)))`,
    '$dlg.Dispose()',
    '$owner.Close()',
  )
  return lines.join('\r\n')
}

/**
 * 解析子进程写回来的文本：首行 OK/CANCEL，OK 时第二行起是路径。
 * 任何认不出的内容都当「取消」——宁可什么都不改，也不要把乱码写进配置。
 */
export function parsePickedText(text) {
  const raw = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  const cut = raw.indexOf('\n')
  const head = (cut < 0 ? raw : raw.slice(0, cut)).trim().toUpperCase()
  if (head !== 'OK') return { cancelled: true, path: '' }
  const path = (cut < 0 ? '' : raw.slice(cut + 1)).replace(/\r/g, '').trim()
  if (path.length === 0) return { cancelled: true, path: '' }
  return { cancelled: false, path }
}

/**
 * 从 powershell 的 stderr 里挖出一条人能读的错误。
 * stderr 默认是 CLIXML（`#< CLIXML` + `<Objs>`），错误正文在 `<S S="Error">` 里，
 * 而且换行/制表被转义成 `_x000D_` 这类占位；不是 CLIXML 时退化成取最后一行。
 */
export function parsePowerShellError(text) {
  const raw = typeof text === 'string' ? text : ''
  if (raw.trim().length === 0) return ''
  const decode = (s) => s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\r/g, '')
    .trim()
  if (raw.includes('<Objs')) {
    const entries = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => decode(m[1]))
    const first = entries.find((line) => line.length > 0 && !line.startsWith('+') && !line.startsWith(' '))
    if (first) return first
    if (entries.length > 0) return entries[0]
  }
  const lines = decode(raw).split('\n').map((line) => line.trim()).filter(Boolean)
  const useful = lines.filter((line) => line !== '#< CLIXML' && !line.startsWith('<') && !line.startsWith('+'))
  return useful.slice(-1)[0] ?? ''
}

/**
 * 弹一次原生文件夹选择框，等用户点完（或超时）。
 * @returns {Promise<{ok:true, path:string} | {ok:false, cancelled:true} | {ok:false, reason:string, error?:string}>}
 */
async function pickDirectory({ initial = '' } = {}) {
  const exe = powershellPath()
  if (!exe) return { ok: false, reason: 'unsupported' }

  let workDir = ''
  try {
    workDir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-pick-'))
  } catch (error) {
    return { ok: false, reason: 'failed', error: explain(error) }
  }
  const tempFile = join(workDir, 'picked.txt')
  try {
    const script = buildPickerScript({ tempFile, initial })
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      exe,
      ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 2048) stderr += String(chunk)
    })

    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已经退了 */ }
        resolve({ timedOut: true })
      }, PICK_TIMEOUT_MS)
      child.once('error', (error) => {
        clearTimeout(timer)
        resolve({ error })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code })
      })
    })
    if (exit.timedOut) return { ok: false, reason: 'timeout' }
    if (exit.error) return { ok: false, reason: 'failed', error: explain(exit.error) }

    let text = ''
    try {
      text = await readFile(tempFile, 'utf8')
    } catch {
      // 没有结果文件：多半是 powershell 起不来或策略拦了
      const detail = parsePowerShellError(stderr)
      return { ok: false, reason: 'failed', error: detail || `对话框进程退出码 ${exit.code}` }
    }
    const parsed = parsePickedText(text)
    if (parsed.cancelled) return { ok: false, cancelled: true }
    try {
      const info = await stat(parsed.path)
      if (!info.isDirectory()) return { ok: false, reason: 'failed', error: '选中的不是目录' }
    } catch (error) {
      return { ok: false, reason: 'failed', error: explain(error) }
    }
    return { ok: true, path: parsed.path }
  } catch (error) {
    return { ok: false, reason: 'failed', error: explain(error) }
  } finally {
    try { await rm(workDir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不算失败 */ }
  }
}


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

/** 路由路径：GET /api/comfyui/draw-models（对话栏「生图模型」下拉的数据源） */
const DRAW_ROUTE = '/api/comfyui/draw-models'

/** 路由路径：GET /api/comfyui/lora-docs（设置页显示「已识别 N 篇」） */
const LORA_DOCS_ROUTE = '/api/comfyui/lora-docs'

// ── k91：会话视图「ComfyUI」页的数据路由 ──────────────────────────────────
/** GET /api/comfyui/workspace/snapshot —— 一次拿齐队列 / 任务 / 最近生成记录 */
const WORKSPACE_SNAPSHOT_ROUTE = '/api/comfyui/workspace/snapshot'
/** GET /api/comfyui/workspace/workflow?promptId=|filename= —— 图 → 工作流反查 */
const WORKSPACE_WORKFLOW_ROUTE = '/api/comfyui/workspace/workflow'
/** GET /api/comfyui/workspace/image?filename=&subfolder=&type= —— 产出图代理 */
const WORKSPACE_IMAGE_ROUTE = '/api/comfyui/workspace/image'
/** POST /api/comfyui/workspace/submit —— 图上改完参数后重提交 */
const WORKSPACE_SUBMIT_ROUTE = '/api/comfyui/workspace/submit'

// ── 唯一一条会「等用户点按钮」的路由 ──────────────────────────────────────
// 设置页的「选择」按钮要弹的是**系统原生**文件夹选择框，而原生对话框只能开在
// 交互式会话里（宿主的 node 进程自己没有桌面），所以这里 spawn 一个
// powershell.exe -STA 去开 WinForms 的 FolderBrowserDialog，等它退出再回话。
//
// 宿主 webserver 没有配 requestTimeout / headersTimeout，所以这条请求不会被
// 服务器掐断；超时由插件自己兜（PICK_TIMEOUT_MS）。
//
// 路径不能靠 stdout 回传：Windows PowerShell 的控制台代码页会把中文写成乱码。
// 一律让子进程把结果写进 UTF-8 临时文件，宿主读完再删。
const PICK_ROUTE = '/api/comfyui/pick-directory'

/** 一次「选择目录」最多等多久（毫秒） */
const PICK_TIMEOUT_MS = 180_000

/** 对话框标题 */
const PICKER_TITLE = '选择图片输出目录'

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
  const waitForJob = createJobWaiter(client, settings)

  // k91：图 → 工作流反查用的旁侧索引（输出根下 _dsh_meta/prompt-index.jsonl）。
  // 索引写失败绝不能影响出图主流程，所有调用点都 try/catch 吞掉。
  const workspaceStore = createWorkspaceStore({ getRoot: () => resolvedOutputRoot(AbortSignal.timeout(settings.timeoutMs)) })

  /**
   * 提交一张工作流，并顺手把 graph + promptId 记进索引。
   * 所有提交入口（comfy_run / workspace submit / review / upscale）都走这里，
   * 保证「本机图 → 工作流」永远查得到，不依赖 ComfyUI 历史是否被清。
   */
  async function submitAndIndex(graph, { signal, title = '', params = null } = {}) {
    const submitted = await client.submit(graph, { signal })
    if (submitted.ok) {
      try {
        await workspaceStore.append({
          promptId: submitted.promptId,
          createdAt: new Date().toISOString(),
          graph,
          params: params ?? extractWorkflowParams(graph),
          files: [],
          title,
        })
      } catch { /* 索引落盘失败不影响出图 */ }
    }
    return submitted
  }

  // 保存一份最近一次用过的客户端配置，方便各工具报地址
  const where = () => client.baseUrl

  /**
   * ComfyUI 没在跑时统一给「未启动」说明（所有会碰 ComfyUI 的工具共用）。
   * 只返回可读文案，绝不 spawn / exec main.py，也不改配置、不重试、不弹窗。
   */
  function offlineResult(error) {
    return { text: `ComfyUI 没在跑（${where()}）。\n${explain(error)}\n先把 ComfyUI 启动起来再试。` }
  }

  /** 把 OFFLINE 错误变成统一文案；非 OFFLINE 原样 throw。 */
  function offlineOrThrow(error) {
    if (error instanceof ComfyError && error.code === 'OFFLINE') return offlineResult(error)
    throw error
  }

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

  // ── LoRA 提示词文档：查一次、并进 prompt、报告结果 ──────────────────────
  // 关键约定：设置里没选目录时**一个文件都不读**，行为与没有这个功能时完全一致。

  /** 设置里配的文档目录；相对路径以 ComfyUI 的 output 为基准。没配返回 ''。 */
  async function resolvedLoraDocDir(signal) {
    const configured = readFeatureConfig(config).loraDocs.dir
    if (configured.length === 0) return ''
    return resolveConfiguredDir(configured, await resolvedOutputRoot(signal), 'LoRA 提示词目录')
  }

  /**
   * 给别名匹配准备「文档原文 + 同目录模型」：{ stem, raw, siblings }[]。
   * 没配目录 / 读不了 / 单篇超大 → 返回空数组（匹配器自己会退化成只看文件名）。
   * 只读前 LORA_DOC_SCAN_LIMIT 篇，避免目录里塞几百篇时把 IO 打满。
   */
  async function loadDocAliasInputs(signal) {
    let dir = ''
    try {
      dir = await resolvedLoraDocDir(signal)
    } catch {
      return []
    }
    if (dir.length === 0) return []
    const listed = await readLoraDocs(dir)
    if (listed.ok !== true) return []
    const out = []
    for (const doc of (listed.docs ?? []).slice(0, LORA_DOC_SCAN_LIMIT)) {
      let raw = ''
      try {
        raw = await readFile(doc.file, 'utf8')
      } catch {
        continue
      }
      out.push({ stem: doc.stem, raw, siblings: doc.siblings ?? [] })
    }
    return out
  }

  /**
   * 兑现 `lora: "auto"`：拿 ComfyUI 的 loras 名单 + 文档目录里的别名表，按 prompt 挑一个。
   * `pick` 为空时 `note` 一定非空 —— 调用方把它拼进结果文本，别让人以为是插件忘了挂。
   *
   * @returns {{pick:string, note:string}}
   */
  async function resolveAutoLora(prompt, signal) {
    let loras = []
    try {
      const index = await client.modelIndex({ signal })
      loras = index.loras ?? []
    } catch (error) {
      return { pick: '', note: `LoRA：lora:"auto" 需要先读 ComfyUI 的 loras 名单，${explain(error)}` }
    }
    if (loras.length === 0) {
      return { pick: '', note: 'LoRA：lora:"auto" 没得挑 —— ComfyUI 的 loras 文件夹是空的。' }
    }
    const docs = await loadDocAliasInputs(signal)
    const matched = matchLoraForPrompt(prompt, loras, docs)
    if (matched.pick) return { pick: matched.pick, note: '' }
    if (matched.candidates.length === 0) {
      return {
        pick: '',
        note: `LoRA：prompt 里没认出能对上 loras 名单的角色名（看了 ${matched.considered} 个 lora），这次没挂。`
          + '要么直接传文件名，要么先调 comfy_models 看有哪些 lora 与别名。',
      }
    }
    const named = matched.candidates
      .slice(0, 4)
      .map((item) => `${item.file}（命中「${item.hit.join('、')}」）`)
      .join('；')
    return {
      pick: '',
      note: `LoRA：prompt 里认出了 ${matched.candidates.length} 个候选（${named}），不替你猜 —— 这次没挂，`
        + '要挂哪个就把文件名传给 lora。',
    }
  }

  /**
   * 给某个 LoRA 挑提示词文档：读目录 → 逐篇打分 → 排序 → 选一篇。
   * 返回 { configured, dir, maxChars, mode, doc, score, reasons, ranked, count, promptish,
   *        scanned, text, truncated, heading, totalChars, keptChars, cut, error, skipped,
   *        stoppedBy, notScanned }：
   *   configured=false → 设置里没选目录，调用方什么都不用做（一个文件都没读）
   *   mode='none'      → 都不像，doc 为 null，ranked 里是前几名（给人看为什么没挑中）
   *   totalChars/keptChars/cut → 原文多少字、实际并进 prompt 多少字、切在什么边界
   */
  /**
   * 给某个 LoRA 挑提示词文档：读目录 → 逐篇打分 → 排序 → 选一篇 → 从里面取 tag 段。
   * 返回 { configured, dir, maxChars, mode, doc, score, reasons, ranked, count, promptish,
   *        scanned, text, negative, truncated, heading, totalChars, tagChars, keptChars, cut,
   *        blocks, dropped, picked, pickedTotal, unpicked, negativeChars,
   *        error, skipped, stoppedBy, notScanned }：
   *   configured=false → 设置里没选目录，调用方什么都不用做（一个文件都没读）
   *   mode='none'      → 都不像，doc 为 null，ranked 里是前几名（给人看为什么没挑中）
   *   totalChars/keptChars/cut → 原文多少字、实际并进 prompt 多少字、切在什么边界
   *   prompt           → 用户这次的正面提示词，用来让「服装/发型」这些贴题的 tag 段优先入选
   */
  async function lookupLoraDoc(loraName, signal, prompt = '') {
    const features = readFeatureConfig(config).loraDocs
    const maxChars = features.maxChars
    const empty = {
      text: '', negative: '', truncated: false, heading: '', totalChars: 0, tagChars: 0,
      keptChars: 0, cut: '', blocks: 0, dropped: 0, picked: 0, pickedTotal: 0, unpicked: [],
      negativeChars: 0, outfit: '', how: 'none', anchorChars: 0, skippedGroups: [],
    }
    const dir = await resolvedLoraDocDir(signal)
    if (dir.length === 0) {
      return {
        configured: false, dir, maxChars, mode: 'none', doc: null, score: 0, reasons: [], ranked: [],
        count: 0, promptish: 0, scanned: 0, error: '', skipped: [], stoppedBy: '', notScanned: [],
        ...empty,
      }
    }
    const listed = await readLoraDocs(dir)
    if (listed.ok !== true) {
      return {
        configured: true, dir, maxChars, mode: 'none', doc: null, score: 0, reasons: [], ranked: [],
        count: 0, promptish: 0, scanned: 0,
        error: listed.error ?? '读不了目录', skipped: listed.skipped ?? [],
        stoppedBy: '', notScanned: [],
        ...empty,
      }
    }
    const docs = listed.docs ?? []
    const ranked = await rankLoraDocs(docs, loraName, { maxChars })
    const { chosen, mode } = chooseLoraDoc(ranked.candidates)
    const promptish = ranked.candidates.filter((item) => item.promptish || item.hasPromptHeading).length
    const top = ranked.candidates.slice(0, 5).map((item) => ({
      name: item.doc?.name ?? '', score: item.score, reasons: item.reasons,
    }))
    const skipped = [...(listed.skipped ?? []), ...ranked.skipped]
    if (!chosen) {
      return {
        configured: true, dir, maxChars, mode: 'none', doc: null, score: 0, reasons: [], ranked: top,
        count: docs.length, promptish, scanned: ranked.scanned, error: '', skipped,
        stoppedBy: ranked.stoppedBy ?? '', notScanned: ranked.notScanned ?? [],
        ...empty,
      }
    }
    // 取段要看整篇原文（chosen.raw），不能用打分时那段（那是给「像不像提示词」判形态用的）
    const section = composeDocSection(chosen.raw ?? '', { maxChars, prompt })
    return {
      configured: true, dir, maxChars, mode, doc: chosen.doc, score: chosen.score, reasons: chosen.reasons,
      ranked: top, count: docs.length, promptish, scanned: ranked.scanned,
      text: section.text,
      negative: section.negative,
      truncated: section.truncated === true,
      heading: section.heading ?? '',
      totalChars: section.totalChars,
      tagChars: section.tagChars,
      keptChars: section.keptChars,
      cut: section.cut,
      blocks: section.blocks,
      dropped: section.dropped,
      picked: section.picked,
      pickedTotal: section.pickedTotal,
      unpicked: section.unpicked,
      negativeChars: section.negativeChars,
      outfit: section.outfit ?? '',
      how: section.how ?? 'none',
      anchorChars: section.anchorChars ?? 0,
      skippedGroups: section.skippedGroups ?? [],
      error: '', skipped,
      stoppedBy: ranked.stoppedBy ?? '', notScanned: ranked.notScanned ?? [],
    }
  }

  /** 把截断边界翻成人话 */
  const CUT_WORDS = {
    blank: '空行边界',
    line: '换行边界',
    comma: '逗号边界',
    space: '空格边界',
    hard: '硬切（文档里没找到可收口的边界）',
  }

  /**
   * 把挑中的文档并进 prompt，并把结果写成给人看的一行（没有就返回空串）。
   * 返回 { prompt, negative, note, budget }：
   *   prompt   —— 要并进正面提示词的 tag 段（可能为空）
   *   negative —— 文档里「负面：」那段 tag（可能为空），调用方并进 negative prompt
   *   budget   —— 结构化的预算信息，调用方可原样带走
   */
  function applyLoraDoc(lookup, { negative = true } = {}) {
    const budget = {
      docName: lookup.doc?.name ?? '',
      mode: lookup.mode ?? 'none',
      section: lookup.mode === 'none' ? 'none' : (lookup.picked > 0 ? 'tags' : 'plain'),
      kept: lookup.keptChars ?? 0,
      total: lookup.totalChars ?? 0,
      tagChars: lookup.tagChars ?? 0,
      maxChars: lookup.maxChars ?? LORA_DOC_MAX_CHARS,
      cut: lookup.cut ?? '',
      truncated: lookup.truncated === true,
      blocks: lookup.blocks ?? 0,
      dropped: lookup.dropped ?? 0,
      picked: lookup.picked ?? 0,
      pickedTotal: lookup.pickedTotal ?? 0,
      unpicked: lookup.unpicked ?? [],
      negativeChars: lookup.negativeChars ?? 0,
      outfit: lookup.outfit ?? '',
      how: lookup.how ?? 'none',
      anchorChars: lookup.anchorChars ?? 0,
      skippedGroups: lookup.skippedGroups ?? [],
      stoppedBy: lookup.stoppedBy ?? '',
      notScanned: lookup.notScanned ?? [],
      skipped: lookup.skipped ?? [],
    }
    if (!lookup.configured) {
      return {
        prompt: '',
        negative: '',
        note: '提示词文档：挂了 LoRA，但设置里没配「LoRA 提示词」目录，这次没查文档。',
        budget,
      }
    }
    if (lookup.error) return { prompt: '', negative: '', note: `提示词文档：${lookup.error}`, budget }
    const why = Array.isArray(lookup.reasons) && lookup.reasons.length > 0
      ? `（${lookup.reasons.join('、')}）`
      : ''
    // 被跳过 / 没参与打分的文档也要说出来，否则用户以为整目录都看过了
    const tail = []
    if (budget.stoppedBy !== '') {
      const reason = budget.stoppedBy === 'limit' ? `超过 ${LORA_DOC_SCAN_LIMIT} 篇的上限` : `超过 ${Math.round(LORA_DOC_SCAN_BYTES / 1024 / 1024)} MB 的读取预算`
      const names = budget.notScanned.slice(0, 3).join('、')
      const more = budget.notScanned.length > 3 ? ` 等 ${budget.notScanned.length} 篇` : ''
      tail.push(`另有 ${budget.notScanned.length} 篇没参与打分（${reason}：${names}${more}）`)
    }
    if (budget.skipped.length > 0) {
      tail.push(`${budget.skipped.length} 篇被跳过（${budget.skipped.slice(0, 3).join('；')}${budget.skipped.length > 3 ? ' …' : ''}）`)
    }
    const tailText = tail.length > 0 ? `；${tail.join('；')}` : ''
    if (!lookup.doc) {
      if (lookup.count === 0) {
        return { prompt: '', negative: '', note: `提示词文档：目录里没有文档（${lookup.dir}）${tailText}`, budget }
      }
      const near = (lookup.ranked ?? [])
        .slice(0, 3)
        .map((item) => `${item.name}(${item.score})`)
        .join('、')
      return {
        prompt: '',
        negative: '',
        note: `提示词文档：${lookup.count} 篇候选里没有像这个 LoRA 的提示词文档，这次没并入`
          + `（其中 ${lookup.promptish} 篇像提示词）${near ? `；分数最高的几篇：${near}` : ''}`
          + `${tailText}。想自己看一眼用 comfy_lora_doc。`,
        budget,
      }
    }
    if (lookup.text.length === 0) {
      return { prompt: '', negative: '', note: `提示词文档：${lookup.doc.name} 里没有可用的提示词段${why}${tailText}`, budget }
    }
    const prefix = lookup.mode === 'sole'
      ? `提示词文档：${lookup.doc.name}（目录里唯一像提示词的那篇，没明确提到这个 LoRA${why}；已并入 prompt，`
      : `提示词文档：${lookup.doc.name}（按内容挑中${why}；已并入 prompt，`
    // 挑段与否都要报出「原文多少字 / 实际并了多少字」，不能只留一句「已截断」。
    // tags 模式现在按「套」说：并了哪一套服装、锚点多少字；plain 模式报「切在哪种边界」。
    const outfitNote = budget.section === 'tags'
      ? (budget.how === 'name' ? `并的是「${budget.outfit}」这一套`
        : budget.how === 'synonym' || budget.how === 'label' || budget.how === 'label-synonym'
          ? `并的是「${budget.outfit}」这一套（按你点名的服装）`
          : budget.how === 'first' ? `没认出服装，用了「${budget.outfit}」这一套`
            : `文档里没有你点名的这套服装，只并了角色本体 —— 服装段自己写`)
      : ''
    const size = budget.section === 'tags'
      ? (budget.truncated
        ? `${budget.picked}/${budget.pickedTotal} 套、${budget.kept} 字（上限 ${budget.maxChars}，锚点 ${budget.anchorChars} 字），`
          + `另有 ${budget.skippedGroups.length} 套没并 —— 想看剩下的套传 rest:true，想看整篇传 full:true`
        : `${budget.picked} 套服装 + ${budget.anchorChars} 字锚点、共 ${budget.kept} 字，全挑完了`)
      : (lookup.truncated
        ? `${budget.kept} / ${budget.total} 字，上限 ${budget.maxChars}，切在${CUT_WORDS[budget.cut] ?? '边界'}，`
          + `余下 ${Math.max(0, budget.total - budget.kept)} 字没并 —— 想看整篇传 full:true，只看后段传 rest:true`
        : `${budget.total} 字，全篇并进去了`)
    // 散文是丢掉了还是留下了，必须说清楚：这正是「画出来不像」的病根
    const skim = budget.dropped > 0
      ? `；跳过 ${budget.dropped} 块没有 tag 的说明文字`
      : ''
    const neg = lookup.negativeChars > 0
      ? `；负面 ${lookup.negativeChars} 字并进了 negative prompt`
      : ''
    const note = outfitNote
      ? `${prefix}${outfitNote}，${size}${skim}${neg}${tailText}）`
      : `${prefix}${size}${skim}${neg}${tailText}）`
    return {
      prompt: lookup.text,
      negative: lookup.negative ?? '',
      note,
      budget,
    }
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
  async function askReviewer(exec, { provider, model, imageRef, referenceRef, requirement }) {
    const service = llm()
    const system =
      '你是一个严格的图像审阅员。看图，对照用户的要求，判断这张图是否达标（满意/角色是否还原/要求是否满足）。'
      + (referenceRef
        ? '消息里有两张图：第一张是这次生成的结果，第二张是角色参考图。请重点比对第一张是否还原了参考图里的角色（发型、发色、瞳色、服饰、配色、气质等）。参考图里多余的东西不算要求。'
        : '')
      + '只输出一个 JSON 对象，不要输出任何别的文字，字段如下：'
      + '{"satisfied": true 或 false, "score": 0 到 10 的整数, "feedback": "一句话说清楚哪里不行（满意就给简短好评）", "new_prompt": "不满意时给出用于重画的、更具体完整的英文正向提示词；满意时给空字符串"}'
    const text = `用户要求：${requirement}`
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
    const submitted = await submitAndIndex(graph, { signal, title: 'review/upscale', params: extractWorkflowParams(graph) })
    if (!submitted.ok) {
      const detail = submitted.nodeErrors
        ? `\n节点报错：${JSON.stringify(submitted.nodeErrors).slice(0, 2000)}`
        : ''
      throw new Error(`ComfyUI 拒了这张工作流：${submitted.error}${detail}`)
    }
    const promptId = submitted.promptId
    const deadline = deadlineMs > 0 ? deadlineMs : Date.now() + settings.maxWaitSeconds * 1000
    const waitStarted = Date.now()
    const { job, reason, lastStatus, queueInfo } = await waitForJob(promptId, { signal, deadline })

    if (reason === 'timeout') {
      throw new Error(
        `等待任务 ${promptId} 超时（已等 ${humanDuration(Date.now() - waitStarted)}，最后状态 ${lastStatus}）。`
        + `${queueInfo ?? ''} 任务可能还在正常排队/渲染：先调 comfy_status 看 prompt_id ${promptId} 的真实状态，`
        + '确认还在跑就再调一次 comfy_result 并加大 wait_seconds。',
      )
    }
    if (reason === 'lost') {
      throw new Error(
        `任务 ${promptId} 的状态从 ComfyUI 消失了（最后状态 ${lastStatus}）：可能被取消、也可能历史已被挤出。`
        + '用 comfy_status 查 prompt_id 确认。',
      )
    }
    if (job?.status === 'failed') {
      throw new Error(`重生成任务 ${promptId} 失败了（可能是显存不够，用 comfy_status 看）`)
    }
    const { ref, image, bytes, mediaType } = await fetchImageRef(promptId, signal)
    return { promptId, ref, filename: image.filename, image, bytes, mediaType }
  }

  /**
   * 注册一个「会碰 ComfyUI」的工具：把 execute 包一层，任何 ComfyError(OFFLINE)
   * 都统一变成「没在跑」的友好文案，其余错误原样抛。这样提交链路（submit / job /
   * view / systemStats / modelIndex …）无论哪一步发现服务离线，口径都一致，且
   * 入口里绝无 spawn / exec main.py 的自动拉起逻辑。
   */
  function registerComfyTool(definition) {
    const original = definition.execute
    definition.execute = async (args, exec) => {
      try {
        return await original(args, exec)
      } catch (error) {
        return offlineOrThrow(error)
      }
    }
    return ctx.tools.register(definition)
  }

  // ── 1. comfy_status ────────────────────────────────────────────────────
  registerComfyTool({
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
        if (error instanceof ComfyError && error.code === 'OFFLINE') return offlineResult(error)
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
  registerComfyTool({
    name: 'comfy_models',
    description:
      '看这台 ComfyUI 上有什么：开头是「当前绘图配置」（现在用的生图模型、LoRA 允不允许挂、'
      + '提示词文档目录），然后是各文件夹的模型文件清单，loras 会附上角色别名（中文 / 日文 / 罗马音）。'
      + '画用户点名的角色之前先看这个：在 loras 里找对应文件，把文件名传给 comfy_run 的 lora；'
      + '不确定就传 lora:"auto"。内置模板用 diffusion_models 里的第一个（三件套加载器），'
      + '没有就用 checkpoints 里的整合包（一个文件同时带 MODEL/CLIP/VAE）。',
    parameters: params({}),
    output: output(),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      let index
      try {
        index = await client.modelIndex({ signal: exec.signal })
      } catch (error) {
        if (error instanceof ComfyError && error.code === 'OFFLINE') throw error
        throw new Error(explain(error))
      }
      const features = readFeatureConfig(config)
      const lines = ['当前绘图配置：']
      for (const line of describeDrawConfig(features, index)) lines.push(`  ${line}`)
      // 别名的证据在文档目录里；没配目录（或读不了）就只给文件名，不报错
      const aliasDocs = await loadDocAliasInputs(exec.signal)
      lines.push('', '可用模型：')
      for (const folder of MODEL_FOLDERS) {
        const list = index[folder] ?? []
        lines.push(`${folder}：${list.length ? `${list.length} 个` : '（空）'}`)
        for (const file of list.slice(0, 40)) {
          if (folder !== 'loras') {
            lines.push(`  - ${file}`)
            continue
          }
          const table = loraAliases(file, aliasDocs)
          const extra = table.sources.docs.length > 0 ? ` — ${table.sources.docs.join(' / ')}` : ''
          lines.push(`  - ${file}${extra}`)
        }
        if (list.length > 40) lines.push(`  …还有 ${list.length - 40} 个`)
      }
      const missing = ['diffusion_models', 'text_encoders', 'vae'].filter((f) => (index[f] ?? []).length === 0)
      const hasCheckpoint = (index.checkpoints ?? []).length > 0
      if (hasCheckpoint) {
        lines.push('内置模板会优先用 diffusion_models 里的第一个（三件套）；diffusion_models 空的话就用 checkpoints 里的整合包。')
      } else if (missing.length > 0) {
        lines.push(`注意：${missing.join('、')} 是空的，内置模板跑不了（它要这三样，或者一个 checkpoints 整合包）——改用 comfy_run 的 graph 模式传自己的工作流。`)
      }
      if ((index.loras ?? []).length > 0) {
        lines.push('', '画具体角色时，把对应的 lora 文件名传给 comfy_run / comfy_review 的 lora；'
          + '不确定文件名就传 lora:"auto"，插件会按 prompt 里的角色名挑（中/日/罗马音都认，唯一命中才挂）。')
      }
      return { text: lines.join('\n') }
    },
  })

  // ── 3. comfy_node ──────────────────────────────────────────────────────
  registerComfyTool({
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
        if (error instanceof ComfyError && error.code === 'OFFLINE') throw error
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
  registerComfyTool({
    name: 'comfy_run',
    description:
      '把一张工作流提交给 ComfyUI 排队，立刻返回 prompt_id。三种用法：\n'
      + '· mode="template"（默认）：内置文生图 —— 加载模型 → 正负提示词 → 采样 → 解码 → 存图。'
      + '只要写 prompt；生图模型用对话栏左侧选的那个（选「自动」时可用 unet 参数临时指定），也可以在对话栏打开 LoRA 后传 lora / lora_strength。\n'
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
      unet: s('生图模型文件名：可以是 diffusion_models 里的扩散模型，也可以是 checkpoints 里的整合包。注意：对话栏左侧选中的模型优先，这里传的 unet 只在那边选的是「自动」时才生效；想临时换模型请让用户在对话栏里改'),
      clip: s('文本编码器文件名，省略用 text_encoders 里第一个'),
      vae: s('VAE 文件名，省略用 vae 里第一个'),
      lora: s('LoRA 文件名（template 模式）。要先在对话栏左侧把 LoRA 开关打开；文件名用 comfy_models 查 loras 文件夹。'
        + '画具体角色但不知道挂哪个，就传 "auto" —— 插件按 prompt 里的角色名去对 loras 名单（中文 / 日文 / 罗马音都认），'
        + '唯一命中才挂；认不出或认出多个都会在结果里说明，不会瞎挂'),
      lora_strength: n('LoRA 强度，默认 0.8'),
      lora_doc: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'auto（默认）= 挂 LoRA 时读设置里的「LoRA 提示词」目录，按内容挑最像这个 LoRA 的那篇，把里面的 tag 段并进 prompt、「负面：」那段并进 negative prompt；off = 这次不查（设置里没选目录时本来就什么都不读）',
      },
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
      // 挂 LoRA 时提示词文档的结论，最后拼进结果文本（没查就留空）
      let loraDocNote = ''

      if (mode === 'graph') {
        if (!args.graph) throw new Error('mode="graph" 时必须给 graph（API 格式的节点表）')
        graph = normalizeGraph(args.graph)
        if (args.prompt) {
          injectedNode = injectPrompt(graph, args.prompt, args.prompt_node)
          if (injectedNode === null) {
            throw new Error('提示词没写进去：这张图里没有 CLIPTextEncode 节点，请用 prompt_node 指定节点 id')
          }
        }
        // graph 模式同样兑现「挂了 LoRA 就一定看文档」：扫节点表，凡是有 LoraLoader /
        // LoraLoaderModelOnly 的，按它带的 lora_name 查文档，命中就并进正面提示词。
        // 正面提示词优先写进 args.prompt 用过的那个节点，否则退回第一个 CLIPTextEncode。
        const loraNames = []
        const loraSeen = new Set()
        for (const node of Object.values(graph)) {
          const ct = node?.class_type
          if (ct !== 'LoraLoader' && ct !== 'LoraLoaderModelOnly') continue
          const name = node?.inputs?.lora_name
          if (typeof name === 'string' && name.trim() !== '' && !loraSeen.has(name)) {
            loraSeen.add(name)
            loraNames.push(name)
          }
        }
        if (loraNames.length > 0) {
          if ((args.lora_doc ?? 'auto') === 'off') {
            loraDocNote = '提示词文档：这次传了 lora_doc:"off"，跳过了文档。'
          } else {
            const notes = []
            // 正面写进 prompt_node / 第一个 CLIPTextEncode；负面写进 KSampler 的 negative 那一支
            const positiveTarget = injectedNode
              ?? Object.entries(graph).find(([, n]) => n.class_type === 'CLIPTextEncode')?.[0]
            const negativeTarget = findNegativeNode(graph, positiveTarget)
            for (const loraName of loraNames) {
              const lookup = await lookupLoraDoc(loraName, signal, args.prompt ?? '')
              const applied = applyLoraDoc(lookup)
              if (applied.prompt.length > 0) {
                if (positiveTarget) {
                  const node = graph[positiveTarget]
                  node.inputs = { ...node.inputs, text: composeLoraPrompt(node.inputs?.text ?? '', applied.prompt) }
                }
              }
              if (applied.negative.length > 0 && negativeTarget) {
                const node = graph[negativeTarget]
                node.inputs = { ...node.inputs, text: composeNegative(node.inputs?.text ?? '', applied.negative) }
              }
              if (applied.note) notes.push(applied.note)
            }
            loraDocNote = notes.length > 0 ? notes.join('\n') : ''
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
        }

        // lora:"auto" —— 按 prompt 里的角色名挑一个（中/日/罗马音别名都认）。
        // 只认唯一命中：认不出就继续出图并说明，认出多个就列候选让人挑，绝不瞎挂。
        // 放在「门」校验之前，是为了让报错里能说清「auto 挑中了哪个」。
        // 挑不中时必须把 args.lora 清成 undefined —— 否则后面会拿字符串 "auto" 当文件名，
        // 既去查一篇「叫 auto 的 LoRA」的文档，还会在工作流里插一个 lora_name="auto" 的节点。
        let autoLora = ''
        if (args.lora === 'auto') {
          const resolvedAuto = await resolveAutoLora(args.prompt ?? '', signal)
          autoLora = resolvedAuto.pick
          if (resolvedAuto.pick) args = { ...args, lora: resolvedAuto.pick }
          else {
            args = { ...args, lora: undefined }
            loraDocNote = resolvedAuto.note
          }
        }

        if (args.lora && !features.draw.lora) {
          throw new Error(autoLora
            ? `LoRA 没开启：lora:"auto" 挑中了 ${autoLora}，但输入框左侧的 LoRA 开关是关的 —— 让用户点开再来。`
            : 'LoRA 没开启：在输入框左侧的绘图控件里把 LoRA 打开再来。')
        }

        // 挂 LoRA 时先看一遍提示词文档（纯本地读文件，不联网），
        // 所以放在 modelIndex 之前 —— 服务没跑也能先把文档读出来。
        // 设置里没选目录时 lookupLoraDoc 一个文件都不读，但结果里会交代「没查」。
        if (args.lora) {
          if ((args.lora_doc ?? 'auto') === 'off') {
            loraDocNote = '提示词文档：这次传了 lora_doc:"off"，跳过了文档。'
          } else {
            const lookup = await lookupLoraDoc(args.lora, signal, args.prompt ?? '')
            const applied = applyLoraDoc(lookup)
            loraDocNote = applied.note
            if (applied.prompt.length > 0) {
              args = { ...args, prompt: composeLoraPrompt(args.prompt, applied.prompt) }
            }
            // 文档里的「负面：」那段并进 negative prompt，不再只喂正面
            if (applied.negative.length > 0) {
              args = { ...args, negative: composeNegative(args.negative ?? DEFAULT_NEGATIVE, applied.negative) }
            }
          }
        }

        const index = await client.modelIndex({ signal })
        const models = resolveModels(index, {
          unet: preferModel(features.draw.unet, args.unet),
          clip: args.clip,
          vae: args.vae,
        })

        if (mode === 'img2img') {
          const { bytes } = await fetchImageRef(args.image_prompt_id, signal)
          const imageName = await uploadImage(bytes, `dsh_src_${args.image_prompt_id.slice(0, 8)}.png`)
          graph = buildImg2Img({
            ...models,
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
            ...models,
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

      const submitted = await submitAndIndex(graph, { signal, title: args.title ?? '', params: extractWorkflowParams(graph) })
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
        // 整合包和「三件套」的节点号不同，摘要按实际加载器读，别写死
        const head = graph[1]?.inputs ?? {}
        if (head.ckpt_name) {
          lines.push(`模型：${head.ckpt_name}（整合包，MODEL/CLIP/VAE 都从它出）`)
        } else {
          lines.push(`模型：${head.unet_name} + ${graph[2]?.inputs?.clip_name} + ${graph[3]?.inputs?.vae_name}`)
        }
        const isCkpt = Boolean(head.ckpt_name)
        const samplerNode = (isCkpt
          ? (mode === 'img2img' ? graph[6] : graph[5])
          : (mode === 'img2img' ? graph[8] : graph[7]))?.inputs ?? {}
        if (mode === 'img2img') {
          lines.push(`img2img · denoise ${samplerNode.denoise} · ${samplerNode.steps} 步 · seed ${samplerNode.seed}`)
        } else {
          const latent = (isCkpt ? graph[4] : graph[6])?.inputs ?? {}
          lines.push(
            `${latent.width}×${latent.height} ×${latent.batch_size} · ${samplerNode.steps} 步 · CFG ${samplerNode.cfg}`
            + ` · ${samplerNode.sampler_name}/${samplerNode.scheduler} · seed ${samplerNode.seed}`,
          )
          const loraNode = isCkpt ? graph[8] : graph[10]
          if (loraNode) lines.push(`LoRA：${loraNode?.inputs?.lora_name}`)
        }
      } else if (injectedNode !== null) {
        lines.push(`提示词写进了节点 ${injectedNode}`)
      }
      // 挂 LoRA 时把文档那笔账交代清楚：命中了哪篇 / 没命中 / 目录没配
      if (loraDocNote) lines.push(loraDocNote)
      // 没挂 LoRA 也别装没事：配了文档目录却说不知道该挂谁，是最容易「图不像」的场景
      if (!loraDocNote && !args.lora && (mode === 'template' || mode === 'img2img') && features.loraDocs.dir) {
        lines.push('提示词文档：这次没传 lora，没读文档。画具体角色就传 lora:"auto"（按角色名挑），或直接把 LoRA 文件名给 lora。')
      }
      lines.push('')
      lines.push(`输出目录：${
        features.output.dir
          ? `${features.output.dir}（comfy_result / comfy_review / comfy_upscale 会把图存到这里）`
          : 'ComfyUI 自己的 output（设置页没指定输出目录）'
      }`)
      lines.push('拿结果用 comfy_result（传这个 prompt_id 和 wait_seconds）。1024×1024 单张通常几十秒起，按自己机器的速度给等待时间。')
      return { text: lines.join('\n') }
    },
  })

  // ── 5. comfy_result ────────────────────────────────────────────────────
  registerComfyTool({
    name: 'comfy_result',
    description:
      '等一个任务跑完，然后取回它的输出图。'
      + '给了 wait_seconds 就一直等到跑完或等够那么久，不给就只看当前状态。'
      + '图会以图片形式交给模型看，同时报出磁盘上的路径；保存目录省略时用设置页配的那个。',
    parameters: params({
      prompt_id: s('comfy_run 返回的 prompt_id'),
      wait_seconds: i('最多等多少秒，0 表示不等待只看状态。1024×1024 单张常见 60–120 秒，多张按张数加'),
      max_images: i('最多取回几张，默认 4，最多 12'),
      show_images: { type: 'boolean', description: '是否把图交给模型看，默认 true；只想看路径和状态就传 false' },
      save_to: s('把图另存到这个目录（会自己建目录）。省略就用设置页配的输出目录；两边都空就只报 ComfyUI 那边的原有路径'),
    }, ['prompt_id']),
    output: output(),
    timeoutMs: settings.maxWaitSeconds * 1000 + 120_000,
    async execute(args, exec) {
      const signal = exec.signal
      const features = readFeatureConfig(config)
      const waitSeconds = Math.max(0, Math.min(args.wait_seconds ?? 0, settings.maxWaitSeconds))
      const maxImages = Math.max(1, Math.min(12, args.max_images ?? 4))
      const wantImages = args.show_images !== false
      const requested = typeof args.save_to === 'string' ? args.save_to.trim() : ''
      const wanted = requested || features.output.dir

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
      job = { ...job, status: normalizeStatus(job.status) }

      // 状态还没落进终态才需要等；共享 waiter 负责 null/未知态/超时/丢失的兜底
      let reason = FINISHED.has(job.status) ? 'finished' : 'waiting'
      let lastStatus = job.status
      let queueInfo = ''
      if (reason === 'waiting') {
        const waited = await waitForJob(args.prompt_id, { signal, deadline })
        reason = waited.reason
        job = waited.job
        lastStatus = waited.lastStatus
        queueInfo = waited.queueInfo ?? ''
      }

      const took = job?.execution_end_time && job?.execution_start_time
        ? ` · 耗时 ${humanDuration(job.execution_end_time - job.execution_start_time)}`
        : ''
      const lines = [`任务 ${args.prompt_id}`, `状态：${job?.status ?? lastStatus}${took}`]

      if (reason === 'timeout') {
        lines.push(
          `还在跑（已等 ${humanDuration(Date.now() - started)}，最后状态 ${lastStatus}）${queueInfo}。`,
          `先调 comfy_status 查 prompt_id ${args.prompt_id} 看真实状态；确认还在排队/渲染，就再调一次 comfy_result 并把 wait_seconds 加大。`,
        )
        return { text: lines.join('\n') }
      }
      if (reason === 'lost') {
        lines.push(
          `任务状态从 ComfyUI 消失了（最后状态 ${lastStatus}）：可能被取消、也可能历史已被挤出。`,
          `用 comfy_status 查 prompt_id ${args.prompt_id} 确认。`,
        )
        return { text: lines.join('\n') }
      }
      if (job?.status === 'failed') {
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

      // k91：把产出图与 prompt_id 的关联写进索引（图 → 工作流反查靠它）。
      // 图还没跑完就把文件记进去也无妨，视图侧会把它当作最近生成记录。
      try {
        await workspaceStore.updateFiles(args.prompt_id, images)
      } catch { /* 索引写失败不影响取图 */ }

      const saved = []
      let saveTo = ''
      if (wanted.length > 0) {
        try {
          saveTo = resolveOutputDir(wanted, await resolvedOutputRoot(signal))
        } catch (error) {
          lines.push(`另存目录不可用（${wanted}）：${error?.message ?? error}`)
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
            const target = await saveImageCopy(saveTo, image, bytes)
            if (target) {
              saved.push(target)
              lines.push(`    已保存 ${target}`)
            }
          } catch (error) {
            lines.push(`    ! 保存失败：${error?.message ?? error}`)
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
  registerComfyTool({
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
  registerComfyTool({
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
      lora: s('重画时挂的角色 LoRA 文件名（要先在输入框左侧的绘图控件里把 LoRA 打开）。留空则不带 LoRA；'
        + '传 "auto" 就按 requirement 里的角色名挑一个（中/日/罗马音都认，认不出或认出多个都会说明）'),
      lora_strength: n('LoRA 强度，默认 0.8'),
      lora_doc: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'auto（默认）= 挂 LoRA 时按内容挑出「LoRA 提示词」目录里最像这个 LoRA 的那篇，把里面的 tag 段并进重画提示词、「负面：」那段并进负面词；off = 这次不查',
      },
      save_to: s('把最终那张图另存到这个目录（会自己建目录）。省略就用设置页配的输出目录；两边都空就不额外复制'),
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
      // 挂 LoRA 就先把提示词文档看一遍（设置里没选目录时一个文件都不读，但结果会交代）
      let loraDocNote = ''
      let loraDocPrompt = ''
      let loraDocNegative = ''
      // lora:"auto" —— 按「用户最初的要求」里提到的角色名挑一个（中/日/罗马音别名都认）。
      // 只认唯一命中：认不出就照常重画并在结果里说明，认出多个就列候选，绝不瞎挂。
      let lora = args.lora === 'auto' ? '' : args.lora
      if (args.lora === 'auto') {
        const resolvedAuto = await resolveAutoLora(args.requirement ?? '', signal)
        lora = resolvedAuto.pick
        if (!lora) loraDocNote = resolvedAuto.note
      }
      if (lora && !features.draw.lora) {
        throw new Error(args.lora === 'auto'
          ? `LoRA 没开启：lora:"auto" 挑中了 ${lora}，但输入框左侧的 LoRA 开关是关的 —— 让用户点开再来。`
          : 'LoRA 没开启：在输入框左侧的绘图控件里把 LoRA 打开再来。')
      }
      if (lora) {
        if ((args.lora_doc ?? 'auto') === 'off') {
          loraDocNote = '提示词文档：这次传了 lora_doc:"off"，跳过了文档。'
        } else {
          const lookup = await lookupLoraDoc(lora, signal, args.requirement ?? '')
          const applied = applyLoraDoc(lookup)
          loraDocNote = applied.note
          loraDocPrompt = applied.prompt
          loraDocNegative = applied.negative
        }
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
        // 重画时也把 LoRA 文档的提示词段带上，否则第二轮就丢了角色设定
        const drawPrompt = composeLoraPrompt(newPrompt, loraDocPrompt)
        const index = await client.modelIndex({ signal })
        const models = resolveModels(index, { unet: features.draw.unet || undefined })
        const graph = buildTxt2Img({
          ...models,
          prompt: drawPrompt,
          negative: composeNegative(DEFAULT_NEGATIVE, loraDocNegative),
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
      if (loraDocNote) lines.push(loraDocNote)
      lines.push('')
      for (const item of reviewLog) {
        lines.push(`第 ${item.attempt} 轮：${item.satisfied ? '✓ 满意' : '✗ 不满意'} · 评分 ${item.score}/10`)
        if (item.feedback) lines.push(`  反馈：${item.feedback}`)
        if (item.new_prompt) lines.push(`  重画提示词：${item.new_prompt}`)
      }
      if (!satisfied) lines.push(`\n已达到最大重试 ${maxAttempts} 次，下面是最后一次的图。`)

      // 只复制最终那张（被否掉的草稿不落地），目录取值与 comfy_result 一致
      const requested = typeof args.save_to === 'string' ? args.save_to.trim() : ''
      const wanted = requested || features.output.dir
      if (wanted.length > 0) {
        try {
          const dir = resolveOutputDir(wanted, await resolvedOutputRoot(signal))
          const target = await saveImageCopy(dir, current.image, current.bytes)
          if (target) lines.push(`已保存 ${target}`)
        } catch (error) {
          lines.push(`! 保存失败：${error?.message ?? error}`)
        }
      }

      return { text: lines.join('\n'), images: [current.ref] }
    },
  })

  // ── 8. comfy_upscale ────────────────────────────────────────────────────
  registerComfyTool({
    name: 'comfy_upscale',
    description:
      '用算法（ImageScale，默认 lanczos）放大一张已生成的图。'
      + '需先在设置页开启 upscale。给 image_prompt_id（之前出图的 prompt_id）和宽高。',
    parameters: params({
      image_prompt_id: s('要放大的图的 prompt_id'),
      width: i('目标宽，正整数'),
      height: i('目标高，正整数'),
      method: { type: 'string', enum: ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'], description: '放大算法，默认 lanczos' },
      save_to: s('把放大后的图另存到这个目录（会自己建目录）。省略就用设置页配的输出目录；两边都空就不额外复制'),
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
      const { ref, filename, image, bytes: outBytes } = await submitAndFetch(graph, signal)
      const lines = [`已放大到 ${args.width}×${args.height}（${args.method ?? 'lanczos'}）。`, `输出：${filename}`]
      const requested = typeof args.save_to === 'string' ? args.save_to.trim() : ''
      const wanted = requested || features.output.dir
      if (wanted.length > 0) {
        try {
          const dir = resolveOutputDir(wanted, await resolvedOutputRoot(signal))
          const target = await saveImageCopy(dir, image, outBytes)
          if (target) lines.push(`已保存 ${target}`)
        } catch (error) {
          lines.push(`! 保存失败：${error?.message ?? error}`)
        }
      }
      return { text: lines.join('\n'), images: [ref] }
    },
  })

  // ── 9. comfy_lora_doc ──────────────────────────────────────────────────
  ctx.tools.register({
    name: 'comfy_lora_doc',
    description:
      '查「LoRA 提示词」目录里的文档。目录里可以混放各种文档，文件名也不必与 LoRA 名对齐 —— '
      + '给 lora 就按内容打分（文件名像不像、正文提没提到、内容像不像提示词）挑最像的那篇并给出打分表；'
      + '不给 lora 就列出目录里的候选。'
      + '目录在插件设置页里选；没选目录、目录不存在、挑不中、读不了都只是说明情况，不会报错。'
      + 'comfy_run / comfy_review 挂 LoRA 时会自动做同样的事并把 tag 段并进 prompt，'
      + '这个工具是用来「先看一眼」或者看全文的。'
      + '文档超过字数预算时默认只并入收口后的那几段，余下的部分用 rest: true 看、整篇用 full: true 看。',
    parameters: params({
      lora: s('LoRA 文件名（如 belle_anima_v1.safetensors）。省略则列出目录里的候选文档'),
      prompt: s('你打算用的正面提示词。给了就按「贴题程度」预演一遍挑段结果，跟 comfy_run 实际并进去的一致；不给就按原文顺序挑'),
      full: { type: 'boolean', description: 'true 时返回挑中那篇的全文（不截断），默认只给提示词段' },
      rest: { type: 'boolean', description: 'true 时返回「超过字数预算、没并进 prompt」的那部分原文（full 优先）' },
    }, []),
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args) {
      const features = readFeatureConfig(config)
      const dir = features.loraDocs.dir
      if (dir.length === 0) {
        return {
          text: '还没指定 LoRA 提示词目录。到插件设置页的「LoRA 提示词」那一栏点「选择」挑一个目录，'
            + '把提示词文档（以及别的说明、笔记都行）放进去；文件名不必与 LoRA 名对齐，'
            + '挂 LoRA 出图时会按内容自己挑。',
        }
      }
      let resolved
      try {
        resolved = resolveConfiguredDir(dir, await resolvedOutputRoot(AbortSignal.timeout(settings.timeoutMs)), 'LoRA 提示词目录')
      } catch (error) {
        return { text: `LoRA 提示词目录用不了：${error?.message ?? error}` }
      }
      const listed = await readLoraDocs(resolved)
      if (listed.ok !== true) {
        return { text: `LoRA 提示词目录读不了（${resolved}）：${listed.error ?? '未知原因'}` }
      }
      const docs = listed.docs ?? []
      const skipped = [...(listed.skipped ?? [])]
      const maxChars = features.loraDocs.maxChars
      const lora = typeof args.lora === 'string' ? args.lora.trim() : ''
      const probe = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (lora.length === 0) {
        if (docs.length === 0) {
          return { text: `目录里没有可用的文档：${resolved}\n认的扩展名是 .md / .markdown / .txt，最多往下走 ${LORA_DOC_MAX_DEPTH} 层。` }
        }
        // 没给 lora 时也把「像不像提示词」标出来：这条只看内容，跟名字无关
        const lines = [`LoRA 提示词目录：${resolved}`, `共 ${docs.length} 篇候选（含子文件夹）：`]
        for (const doc of docs) {
          let promptish = false
          try {
            const raw = await readFile(doc.file, 'utf8')
            const section = extractPromptSection(raw, { maxChars })
            promptish = looksLikePrompt(section.text.length > 0 ? section.text : raw)
          } catch {
            promptish = false
          }
          const where = doc.rel && doc.rel !== doc.name ? `（${doc.rel}）` : ''
          lines.push(`  ${doc.name}${where}，${doc.size} 字节${promptish ? ' ✓ 像提示词' : ''}`)
        }
        if (skipped.length > 0) {
          lines.push('', '跳过的：')
          for (const item of skipped) lines.push(`  ${item}`)
        }
        lines.push('', '挂 LoRA 出图时会按内容挑一篇并并进 prompt；想指定看哪篇，把 lora 传进来。')
        return { text: lines.join('\n') }
      }
      const ranked = await rankLoraDocs(docs, lora, { maxChars })
      skipped.push(...ranked.skipped)
      const { chosen, mode } = chooseLoraDoc(ranked.candidates)
      const table = []
      if (ranked.candidates.length > 0) {
        table.push('打分（前 5）：')
        for (const item of ranked.candidates.slice(0, 5)) {
          const why = item.reasons.length > 0 ? ` · ${item.reasons.join('、')}` : ''
          table.push(`  ${item.score.toString().padStart(3, ' ')}  ${item.doc?.name ?? ''}${why}`)
        }
      }
      if (!chosen) {
        const scanNote = ranked.stoppedBy === ''
          ? []
          : [`另有 ${ranked.notScanned.length} 篇没参与打分（${ranked.stoppedBy === 'limit' ? `超过 ${LORA_DOC_SCAN_LIMIT} 篇的上限` : `超过 ${Math.round(LORA_DOC_SCAN_BYTES / 1024 / 1024)} MB 的读取预算`}：${ranked.notScanned.slice(0, 3).join('、')}${ranked.notScanned.length > 3 ? ' …' : ''}）`]
        return {
          text: [`没挑到与「${lora}」相配的提示词文档（${ranked.scanned}/${ranked.total} 篇参与打分，门槛 ${LORA_DOC_STRONG_SCORE} 分）。`,
            ...table,
            ...scanNote,
            '',
            '这时 comfy_run / comfy_review 什么都不并入。要么把 LoRA 名写进文档正文或标题，',
            '要么把提示词单独写成一串逗号分隔的 tag（这样的文档更容易被认出来）。'].join('\n'),
        }
      }
      let raw = ''
      try {
        raw = await readFile(chosen.doc.file, 'utf8')
      } catch (error) {
        return { text: `读不了 ${chosen.doc.name}：${error?.code ?? error?.message ?? error}` }
      }
      if (args.full === true) {
        return {
          text: [`挑中：${chosen.doc.name}（${mode === 'sole' ? '目录里唯一像提示词的那篇' : '按内容匹配'}，${chosen.score} 分）`,
            ...table,
            '',
            raw.replace(/^\uFEFF/, '').trim()].join('\n'),
        }
      }
      const section = composeDocSection(raw, { maxChars, prompt: probe })
      if (section.text.length === 0) {
        return { text: `${chosen.doc.name} 里没有可用的提示词内容（整篇都是空白）。` }
      }
      const totalChars = section.totalChars
      const keptChars = section.keptChars
      const cutWord = CUT_WORDS[section.cut] ?? '边界'
      const head = `挑中：${chosen.doc.name}（${mode === 'sole' ? '目录里唯一像提示词的那篇' : '按内容匹配'}，${chosen.score} 分）`
      const negLine = section.negativeChars > 0
        ? `负面：${section.negativeChars} 字（挂 LoRA 出图时会并进 negative prompt）`
        : ''
      if (args.rest === true) {
        // tags 模式没有「后半段」：被落下的是「没挑中的段」，逐段列出来
        if (section.mode === 'tags') {
          if (section.unpicked.length === 0) {
            return { text: [head, `这篇没有剩余内容 —— ${section.pickedTotal} 段 tag（${keptChars} 字）全在预算 ${maxChars} 之内，全挑完了。`].join('\n') }
          }
          return {
            text: [
              head,
              `并进 prompt 的是 ${section.picked}/${section.pickedTotal} 段 tag、共 ${keptChars} 字（预算 ${maxChars}）；`
                + `另有 ${section.unpicked.length} 段没并：`,
              '',
              section.unpicked.join('\n\n'),
            ].join('\n'),
          }
        }
        const { body } = promptBody(raw)
        const trimmed = body.trim()
        // keptChars 之后就是被收口掉的那一段。数量按原文算（正好等于 total - kept），
        // 显示时才去掉开头的空行/分隔符 —— 否则正文第一行会是空的。
        const restText = trimmed.slice(keptChars)
        const restShown = restText.replace(/^[\s,，、;；]+/u, '')
        if (restText.length === 0) {
          return { text: [head, `这篇没有剩余内容 —— 全篇 ${totalChars} 字都在上限 ${maxChars} 之内。`].join('\n') }
        }
        return {
          text: [
            head,
            `并进 prompt 的是前 ${keptChars} 字（上限 ${maxChars}，切在${cutWord}）；后面还剩 ${restText.length} 字没并：`,
            '',
            restShown,
          ].join('\n'),
        }
      }
      // 挑段模式下「字」的口径是「tag 段挑了多少」，跟「整篇切到多少」不是一回事，要分开说
      const sizeLine = section.mode === 'tags'
        ? (section.truncated
          ? `字数：${section.picked}/${section.pickedTotal} 段 tag、共 ${keptChars} 字（预算 ${maxChars}；另有 ${section.unpicked.length} 段没并）\n`
            + `原文 ${totalChars} 字里有 ${section.tagChars} 字是 tag 段，其余 ${section.dropped} 块说明文字不会并进 prompt`
          : `字数：${section.picked} 段 tag、共 ${keptChars} 字（预算 ${maxChars}，全挑完了）\n`
            + `原文 ${totalChars} 字里跳过 ${section.dropped} 块说明文字`)
        : (section.truncated
          ? `字数：并进 prompt ${keptChars} / 原文 ${totalChars} 字（上限 ${maxChars}，切在${cutWord}；余下 ${Math.max(0, totalChars - keptChars)} 字没并）`
          : `字数：${totalChars} 字（全篇并进去了）`)
      const restHint = section.truncated
        ? (section.mode === 'tags'
          ? '想看没挑中的那几段传 rest:true；想看整篇原文传 full:true。'
          : '想看被截掉的后半段传 rest:true；想看整篇原文传 full:true。')
        : ''
      const sourceLine = section.mode === 'tags'
        ? (section.heading
          ? `取的段落：${section.heading} 下的 ${section.picked} 段 tag（散文行按行判定后跳过）`
          : `取的段落：${section.picked} 段 tag（文档里没有「# 提示词」小标题也能挑；散文行按行判定后跳过）`)
        : (section.heading ? `取的段落：${section.heading}` : '取的段落：全文（没找到「提示词 / Prompt」小标题）')
      return {
        text: [
          head,
          ...table,
          '',
          sourceLine,
          sizeLine,
          ...(negLine ? [negLine] : []),
          ...(restHint ? [restHint] : []),
          ...(skipped.length > 0 ? ['', '跳过的：', ...skipped.map((item) => `  ${item}`)] : []),
          '',
          section.text,
          ...(section.negative ? ['', '── 负面（negative prompt）──', section.negative] : []),
        ].join('\n'),
      }
    },
  })

  // ── 10. comfy_inspect ─────────────────────────────────────────────────
  registerComfyTool({
    name: 'comfy_inspect',
    description:
      '工作流分析器：读一份工作流 JSON（API 格式、UI 格式或本地 JSON 文件路径都行），'
      + '识别 Checkpoint / 三件套 / LoRA / 采样器 / 提示词 / 尺寸 / ControlNet / 输出等关键节点，'
      + '建立连线关系，列出 Agent 可以改的参数，并做连线一致性诊断（重复 ID / 槽位越界 / 类型不匹配 / 缺关键输入等）。'
      + 'UI 格式只识别连线与参数名，Widget 值不绑定到参数（按位置保存，不可靠）；'
      + '要精确改参数请用 ComfyUI 的 Save (API Format) 导出后再 inspect。第一版对 subgraph 只报边界与节点数，不解析内部。',
    parameters: params({
      graph: { type: 'object', additionalProperties: true, description: '工作流 JSON 对象。API 格式 { "1": { class_type, inputs } } 或 UI 格式 { nodes: [...], links: [...] }' },
      path: s('本地工作流 JSON 文件路径（和 graph 二选一；两个都给时以 graph 为准）'),
      compact: { type: 'boolean', description: 'true（默认）时限制输出条数，避免长工作流刷屏' },
    }, []),
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const hasGraph = args.graph !== undefined && args.graph !== null && typeof args.graph === 'object'
      const hasPath = typeof args.path === 'string' && args.path.trim().length > 0
      if (!hasGraph && !hasPath) {
        return { text: '至少给一个输入源：graph（工作流 JSON 对象）或 path（本地 JSON 文件路径）。' }
      }

      let input
      let source = 'graph'
      if (hasGraph) {
        input = args.graph
      } else {
        const raw = args.path.trim()
        source = `path ${raw}`
        let text
        try {
          text = await readFile(raw, 'utf8')
        } catch (error) {
          return { text: `读不了 ${raw}：${error?.code ?? error?.message ?? error}` }
        }
        try {
          input = JSON.parse(text.replace(/^\uFEFF/, ''))
        } catch (error) {
          return { text: `${raw} 不是合法 JSON：${error?.message ?? error}` }
        }
      }

      let parsed
      try {
        parsed = parseWorkflow(input)
      } catch (error) {
        return { text: `工作流解析失败（${source}）：${error?.message ?? error}` }
      }

      let result
      try {
        result = inspectWorkflow(parsed.graph, {
          diagnostics: parsed.diagnostics,
          subgraphs: parsed.subgraphs,
        })
      } catch (error) {
        return { text: `工作流分析失败（${source}）：${error?.message ?? error}` }
      }

      const lines = [`输入源：${source}`, describeInspection(result, { compact: args.compact !== false })]

      if (parsed.warnings.length > 0) {
        lines.push('', '── 提示 ──', ...parsed.warnings.map((w) => `  ! ${w}`))
      }

      if (parsed.subgraphs.length > 0) {
        lines.push('', '── 子图（只识别边界，未解析内部）──')
        for (const sub of parsed.subgraphs) {
          const ins = sub.inputs.map((p) => p.name).join(', ') || '（无）'
          const outs = sub.outputs.map((p) => p.name).join(', ') || '（无）'
          lines.push(`  ${sub.name} [${sub.id}]：${sub.nodeCount} 节点 / ${sub.linkCount} 连线`
            + ` · 输入端口 ${ins} · 输出端口 ${outs}`
            + (sub.instances.length > 0 ? ` · 实例节点 ${sub.instances.join(',')}` : ''))
          if (sub.bounds.input || sub.bounds.output) {
            lines.push(`    边界：in=${JSON.stringify(sub.bounds.input)} out=${JSON.stringify(sub.bounds.output)}`)
          }
        }
      }

      if (parsed.unresolved.length > 0) {
        lines.push('', '── 未解析的 UI 参数（只有参数名，没有可靠的值）──')
        for (const u of parsed.unresolved) {
          const names = u.params.join(', ') || '（无 widget 名）'
          lines.push(`  [${u.nodeId}] ${u.nodeType}${u.title ? `「${u.title}」` : ''}：参数 ${names}`
            + ` · 原始 widgets_values ${JSON.stringify(u.widgetsValues)}`)
        }
      }

      lines.push('', `输入格式：${parsed.format === 'api' ? 'API（参数值是执行契约，可精确修改）' : 'UI（编辑器状态，参数值不可靠）'}`
        + ` · 诊断 ${result.diagnostics.length} 条 · 子图 ${result.subgraphs.length} 个`)
      return { text: lines.join('\n') }
    },
  })

  // ── 只读路由：设置页的审图模型清单 + 对话栏的生图模型清单 ──────────────
  // 浏览器半端没有 llm 服务、也没有 comfy 客户端（client 侧只有
  // slots/locale/configForms 等），所以这两份清单必须由宿主开只读路由给它取。
  // connection.fetch 已自带鉴权（栅栏内的 admit），这里只管数据。
  const mountDataRoutes = (scope) => {
    const log = (msg) => {
      try { scope.logger('comfyui').info(msg) } catch { /* 忽略 */ }
    }
    const connection = scope.connection
      ?? (typeof scope.get === 'function' ? scope.get('connection') : undefined)
    if (!connection || typeof connection.fetch?.register !== 'function') {
      log('没有 connection.fetch，模型清单路由挂不上（审图模型改成跟随当前会话，生图模型只能手填，输出目录只能在 profile 里配）')
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
      log(`审图模型路由没挂上：${error?.message ?? error}`)
    }
    try {
      scope.effect(() => connection.fetch.register({
        path: DRAW_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            const index = await client.modelIndex({ signal: AbortSignal.timeout(settings.timeoutMs) })
            return jsonResponse({
              ok: true,
              folders: {
                diffusion_models: index.diffusion_models ?? [],
                checkpoints: index.checkpoints ?? [],
                text_encoders: index.text_encoders ?? [],
                vae: index.vae ?? [],
                loras: index.loras ?? [],
              },
            })
          } catch (error) {
            // ComfyUI 没起 / 超时：给前端一份空清单 + 原因，让它退回「自动」
            return jsonResponse({ ok: false, error: explain(error), folders: {} }, 502)
          }
        },
      }), 'comfyui: /api/comfyui/draw-models 路由')
    } catch (error) {
      log(`生图模型路由没挂上：${error?.message ?? error}`)
    }
    // ── LoRA 提示词目录清单（只读，只报「识别到几篇 / 其中几篇像提示词」）────
    // 设置页用它在路径下面显示「已识别 N 篇候选（M 篇像提示词）」，让人立刻确认路径选对了。
    try {
      scope.effect(() => connection.fetch.register({
        path: LORA_DOCS_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const features = readFeatureConfig(config).loraDocs
          const configured = features.dir
          if (configured.length === 0) {
            return jsonResponse({ ok: true, dir: '', maxChars: features.maxChars, count: 0, promptish: 0, docs: [] })
          }
          try {
            const dir = resolveConfiguredDir(
              configured,
              await resolvedOutputRoot(AbortSignal.timeout(settings.timeoutMs)),
              'LoRA 提示词目录',
            )
            const listed = await readLoraDocs(dir)
            if (listed.ok !== true) {
              return jsonResponse({
                ok: false, dir, error: listed.error ?? '读不了目录', count: 0, promptish: 0, docs: [],
              }, 502)
            }
            // 顺手标出「像提示词」的篇数：只读前 LORA_DOC_SCAN_LIMIT 篇，别把 IO 打满
            const docs = []
            let promptish = 0
            for (const doc of (listed.docs ?? []).slice(0, LORA_DOC_SCAN_LIMIT)) {
              let like = false
              try {
                const raw = await readFile(doc.file, 'utf8')
                // 判定口径必须与出图时一致：用设置里的字数上限
                const section = extractPromptSection(raw, { maxChars: features.maxChars })
                like = looksLikePrompt(section.text.length > 0 ? section.text : raw)
              } catch {
                like = false
              }
              if (like) promptish += 1
              docs.push({ name: doc.name, stem: doc.stem, key: doc.key, rel: doc.rel ?? doc.name, promptish: like })
            }
            return jsonResponse({
              ok: true, dir, maxChars: features.maxChars, count: docs.length, promptish, docs,
            })
          } catch (error) {
            return jsonResponse({
              ok: false, dir: configured, error: explain(error), count: 0, promptish: 0, docs: [],
            }, 502)
          }
        },
      }), 'comfyui: /api/comfyui/lora-docs 路由')
    } catch (error) {
      log(`LoRA 提示词目录路由没挂上：${error?.message ?? error}`)
    }
    // ── 唯一一条会写、也会阻塞的路由：弹原生文件夹选择框 ────────────────
    // 它只回传「用户点了哪个目录」，不落盘；写配置仍然走设置页的「保存」。
    // 连点两次会被 picking 挡住（第一次没关之前第二个框会把用户搞懵）。
    let picking = false
    try {
      scope.effect(() => connection.fetch.register({
        path: PICK_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (picking) {
            return jsonResponse({ ok: false, reason: 'busy', error: '已经有一个选择框开着' }, 409)
          }
          let payload = {}
          try {
            const text = await request.text()
            if (text.trim().length > 0) {
              const parsed = JSON.parse(text)
              if (parsed && typeof parsed === 'object') payload = parsed
            }
          } catch {
            return jsonResponse({ ok: false, reason: 'bad-request', error: '请求体要是 JSON' }, 400)
          }
          const initial = typeof payload.initial === 'string' ? payload.initial.trim().slice(0, 512) : ''
          picking = true
          try {
            const result = await pickDirectory({ initial })
            if (result.ok === true) return jsonResponse({ ok: true, path: result.path })
            if (result.cancelled === true) return jsonResponse({ ok: false, cancelled: true })
            return jsonResponse({ ok: false, reason: result.reason ?? 'failed', error: result.error ?? '' })
          } catch (error) {
            return jsonResponse({ ok: false, reason: 'failed', error: explain(error) }, 500)
          } finally {
            picking = false
          }
        },
      }), 'comfyui: /api/comfyui/pick-directory 路由')
    } catch (error) {
      log(`选择目录路由没挂上（输出目录只能在 profile 里配）：${error?.message ?? error}`)
    }

    // ── k91 会话视图「ComfyUI」页：快照 / 反查 / 图片 / 改参重提交 ──────────
    // 从 object_info 的 KSampler 定义里取 sampler_name / scheduler 枚举
    const enumOf = (info, key) => {
      const raw = info?.input?.required?.[key] ?? info?.input?.optional?.[key]
      return Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0].filter((v) => typeof v === 'string') : []
    }
    const workspaceSnapshot = async () => {
      const signal = AbortSignal.timeout(settings.timeoutMs)
      const [queue, jobs, generated, samplerInfo, loraFiles, historyList] = await Promise.all([
        client.queue({ signal }).catch(() => ({ queue_running: [], queue_pending: [] })),
        client.jobs({ limit: 20, signal }).catch(() => []),
        workspaceStore.recent(20).catch(() => []),
        client.nodeInfo('KSampler', { signal }).catch(() => null),
        client.models('loras', { signal }).catch(() => []),
        client.history(40, { signal }).catch(() => []),
      ])
      // 索引里的记录只有经过 comfy_result 才会补上文件名；只用 comfy_run 提交过的任务
      // files 会是空的，视图端就没缩略图。这里用原生 /history 兜底补全并回写索引。
      const empty = generated.filter((rec) => !Array.isArray(rec?.files) || rec.files.length === 0)
      if (empty.length && Array.isArray(historyList) && historyList.length) {
        const byId = new Map(historyList.map((h) => [String(h.promptId), h.entry]))
        for (const rec of empty) {
          const entry = byId.get(String(rec.promptId))
          if (!entry) continue
          const images = collectImages(entry)
          if (!images.length) continue
          rec.files = images
          try { await workspaceStore.updateFiles(rec.promptId, images) } catch { /* 回写失败不影响本次展示 */ }
        }
      }
      // 别的电脑没有旁侧索引，generated 会是空的 —— 产出图片页就白屏。
      // 把 /history 里有图的任务合成成生成记录补进来，让产出图片页 / 队列 /
      // 工作流选择器共用同一份数据（队列此前已靠 jobs[].images 出图）。
      const knownIds = new Set(generated.map((rec) => String(rec?.promptId ?? '')))
      const imagesById = new Map()
      if (Array.isArray(historyList)) {
        for (const h of historyList) {
          const pid = String(h?.promptId ?? '')
          const imgs = h?.entry ? collectImages(h.entry) : []
          if (imgs.length) imagesById.set(pid, imgs)
          // 索引里没这条 → 合成一条展示记录（不落盘）
          if (pid && !knownIds.has(pid)) {
            const rec = historyToRecord(pid, h.entry)
            if (rec) {
              generated.push(rec)
              knownIds.add(pid)
            }
          }
        }
      }
      // 最近生成的排前面：合成的 history 记录没 createdAt，放索引记录之后。
      generated.sort((a, b) => String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')))
      const jobsWithImages = (Array.isArray(jobs) ? jobs : []).map((job) => {
        const id = String(job?.id ?? job?.prompt_id ?? '')
        const imgs = id ? imagesById.get(id) : null
        return imgs ? { ...job, images: imgs } : job
      })
      let online = true
      let offlineReason = ''
      try {
        await client.systemStats({ signal })
      } catch (error) {
        online = false
        offlineReason = explain(error)
      }
      return {
        ok: true,
        online,
        offlineReason,
        baseUrl: client.baseUrl,
        queue: {
          running: Array.isArray(queue?.queue_running) ? queue.queue_running : [],
          pending: Array.isArray(queue?.queue_pending) ? queue.queue_pending : [],
        },
        jobs: jobsWithImages,
        generated,
        samplers: enumOf(samplerInfo, 'sampler_name'),
        schedulers: enumOf(samplerInfo, 'scheduler'),
        loras: Array.isArray(loraFiles) ? loraFiles : [],
      }
    }

    try {
      scope.effect(() => connection.fetch.register({
        path: WORKSPACE_SNAPSHOT_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return jsonResponse(await workspaceSnapshot())
          } catch (error) {
            return jsonResponse({ ok: false, error: explain(error) }, 500)
          }
        },
      }), 'comfyui: /api/comfyui/workspace/snapshot 路由')
    } catch (error) {
      log(`工作区快照路由没挂上：${error?.message ?? error}`)
    }

    try {
      scope.effect(() => connection.fetch.register({
        path: WORKSPACE_WORKFLOW_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const url = new URL(request.url)
            const promptId = (url.searchParams.get('promptId') ?? '').trim()
            const filename = (url.searchParams.get('filename') ?? '').trim()
            if (!promptId && !safeFilename(filename)) {
              return jsonResponse({ ok: false, reason: '要给 promptId 或 filename' }, 400)
            }
            const result = await resolveWorkflow({
              store: workspaceStore,
              client,
              promptId,
              filename,
            })
            return jsonResponse(result.ok ? result : { ok: false, ...result })
          } catch (error) {
            return jsonResponse({ ok: false, reason: explain(error) }, 500)
          }
        },
      }), 'comfyui: /api/comfyui/workspace/workflow 路由')
    } catch (error) {
      log(`工作流反查路由没挂上：${error?.message ?? error}`)
    }

    try {
      scope.effect(() => connection.fetch.register({
        path: WORKSPACE_IMAGE_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const url = new URL(request.url)
          const filename = safeFilename(url.searchParams.get('filename'))
          if (!filename) return jsonResponse({ ok: false, reason: '文件名不合法' }, 400)
          const subfolder = (url.searchParams.get('subfolder') ?? '').trim()
          // 防路径穿越：subfolder 只能是相对路径段，不能含 ..
          if (subfolder.includes('..') || subfolder.includes('\\') || subfolder.startsWith('/')) {
            return jsonResponse({ ok: false, reason: '子目录不合法' }, 400)
          }
          const type = ['output', 'temp', 'input'].includes(url.searchParams.get('type'))
            ? url.searchParams.get('type')
            : 'output'
          try {
            const bytes = await client.view({ filename, subfolder, type }, { signal: AbortSignal.timeout(settings.timeoutMs) })
            const mediaType = sniffMediaType(bytes)
            if (!mediaType) return jsonResponse({ ok: false, reason: '不是认识的图片格式' }, 415)
            return new Response(bytes, {
              status: 200,
              headers: {
                'content-type': mediaType,
                'cache-control': 'no-store',
                'content-length': String(bytes.length),
              },
            })
          } catch (error) {
            return jsonResponse({ ok: false, reason: explain(error) }, 502)
          }
        },
      }), 'comfyui: /api/comfyui/workspace/image 路由')
    } catch (error) {
      log(`产出图代理路由没挂上：${error?.message ?? error}`)
    }

    try {
      scope.effect(() => connection.fetch.register({
        path: WORKSPACE_SUBMIT_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let payload
          try {
            const text = await request.text()
            payload = JSON.parse(text)
          } catch {
            return jsonResponse({ ok: false, reason: '请求体要是 JSON' }, 400)
          }
          const rawGraph = payload?.graph
          if (!rawGraph || typeof rawGraph !== 'object' || !Object.values(rawGraph).some((n) => n && typeof n === 'object' && 'class_type' in n)) {
            return jsonResponse({ ok: false, reason: 'graph 必须是 API 格式的工作流' }, 400)
          }
          try {
            // 视图上改的参数在这里写回原图：节点 id / 连线 / 其余节点原样保留。
            const edited = payload?.params ? applyWorkflowParams(rawGraph, payload.params) : rawGraph
            const normalized = normalizeGraph(edited)
            const submitted = await submitAndIndex(normalized, {
              signal: AbortSignal.timeout(settings.timeoutMs),
              title: typeof payload.title === 'string' ? payload.title.slice(0, 120) : '视图改参重提交',
              params: extractWorkflowParams(normalized),
            })
            if (!submitted.ok) {
              return jsonResponse({ ok: false, reason: 'ComfyUI 拒了这张工作流', nodeErrors: submitted.nodeErrors ?? null }, 422)
            }
            return jsonResponse({ ok: true, promptId: submitted.promptId, number: submitted.number ?? null })
          } catch (error) {
            return jsonResponse({ ok: false, reason: explain(error) }, 500)
          }
        },
      }), 'comfyui: /api/comfyui/workspace/submit 路由')
    } catch (error) {
      log(`改参重提交路由没挂上：${error?.message ?? error}`)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], mountDataRoutes)
  } else {
    // 极简 ctx（离线冒烟测试）走这一支；没有 connection 就静静地跳过
    mountDataRoutes(ctx)
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
              '「绘图模式」的会话里，输入框左侧有绘图控件：默认生图模型与 LoRA 开关都在那里选，' +
                '模型列表分两组 —— 扩散模型（diffusion_models，三件套加载器）和整合包（checkpoints，' +
                '一个文件就带 MODEL/CLIP/VAE）。' +
                '对话栏选的模型优先；只有它停在「自动」时，comfy_run 的 unet 参数才生效。' +
                '⚠️ 你看不到那边选了什么 —— 想知道就用 comfy_models，它开头会报「当前绘图配置」' +
                '（正在用哪个模型、LoRA 允不允许挂、提示词目录配了没有）。别凭世界知识猜该用哪个模型。' +
                'LoRA 没开就别传 lora；开了但不知道挂哪个，传 lora:"auto" 让插件按 prompt 里的角色名挑' +
                '（中文 / 日文 / 罗马音都认，认不出或认出多个它都会说明，不瞎挂）。' +
                '别的模式没有这两个控件，要指定模型就显式传 unet。',
              'img2img：comfy_run mode="img2img" + image_prompt_id（底图）+ denoise 做重绘（先在图生图开关里打开）。',
              'comfy_review：让审图模型看一张图判断是否满足要求、不满意自动重画（设置页开启 review 并指定模型）。',
              '要判断「角色是否还原」时，把参考图的 prompt_id 一起传给 comfy_review 的 reference_prompt_id —— 它会把两张图一起交给审图模型比对。',
              'comfy_upscale：用算法放大一张图（放大开关在插件设置页里开）。',
              '图片落在哪：默认就是 ComfyUI 自己的 output 目录（comfy_result 会报出完整路径）；设置页的「输出目录」配了就额外复制一份过去，save_to 可以单次覆盖。那一栏只有「选择」按钮（点开是系统文件夹选择框）和一个「清除」，没有手填框。',
              'LoRA 提示词：设置页的「LoRA 提示词」可以指定一个目录。目录里可以混放各种文档（角色说明、画风笔记、tag 清单都行），'
                + '文件名也不必与 LoRA 名对齐 —— comfy_run / comfy_review 挂 LoRA 时会读进来按内容打分（文件名像不像、正文提没提到、'
                + '内容像不像提示词），挑最像的那篇，再把里面真正的 tag 行并进 prompt，并在结果里说明挑中了哪篇、为什么。'
                + '文档里的说明文字（模型信息、作者原话、踩坑清单、参数建议）不会被并进去 —— 只有逐行判定成 tag 的段才进 prompt；'
                + '「负面：」/「—— 可用负面词 ——」下面那段会并进 negative prompt。'
                + '多套服装的文档（一套衣服一节，或一章挂多套）按「套」挑：你说「穿女仆装」就只并女仆那一套 + 角色本体锚点，'
                + '绝不把校服、服务员、旗袍同时塞进去互相打架；没点名服装就并锚点 + 第一套；文档里没有你说的那套（走同义词也找不到）'
                + '就只并角色本体，并在结果里明说「服装段自己写」。所以换衣服场景不用再传 lora_doc:"off" 关文档。'
                + '没传 lora 时一个文件都不读，结果里会明说「这次没传 lora，没读文档」。'
                + '想先看一眼用 comfy_lora_doc（给 lora 看打分表与那篇的 tag 段与负面段，不给就列候选；full:true 看全文）。'
                + '字数预算默认 4000、设置页可调 200–20000，管的是「并进去的 tag 一共多少字」；结果里会写明并的是哪一套服装、'
                + '锚点多少字、共多少字、负面多少字；要看没挑中的那几套传 rest:true，要看整篇传 full:true。'
                + '传 lora_doc:"off" 可以只对这一次跳过。',
              '工作流分析：拿到一份工作流 JSON，先用 comfy_inspect 看清结构 —— 它会列出关键节点、连线、Agent 可改参数和诊断（重复 ID / 断链 / 槽位越界 / 类型不匹配 / 缺关键输入）。'
                + 'UI 格式（有 nodes/links 数组）的 Widget 值是按位置保存的，comfy_inspect 只给参数名不绑定值；'
                + '要精确修改参数，请让对方用 ComfyUI 的 Save (API Format) 导出后再 inspect。'
                + '发现子图时 comfy_inspect 只报边界与节点数，不解析内部；要分析子图内部请单独导出它。'
                + '连线有诊断时先看诊断栏再动手。',
              '1024×1024 在消费级显卡上单张通常要几十秒到两分钟，所以 comfy_result 要带 wait_seconds（单张 120，多张按张数加）。',
              '显存吃紧时 batch 保持 1；要腾地方用 comfy_control free_vram。',
            ].join('\n'),
    }),
  )
}
