/**
 * lib/workspace-store.mjs —— k91「ComfyUI」会话视图的共享数据层
 * ============================================================================
 * 职责（Host 侧，零 @deepseek-ai/* 依赖）：
 *   1. extractWorkflowParams(graph)  从 API 工作流里抽出可编辑参数（提示词 / 尺寸 /
 *      步数 / CFG / 种子 / 采样器 / LoRA），并记住这些参数所在节点的 id；
 *   2. applyWorkflowParams(graph,p)  把改过的参数写回同一张图（保持节点 id 与连线）；
 *   3. createWorkspaceStore(...)     旁侧索引的读写（jsonl，按 promptId upsert）；
 *   4. resolveWorkflow(...)          图 → 工作流反查：索引优先，ComfyUI 原生
 *      /history 兜底，查不到给可读原因。
 *
 * 存储约定：索引落在 ComfyUI output 根下的 `_dsh_meta/prompt-index.jsonl`。
 * 每行一条 { promptId, createdAt, graph, params, files, title }。
 * 不依赖 ComfyUI 历史是否被清 —— 出图时就把 graph + promptId 记下来。
 * 坏行跳过，单条 upsert 走「临时文件 + rename」原子写，绝不留下半截 jsonl。
 * ============================================================================
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { collectImages } from './comfy.mjs'

const META_DIR = '_dsh_meta'
const INDEX_NAME = 'prompt-index.jsonl'

const asId = (v) => (v === undefined || v === null ? '' : String(v))
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const numOr = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/** 文件名安全校验：只接受纯文件名，拒绝路径穿越 / 绝对路径 / 隐藏文件。 */
export function safeFilename(name) {
  const s = String(name ?? '').trim()
  if (!s || s.length > 512) return ''
  if (s.includes('..') || s.includes('/') || s.includes('\\') || s.startsWith('.')) return ''
  return basename(s)
}

/** 从节点连线引用里取 text；引用形如 ['3', 0]。 */
function linkedText(graph, ref) {
  if (!Array.isArray(ref) || typeof ref[0] !== 'string') return ''
  const node = graph[ref[0]]
  const text = node?.inputs?.text
  return typeof text === 'string' ? text : ''
}

function isTextNode(graph, id) {
  return graph[id]?.class_type === 'CLIPTextEncode'
}

/** 一张空参数表（查不到图时也给前端一个稳定结构）。 */
function emptyParams() {
  return {
    prompt: '', negative: '', width: 0, height: 0, batch: 1,
    steps: 0, cfg: 0, seed: 0, sampler: '', scheduler: '', denoise: 1,
    lora: [], model: '',
    nodes: { samplerId: '', latentId: '', positiveId: '', negativeId: '' },
  }
}

/**
 * 从 API 格式工作流里抽出可编辑参数。
 * 不按节点编号硬编码 —— 按 class_type 找，整合包和三件套都能吃。
 * positive/negative 优先顺着 KSampler 的连边找；连边不规整时退回前两个 CLIPTextEncode。
 */
