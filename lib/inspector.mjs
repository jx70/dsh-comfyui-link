/**
 * lib/inspector.mjs —— 工作流语义分析核心（纯函数）
 * ============================================================================
 * 设计约束（由 test/inspector.test.mjs 钉死）：
 *   · 只接受 API 格式图：{ "节点id": { class_type, inputs } }
 *   · 零网络、零 UI 格式知识：本文件不认识 UI 编辑器的序列化字段，
 *     不维护任何 widget 顺序表，不做名字与位置值的绑定。
 *   · UI 图必须先经 lib/format-adapter.mjs 转成 API 结构图再送进来。
 *
 * 本文件只做四件事：
 *   1. classifyNode    —— 按 class_type 给节点打语义标签
 *   2. buildEdges      —— 扫 inputs 里的 [nodeId, slot] 引用，建边 + 诊断
 *   3. findEditable    —— 列 Agent 可改的具名标量参数（全部 exact）
 *   4. inspectWorkflow / describeInspection —— 汇总 + 模型易读文本
 * ============================================================================
 */
import { ComfyError } from './comfy.mjs'

/** 语义分类名（稳定字符串，给模型看） */
export const CATEGORY = Object.freeze({
  CHECKPOINT: 'checkpoint',
  LORA: 'lora',
  SAMPLER: 'sampler',
  PROMPT: 'prompt',
  LATENT_SIZE: 'latent-size',
  CONTROLNET: 'controlnet',
  OUTPUT: 'output',
  LOADER_UNET: 'loader-unet',
  LOADER_CLIP: 'loader-clip',
  LOADER_VAE: 'loader-vae',
  IMAGE_LOAD: 'image-load',
  VAE_ENCODE: 'vae-encode',
  VAE_DECODE: 'vae-decode',
  UPSCALE: 'upscale',
  REROUTE: 'reroute',
  OTHER: 'other',
})

/** 精确匹配优先，其次前缀匹配。前缀表只放语义明确的族。 */
const EXACT_CLASS = {
  CheckpointLoaderSimple: CATEGORY.CHECKPOINT,
  CheckpointLoader: CATEGORY.CHECKPOINT,
  UNETLoader: CATEGORY.LOADER_UNET,
  CLIPLoader: CATEGORY.LOADER_CLIP,
  DualCLIPLoader: CATEGORY.LOADER_CLIP,
  TripleCLIPLoader: CATEGORY.LOADER_CLIP,
  VAELoader: CATEGORY.LOADER_VAE,
  LoraLoader: CATEGORY.LORA,
  LoraLoaderModelOnly: CATEGORY.LORA,
  KSampler: CATEGORY.SAMPLER,
  KSamplerAdvanced: CATEGORY.SAMPLER,
  CLIPTextEncode: CATEGORY.PROMPT,
  EmptyLatentImage: CATEGORY.LATENT_SIZE,
  EmptySD3LatentImage: CATEGORY.LATENT_SIZE,
  EmptyLatentImageByAspectRatio: CATEGORY.LATENT_SIZE,
  ControlNetLoader: CATEGORY.CONTROLNET,
  ControlNetApply: CATEGORY.CONTROLNET,
  ControlNetApplyAdvanced: CATEGORY.CONTROLNET,
  ApplyControlNet: CATEGORY.CONTROLNET,
  SaveImage: CATEGORY.OUTPUT,
  PreviewImage: CATEGORY.OUTPUT,
  SaveImageWebsocket: CATEGORY.OUTPUT,
  LoadImage: CATEGORY.IMAGE_LOAD,
  VAEEncode: CATEGORY.VAE_ENCODE,
  VAEDecode: CATEGORY.VAE_DECODE,
  ImageScale: CATEGORY.UPSCALE,
  ImageScaleBy: CATEGORY.UPSCALE,
  ImageUpscaleWithModel: CATEGORY.UPSCALE,
  UpscaleModelLoader: CATEGORY.UPSCALE,
  Reroute: CATEGORY.REROUTE,
}

const PREFIX_CLASS = [
  [/^Sampler/i, CATEGORY.SAMPLER],
  [/^BasicScheduler|^Scheduler|KarrasScheduler|ExponentialScheduler|BetaScheduler|SgmUniformSampler/i, CATEGORY.SAMPLER],
  [/ControlNet/i, CATEGORY.CONTROLNET],
  [/^Save(?!Image)/i, CATEGORY.OUTPUT],
]

/** 按 class_type 打语义标签；未知归 other，不猜。 */
export function classifyNode(class_type) {
  if (typeof class_type !== 'string' || class_type.length === 0) return CATEGORY.OTHER
  if (EXACT_CLASS[class_type]) return EXACT_CLASS[class_type]
  for (const [re, cat] of PREFIX_CLASS) if (re.test(class_type)) return cat
  return CATEGORY.OTHER
}