export function extractWorkflowParams(graph) {
  if (!isPlainObject(graph)) return emptyParams()
  const entries = Object.entries(graph)

  const samplerEntry = entries.find(([, n]) => n?.class_type === 'KSampler')
    ?? entries.find(([, n]) => typeof n?.class_type === 'string' && n.class_type.startsWith('KSampler'))
  const samplerId = samplerEntry?.[0] ?? ''
  const si = samplerEntry?.[1]?.inputs ?? {}

  // 尺寸藏在不同类的 latent 节点里：标准 / SD3 / Flux / 按比例 等；
  // 再兜底扫描「任何一个带数字 width+height 输入的节点」，别让宽高变成 0。
  const LATENT_TYPES = [
    'EmptyLatentImage', 'EmptyLatentImageV2', 'LatentImage',
    'EmptySD3LatentImage', 'EmptyFluxLatentImage', 'EmptyLatentImageByAspectRatio',
  ]
  const hasSize = (n) => n?.inputs
    && Number.isFinite(Number(n.inputs.width)) && Number(n.inputs.width) > 0
    && Number.isFinite(Number(n.inputs.height)) && Number(n.inputs.height) > 0
  const latentEntry = entries.find(([, n]) => LATENT_TYPES.includes(n?.class_type))
    ?? entries.find(([, n]) => typeof n?.class_type === 'string' && /latent/i.test(n.class_type) && hasSize(n))
    ?? entries.find(([, n]) => hasSize(n))
  const latentId = latentEntry?.[0] ?? ''
  const li = latentEntry?.[1]?.inputs ?? {}

  const textEntries = entries.filter(([, n]) => n?.class_type === 'CLIPTextEncode')
  let positiveId = Array.isArray(si.positive) ? asId(si.positive[0]) : ''
  let negativeId = Array.isArray(si.negative) ? asId(si.negative[0]) : ''
  let prompt = linkedText(graph, si.positive)
  let negative = linkedText(graph, si.negative)
  if (!isTextNode(graph, positiveId)) {
    positiveId = textEntries[0]?.[0] ?? ''
    prompt = typeof textEntries[0]?.[1]?.inputs?.text === 'string' ? textEntries[0][1].inputs.text : ''
  }
  if (!isTextNode(graph, negativeId) || negativeId === positiveId) {
    negativeId = textEntries.find(([id]) => id !== positiveId)?.[0] ?? ''
    const negNode = negativeId ? graph[negativeId] : null
    negative = typeof negNode?.inputs?.text === 'string' ? negNode.inputs.text : ''
  }

  const ckpt = entries.find(([, n]) => n?.class_type === 'CheckpointLoaderSimple')?.[1]?.inputs?.ckpt_name
  const unet = entries.find(([, n]) => n?.class_type === 'UNETLoader')?.[1]?.inputs?.unet_name
  const model = typeof ckpt === 'string' ? ckpt : (typeof unet === 'string' ? unet : '')

  const lora = entries
    .filter(([, n]) => n?.class_type === 'LoraLoader' || n?.class_type === 'LoraLoaderModelOnly')
    .map(([id, n]) => ({
      id,
      name: typeof n?.inputs?.lora_name === 'string' ? n.inputs.lora_name : '',
      strengthModel: numOr(n?.inputs?.strength_model, 1),
      strengthClip: numOr(n?.inputs?.strength_clip, 1),
    }))

  return {
    prompt,
    negative,
    width: Math.max(0, Math.round(numOr(li.width, 0))),
    height: Math.max(0, Math.round(numOr(li.height, 0))),
    batch: Math.max(1, Math.round(numOr(li.batch_size, 1))),
    steps: Math.max(0, Math.round(numOr(si.steps, 0))),
    cfg: numOr(si.cfg, 0),
    seed: numOr(si.seed, 0),
    sampler: typeof si.sampler_name === 'string' ? si.sampler_name : '',
    scheduler: typeof si.scheduler === 'string' ? si.scheduler : '',
    denoise: numOr(si.denoise, 1),
    lora,
    model,
    nodes: { samplerId, latentId, positiveId, negativeId },
  }
}

const isLoraNode = (node) => node && typeof node.class_type === 'string' && /loraloader/i.test(node.class_type)

/** 新建节点 id：取现有数字 id 最大值 +1，避免和已有 id 冲突。 */
function nextNodeId(graph) {
  let max = 0
  for (const id of Object.keys(graph)) {
    const n = Number(id)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return String(max + 1)
}

/**
 * 重建 LoRA 链：按 specs 的顺序把 LoRA 串进 model/clip 链。
 * - 找到旧 LoRA 链的头（其 model 输入来源 = baseModel/baseClip）与所有下游消费者；
 * - 删掉全部旧 LoRA 节点，按 specs 新建并串链；
 * - 把原来消费 model/clip 的地方改指向新链尾。
 * 这样「添加 / 删除 / 排序 / 改强度」都统一走一条可靠路径。
 */
function rebuildLoraChain(graph, specs, nodes) {
  const loraIds = Object.keys(graph).filter((id) => isLoraNode(graph[id]))
  const loraSet = new Set(loraIds)
  const clone = (v) => {
    try { return structuredClone(v) } catch { return JSON.parse(JSON.stringify(v)) }
  }
  const isRef = (v) => Array.isArray(v) && typeof v[0] === 'string'

  let baseModel = null
  let baseClip = null
  const consumers = [] // [{ id, key, slot }] 需要改指向新链尾；slot=0 model / 1 clip

  if (loraIds.length) {
    // 链头：model 输入不来自另一个 LoRA 的那个
    const pred = new Map()
    for (const id of loraIds) {
      const m = graph[id]?.inputs?.model
      pred.set(id, isRef(m) && loraSet.has(m[0]) ? m[0] : null)
    }
    const head = loraIds.find((id) => !pred.get(id)) ?? loraIds[0]
    baseModel = isRef(graph[head]?.inputs?.model) ? clone(graph[head].inputs.model) : null
    baseClip = isRef(graph[head]?.inputs?.clip) ? clone(graph[head].inputs.clip) : null
    // 消费者：非 LoRA 节点里引用任意旧 LoRA 输出的输入
    for (const id of Object.keys(graph)) {
      if (loraSet.has(id)) continue
      const inputs = graph[id]?.inputs ?? {}
      for (const [key, v] of Object.entries(inputs)) {
        if (isRef(v) && loraSet.has(v[0])) consumers.push({ id, key, slot: Number(v[1]) === 1 ? 1 : 0 })
      }
    }
    for (const id of loraIds) delete graph[id]
  } else {
    // 图上没有 LoRA：base 从采样器的 model 与文本节点的 clip 推断
    const sampler = graph[nodes.samplerId]
    const textNode = graph[nodes.positiveId]
      ?? Object.values(graph).find((n) => n?.class_type === 'CLIPTextEncode')
    if (isRef(sampler?.inputs?.model)) baseModel = clone(sampler.inputs.model)
    if (isRef(textNode?.inputs?.clip)) baseClip = clone(textNode.inputs.clip)
    // 消费者：所有输入等于 baseModel / baseClip 的地方
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    for (const id of Object.keys(graph)) {
      for (const [key, v] of Object.entries(graph[id]?.inputs ?? {})) {
        if (baseModel && eq(v, baseModel)) consumers.push({ id, key, slot: 0 })
        else if (baseClip && eq(v, baseClip)) consumers.push({ id, key, slot: 1 })
      }
    }
  }

  let prevModel = baseModel
  let prevClip = baseClip
  let tail = null
  for (const spec of specs) {
    if (!spec || typeof spec.name !== 'string' || !spec.name) continue
    const id = nextNodeId(graph)
    graph[id] = {
      class_type: 'LoraLoader',
      inputs: {
        model: prevModel,
        clip: prevClip,
        lora_name: spec.name,
        strength_model: Number.isFinite(Number(spec.strengthModel)) ? Number(spec.strengthModel) : 1,
        strength_clip: Number.isFinite(Number(spec.strengthClip)) ? Number(spec.strengthClip) : 1,
      },
      _meta: { title: '加载 LoRA' },
    }
    prevModel = [id, 0]
    prevClip = [id, 1]
    tail = id
  }
  // 消费者改指向新链尾（prevModel/prevClip 在没 LoRA 时就是 base，全删自动退回基座）
  for (const { id, key, slot } of consumers) {
    if (!graph[id]?.inputs) continue
    const ref = slot === 1 ? prevClip : prevModel
    if (ref) graph[id].inputs[key] = clone(ref)
  }
  return tail
}

/**
 * 把前端改过的参数写回原图。节点 id 用 params.nodes 里记的，连线与其余节点原样保留。
 * LoRA：列表里的项若都带已存在的 id 且集合不变 → 原地改名字 / 强度；
 * 只要涉及新增（无 id）、删除或重排 → 重建整条 LoRA 链。
 */
export function applyWorkflowParams(graph, params) {
  if (!isPlainObject(graph) || !isPlainObject(params)) return graph
  let next
  try {
    next = structuredClone(graph)
  } catch {
    next = JSON.parse(JSON.stringify(graph))
  }
  // 前端改参提交时可能只带改过的字段、不带 nodes 定位；缺失时从原图自动兜底，
  // 保证「图上改参 → 写回同一张图」在任意调用方都可靠。
  const nodes = isPlainObject(params.nodes) && Object.keys(params.nodes).length
    ? params.nodes
    : extractWorkflowParams(graph).nodes

  const sampler = next[nodes.samplerId]
  if (sampler?.inputs) {
    const put = (key, value, cast) => {
      if (value === undefined || value === null || value === '') return
      const v = cast(value)
      if (Number.isFinite(v)) sampler.inputs[key] = v
    }
    put('steps', params.steps, (x) => Math.round(Number(x)))
    put('cfg', params.cfg, Number)
    put('seed', params.seed, (x) => Math.floor(Number(x)))
    put('denoise', params.denoise, Number)
    if (typeof params.sampler === 'string' && params.sampler) sampler.inputs.sampler_name = params.sampler
    if (typeof params.scheduler === 'string' && params.scheduler) sampler.inputs.scheduler = params.scheduler
  }

  const latent = next[nodes.latentId]
  if (latent?.inputs) {
    if (Number.isFinite(Number(params.width))) latent.inputs.width = Math.max(16, Math.round(Number(params.width) / 16) * 16)
    if (Number.isFinite(Number(params.height))) latent.inputs.height = Math.max(16, Math.round(Number(params.height) / 16) * 16)
    if (Number.isFinite(Number(params.batch))) latent.inputs.batch_size = Math.max(1, Math.round(Number(params.batch)))
  }

  const positive = next[nodes.positiveId]
  if (positive?.inputs && typeof params.prompt === 'string') positive.inputs.text = params.prompt
  const negative = next[nodes.negativeId]
  if (negative?.inputs && typeof params.negative === 'string') negative.inputs.text = params.negative

  if (Array.isArray(params.lora)) {
    const existingIds = Object.keys(next).filter((id) => isLoraNode(next[id]))
    const wantedIds = params.lora.map((it) => it?.id).filter(Boolean)
    // 集合一致（数量相同、id 都在图上、顺序不变）→ 原地改；否则重建链
    const inPlace = existingIds.length === params.lora.length
      && wantedIds.length === params.lora.length
      && existingIds.every((id, i) => id === wantedIds[i])

    if (inPlace) {
      for (const item of params.lora) {
        const inputs = next[item.id]?.inputs
        if (!inputs) continue
        if (typeof item.name === 'string' && item.name) inputs.lora_name = item.name
        if (Number.isFinite(Number(item.strengthModel))) inputs.strength_model = Number(item.strengthModel)
        if ('strength_clip' in inputs && Number.isFinite(Number(item.strengthClip))) {
          inputs.strength_clip = Number(item.strengthClip)
        }
      }
    } else {
      rebuildLoraChain(next, params.lora, nodes)
    }
  }
  return next
}

/** 合并产出图列表（按 filename + subfolder + type 去重）。 */
function mergeFiles(oldFiles, newFiles) {
  const seen = new Set()
  const out = []
  for (const f of [...(Array.isArray(oldFiles) ? oldFiles : []), ...(Array.isArray(newFiles) ? newFiles : [])]) {
    if (!isPlainObject(f) || typeof f.filename !== 'string') continue
    const key = `${f.type ?? 'output'}|${f.subfolder ?? ''}|${f.filename}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output', nodeId: f.nodeId ?? '' })
  }
  return out
}

/**
 * 创建索引存储。root 可以是字符串，也可以是 async () => string（输出根要问一次
 * ComfyUI /system_stats 才知道，apply() 里用异步 getter）。
 */
export function createWorkspaceStore({ root = '', getRoot = null } = {}) {
  const rootValue = typeof root === 'string' ? root.trim() : ''
  const resolveRoot = async () => {
    if (typeof getRoot === 'function') {
      try {
        const r = await getRoot()
        return typeof r === 'string' ? r.trim() : ''
      } catch {
        return ''
      }
    }
    return rootValue
  }
  const indexPath = async () => {
    const r = await resolveRoot()
    return r ? join(r, META_DIR, INDEX_NAME) : ''
  }

  async function readAll() {
    const file = await indexPath()
    if (!file) return []
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const out = []
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        const entry = JSON.parse(t)
        if (isPlainObject(entry) && typeof entry.promptId === 'string' && entry.promptId) out.push(entry)
      } catch {
        // 半截行 / 旧版本脏数据：跳过，不影响其它记录
      }
    }
    return out
  }

  async function writeAll(entries) {
    const file = await indexPath()
    if (!file) return false
    const dir = join(file, '..')
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${INDEX_NAME}.${process.pid}.${Date.now()}.tmp`)
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    await writeFile(tmp, body, 'utf8')
    try {
      await rename(tmp, file)
    } catch (error) {
      // Windows 上偶发目标占用：先删再移；仍失败就让调用方吞掉，绝不影响出图主流程
      if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
        try { await unlink(file) } catch { /* 忽略 */ }
        await rename(tmp, file)
      } else {
        throw error
      }
    }
    return true
  }

  async function append(entry) {
    if (!isPlainObject(entry) || typeof entry.promptId !== 'string' || !entry.promptId) return false
    const all = await readAll()
    const next = all.filter((e) => e.promptId !== entry.promptId)
    next.push({
      ...entry,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      files: mergeFiles([], entry.files),
    })
    return writeAll(next)
  }

  async function updateFiles(promptId, files) {
    if (typeof promptId !== 'string' || !promptId) return false
    const all = await readAll()
    let hit = null
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i].promptId === promptId) { hit = all[i]; break }
    }
    if (!hit) return false
    hit.files = mergeFiles(hit.files, files)
    hit.updatedAt = new Date().toISOString()
    return writeAll(all)
  }

  async function findByPromptId(promptId) {
    const id = String(promptId ?? '').trim()
    if (!id) return null
    const all = await readAll()
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i].promptId === id) return all[i]
    }
    return null
  }

  async function findByFilename(filename) {
    const name = safeFilename(filename)
    if (!name) return null
    const all = await readAll()
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if ((all[i].files ?? []).some((f) => f?.filename === name)) return all[i]
    }
    return null
  }

  async function recent(limit = 12) {
    const all = await readAll()
    return all.slice(-Math.max(1, Math.min(100, limit))).reverse()
  }

  return {
    indexPath,
    readAll,
    append,
    updateFiles,
    findByPromptId,
    findByFilename,
    recent,
  }
}