/**
 * 关键节点的必需输入表。既供 API 图诊断，也由 adapter 复用于 UI 图诊断，
 * 因此放在这个纯语义模块里导出 —— 它本身不知道任何 UI 序列化概念。
 */
const REQUIRED_INPUTS = {
  CheckpointLoaderSimple: ['ckpt_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  CLIPLoader: ['clip_name', 'type'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type'],
  TripleCLIPLoader: ['clip_name1', 'clip_name2', 'clip_name3', 'type'],
  VAELoader: ['vae_name'],
  LoraLoader: ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'],
  LoraLoaderModelOnly: ['model', 'lora_name', 'strength_model'],
  KSampler: ['model', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image'],
  KSamplerAdvanced: ['model', 'add_noise', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image'],
  CLIPTextEncode: ['text', 'clip'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  ControlNetLoader: ['control_net_name'],
  ControlNetApply: ['conditioning', 'control_net', 'image'],
  ControlNetApplyAdvanced: ['positive', 'negative', 'control_net', 'image'],
  VAEEncode: ['pixels', 'vae'],
  VAEDecode: ['samples', 'vae'],
  LoadImage: ['image'],
  ImageScale: ['image', 'upscale_method', 'width', 'height', 'crop'],
}
export function requiredInputsFor(class_type) {
  return REQUIRED_INPUTS[class_type] ?? []
}

/** 已知节点的输出个数（用于 API 图输出槽位越界诊断）；未知返回 null 表示不判。 */
const OUTPUT_COUNT = {
  CheckpointLoaderSimple: 3, CheckpointLoader: 3,
  UNETLoader: 1, CLIPLoader: 1, DualCLIPLoader: 1, TripleCLIPLoader: 1, VAELoader: 1,
  LoraLoader: 2, LoraLoaderModelOnly: 1,
  CLIPTextEncode: 1, EmptyLatentImage: 1, EmptySD3LatentImage: 1, EmptyLatentImageByAspectRatio: 1,
  KSampler: 1, KSamplerAdvanced: 1,
  VAEDecode: 1, VAEEncode: 1, LoadImage: 2, ImageScale: 1, ImageScaleBy: 1,
  ControlNetLoader: 1, ControlNetApply: 1, ControlNetApplyAdvanced: 1,
  UpscaleModelLoader: 1, ImageUpscaleWithModel: 1, Reroute: 1,
  SaveImage: 0, PreviewImage: 0, SaveImageWebsocket: 0,
}
export function outputCountFor(class_type) {
  return OUTPUT_COUNT[class_type] ?? null
}

/** 已知输出槽位的类型（尽力做类型匹配；未知返回 null 不判）。 */
const OUTPUT_TYPE = {
  CheckpointLoaderSimple: ['MODEL', 'CLIP', 'VAE'],
  UNETLoader: ['MODEL'], CLIPLoader: ['CLIP'], DualCLIPLoader: ['CLIP'], TripleCLIPLoader: ['CLIP'],
  VAELoader: ['VAE'], LoraLoader: ['MODEL', 'CLIP'], LoraLoaderModelOnly: ['MODEL'],
  CLIPTextEncode: ['CONDITIONING'], EmptyLatentImage: ['LATENT'], EmptySD3LatentImage: ['LATENT'],
  KSampler: ['LATENT'], KSamplerAdvanced: ['LATENT'],
  VAEDecode: ['IMAGE'], VAEEncode: ['LATENT'], LoadImage: ['IMAGE', 'MASK'],
  ControlNetLoader: ['CONTROL_NET'], ControlNetApply: ['CONDITIONING'],
  ControlNetApplyAdvanced: ['CONDITIONING', 'CONDITIONING'], Reroute: ['*'],
}

/** 已知输入参数期望的类型（按 class_type + 参数名）；未知返回 null 不判。 */
const INPUT_TYPE = {
  KSampler: { model: 'MODEL', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT' },
  KSamplerAdvanced: { model: 'MODEL', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT' },
  CLIPTextEncode: { clip: 'CLIP' },
  VAEDecode: { samples: 'LATENT', vae: 'VAE' },
  VAEEncode: { pixels: 'IMAGE', vae: 'VAE' },
  LoraLoader: { model: 'MODEL', clip: 'CLIP' },
  LoraLoaderModelOnly: { model: 'MODEL' },
  ControlNetApply: { conditioning: 'CONDITIONING', control_net: 'CONTROL_NET', image: 'IMAGE' },
  ControlNetApplyAdvanced: { positive: 'CONDITIONING', negative: 'CONDITIONING', control_net: 'CONTROL_NET', image: 'IMAGE' },
  ImageScale: { image: 'IMAGE' },
  SaveImage: { images: 'IMAGE' },
}

function diag(code, severity, message, extra = {}) {
  return { code, severity, scope: 'top', message, ...extra }
}

/** 是不是 API 图里的连线引用 [nodeId, slot] */
export function isLinkRef(value) {
  return Array.isArray(value)
    && value.length === 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number'
}

function typeCompatible(actual, expected) {
  if (!actual || !expected) return true
  if (actual === '*' || expected === '*') return true
  return String(actual).toUpperCase() === String(expected).toUpperCase()
}

/**
 * 建边 + 诊断。只吃 API 图。
 * 返回 { edges, dangling, diagnostics }。
 */
export function buildEdges(graph) {
  if (!isApiGraph(graph)) throw new ComfyError('buildEdges 只接受 API 格式图；UI 图请先经 format-adapter', { code: 'GRAPH' })

  const edges = []
  const dangling = []
  const diagnostics = []

  for (const [toId, node] of Object.entries(graph)) {
    for (const [param, value] of Object.entries(node.inputs ?? {})) {
      if (!isLinkRef(value)) continue
      const fromId = String(value[0])
      const fromSlot = value[1]
      const fromNode = graph[fromId]
      if (!fromNode) {
        dangling.push({ from: fromId, fromSlot, to: toId, toSlot: param })
        diagnostics.push(diag('DANGLING_LINK', 'warning',
          `节点 ${toId} 的输入 ${param} 引用了不存在的节点 ${fromId}`, { to: toId, from: fromId }))
        continue
      }
      const outCount = outputCountFor(fromNode.class_type)
      if (outCount !== null && fromSlot >= outCount) {
        diagnostics.push(diag('OUTPUT_SLOT_OUT_OF_RANGE', 'error',
          `节点 ${toId} 的输入 ${param} 引用 ${fromId}(${fromNode.class_type}) 的输出槽 ${fromSlot}，但该节点只有 ${outCount} 个输出`,
          { to: toId, from: fromId, slot: fromSlot }))
      }
      const actualType = OUTPUT_TYPE[fromNode.class_type]?.[fromSlot] ?? null
      const expectedType = INPUT_TYPE[node.class_type]?.[param] ?? null
      if (actualType && expectedType && !typeCompatible(actualType, expectedType)) {
        diagnostics.push(diag('TYPE_MISMATCH', 'warning',
          `连线 ${fromId}[${fromSlot}](${actualType}) → ${toId}.${param}(期望 ${expectedType}) 类型不匹配`,
          { to: toId, from: fromId, slot: fromSlot }))
      }
      edges.push({
        from: fromId,
        fromSlot,
        fromType: fromNode.class_type,
        to: toId,
        toSlot: param,
        toType: node.class_type,
        type: actualType ?? expectedType ?? null,
      })
    }
  }

  // 关键节点缺少必需输入：完全没有这个 key，或值为空（null/undefined/''）且不是连线
  for (const [id, node] of Object.entries(graph)) {
    for (const name of requiredInputsFor(node.class_type)) {
      if (Object.prototype.hasOwnProperty.call(node.inputs ?? {}, name)) {
        const v = node.inputs[name]
        if (isLinkRef(v)) continue // 有连线，且 dangling 已单独报
        if (v === null || v === undefined || v === '') {
          diagnostics.push(diag('MISSING_REQUIRED_INPUT', 'warning',
            `节点 ${id}(${node.class_type}) 的必需输入 ${name} 是空的`, { node: id }))
        }
        continue
      }
      diagnostics.push(diag('MISSING_REQUIRED_INPUT', 'warning',
        `节点 ${id}(${node.class_type}) 缺必需输入 ${name}`, { node: id }))
    }
  }
  return { edges, dangling, diagnostics }
}

/**
 * Agent 可改参数：具名标量输入，且没有被连线覆盖。
 * 每条都带 confidence:'exact' —— API 图的参数值就是执行契约里的值。
 */
export function findEditable(graph) {
  if (!isApiGraph(graph)) throw new ComfyError('findEditable 只接受 API 格式图；UI 图请先经 format-adapter', { code: 'GRAPH' })
  const out = []
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [param, value] of Object.entries(node.inputs ?? {})) {
      if (isLinkRef(value)) continue
      if (value === null || value === undefined) continue
      if (typeof value === 'object') continue
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
      out.push({
        nodeId,
        nodeType: node.class_type,
        category: classifyNode(node.class_type),
        param,
        value,
        kind: typeof value,
        confidence: 'exact',
      })
    }
  }
  return out
}

/** 是不是 API 图：键→{class_type:string, inputs:object}；拒绝 UI 编辑器字段。 */
export function isApiGraph(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return false
  const entries = Object.entries(graph)
  if (entries.length === 0) return false
  for (const [, node] of entries) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    if (typeof node.class_type !== 'string') return false
    // UI 节点的 inputs 是数组，API 节点的 inputs 是具名对象
    if (node.inputs !== undefined && (typeof node.inputs !== 'object' || Array.isArray(node.inputs))) return false
  }
  return true
}

/**
 * 汇总。opts.diagnostics / opts.subgraphs 由 adapter 透传（UI 图的诊断与子图边界）。
 * 核心自己只补 API 图能算的部分。
 */
export function inspectWorkflow(graph, opts = {}) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new ComfyError('工作流必须是对象', { code: 'GRAPH' })
  }
  if (!isApiGraph(graph)) {
    throw new ComfyError('这不是 API 格式图（缺少 class_type 或 inputs 形状不对）；UI 图请先经 format-adapter', { code: 'GRAPH' })
  }
  const { edges, dangling, diagnostics: ownDiagnostics } = buildEdges(graph)
  const editable = findEditable(graph)

  const categories = {}
  const keyNodes = []
  for (const [id, node] of Object.entries(graph)) {
    const category = classifyNode(node.class_type)
    categories[category] = (categories[category] ?? 0) + 1
    if (category !== CATEGORY.OTHER && category !== CATEGORY.REROUTE) {
      keyNodes.push({
        id,
        classType: node.class_type,
        category,
        title: node._meta?.title ?? null,
      })
    }
  }

  const merged = [...(opts.diagnostics ?? []), ...ownDiagnostics]
  return {
    nodeCount: Object.keys(graph).length,
    categories,
    keyNodes,
    edges,
    dangling,
    editable,
    diagnostics: merged,
    subgraphs: opts.subgraphs ?? [],
  }
}

function truncate(items, limit) {
  if (items.length <= limit) return { shown: items, omitted: 0 }
  return { shown: items.slice(0, limit), omitted: items.length - limit }
}

/**
 * 模型易读文本。四栏：关键节点 / 连接关系 / 可改参数 / 诊断。
 * 子图栏、UI unresolved 栏由 index.js 追加（核心不感知这些概念）。
 */
export function describeInspection(result, { compact = true, maxEdges = 40, maxEditable = 60, maxDiagnostics = 40 } = {}) {
  const lines = []
  lines.push(`节点 ${result.nodeCount} 个：${Object.entries(result.categories).map(([k, v]) => `${k}×${v}`).join(' ') || '（无）'}`)

  lines.push('')
  lines.push('── 关键节点 ──')
  if (result.keyNodes.length === 0) {
    lines.push('（没有识别出已知的关键类型；其余节点按 other 处理）')
  } else {
    const limit = compact ? 60 : result.keyNodes.length
    const { shown, omitted } = truncate(result.keyNodes, limit)
    for (const n of shown) {
      lines.push(`  [${n.id}] ${n.classType}${n.title ? `「${n.title}」` : ''} → ${n.category}`)
    }
    if (omitted) lines.push(`  …还有 ${omitted} 个关键节点未显示`)
  }

  lines.push('')
  lines.push('── 连接关系 ──')
  if (result.edges.length === 0) {
    lines.push('（没有连线）')
  } else {
    const { shown, omitted } = truncate(result.edges, maxEdges)
    for (const e of shown) {
      lines.push(`  ${e.from}[${e.fromSlot}] → ${e.to}.${e.toSlot}${e.type ? ` (${e.type})` : ''}`)
    }
    if (omitted) lines.push(`  …还有 ${omitted} 条连线未显示`)
    if (result.dangling.length > 0) lines.push(`  断链 ${result.dangling.length} 条（见诊断栏）`)
  }

  lines.push('')
  lines.push('── 可改参数（confidence: exact）──')
  if (result.editable.length === 0) {
    lines.push('（没有可直接改的具名参数；UI 图需用 Save (API Format) 导出后才有精确值）')
  } else {
    const { shown, omitted } = truncate(result.editable, maxEditable)
    for (const p of shown) {
      lines.push(`  ${p.nodeId}.${p.param} = ${JSON.stringify(p.value)}  # ${p.nodeType} / ${p.category}`)
    }
    if (omitted) lines.push(`  …还有 ${omitted} 个参数未显示`)
  }

  lines.push('')
  lines.push('── 诊断 ──')
  if (result.diagnostics.length === 0) {
    lines.push('（没有发现问题）')
  } else {
    const order = { error: 0, warning: 1 }
    const sorted = [...result.diagnostics].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
    const { shown, omitted } = truncate(sorted, maxDiagnostics)
    for (const d of shown) {
      const scope = d.scope && d.scope !== 'top' ? ` [${d.scope}]` : ''
      lines.push(`  ${d.severity === 'error' ? '✗' : '!'} ${d.code}${scope}: ${d.message}`)
    }
    if (omitted) lines.push(`  …还有 ${omitted} 条诊断未显示`)
  }
  return lines.join('\n')
}