/** history 的 prompt 字段有时是对象，有时是 [num, promptObj, extra]。 */
function normalizeHistoryPrompt(prompt) {
  if (isPlainObject(prompt) && Object.values(prompt).some((n) => isPlainObject(n) && 'class_type' in n)) return prompt
  if (Array.isArray(prompt)) {
    for (const item of prompt) {
      if (isPlainObject(item) && Object.values(item).some((n) => isPlainObject(n) && 'class_type' in n)) return item
    }
  }
  return null
}

/**
 * 从 ComfyUI /history 条目合成一条「展示用」生成记录（不落盘）。
 * 用于没有旁侧索引的机器：产出图片页 / 队列 / 工作流选择器都读 generated，
 * 这里把 history 里有图的任务补进来，让三处共用同一份数据。
 * 返回与索引记录同形的对象，或 null（无图）。
 */
export function historyToRecord(promptId, entry) {
  const files = collectImages(entry)
  if (!files.length) return null
  const graph = normalizeHistoryPrompt(entry?.prompt)
  return {
    promptId: String(promptId ?? ''),
    createdAt: '',
    graph,
    params: graph ? extractWorkflowParams(graph) : {},
    files,
    title: '',
    source: 'history',
  }
}

/**
 * 图 → 工作流反查。索引优先（不依赖历史），命中不到再走 ComfyUI 原生 /history。
 * 返回 { ok, source:'index'|'history', promptId, graph, params, files, createdAt, title }
 * 或 { ok:false, reason }。
 */
export async function resolveWorkflow({ store = null, client = null, promptId = '', filename = '', limit = 40 } = {}) {
  const pid = String(promptId ?? '').trim()
  const file = safeFilename(filename)

  if (store) {
    let hit = null
    try {
      hit = pid ? await store.findByPromptId(pid) : (file ? await store.findByFilename(file) : null)
    } catch { /* 索引坏了就走历史 */ }
    if (hit) {
      const graph = isPlainObject(hit.graph) ? hit.graph : null
      return {
        ok: true,
        source: 'index',
        promptId: hit.promptId,
        graph,
        params: isPlainObject(hit.params) ? hit.params : extractWorkflowParams(graph),
        files: Array.isArray(hit.files) ? hit.files : [],
        createdAt: hit.createdAt ?? '',
        title: hit.title ?? '',
      }
    }
  }

  if (!client) {
    return { ok: false, reason: '本机 ComfyUI 连不上，索引里也没这张图的记录。' }
  }

  let entry = null
  let foundId = pid
  if (pid) {
    try { entry = await client.historyEntry(pid) } catch { /* 下面统一给可读提示 */ }
  } else if (file) {
    let history = []
    try { history = await client.history(limit) } catch { /* 下面统一给可读提示 */ }
    for (const row of history) {
      const images = row?.entry ? collectImages(row.entry) : []
      if (images.some((im) => im.filename === file)) {
        foundId = row.promptId
        entry = row.entry
        break
      }
    }
  } else {
    return { ok: false, reason: '既没给 prompt_id 也没给文件名，没法反查。' }
  }

  if (!entry) {
    return {
      ok: false,
      reason: pid
        ? `本机 ComfyUI 的历史里没有 prompt_id ${pid}，索引里也没记录（可能是别的机器生成的，或历史已被清）。`
        : `本机 ComfyUI 的历史里没有图片 ${file}，索引里也没记录。`,
    }
  }

  const graph = normalizeHistoryPrompt(entry.prompt)
  if (!graph) {
    return { ok: false, promptId: foundId, files: collectImages(entry), reason: '历史里这条记录没有可用的工作流（prompt 字段缺失或格式不认识）。' }
  }
  return {
    ok: true,
    source: 'history',
    promptId: foundId,
    graph,
    params: extractWorkflowParams(graph),
    files: collectImages(entry),
    createdAt: '',
    title: '',
  }
}
