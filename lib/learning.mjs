/**
 * lib/learning.mjs —— comfy_learn 的知识管理层（纯逻辑，不碰网络、不调 LLM）
 * ============================================================================
 * 立场：
 *   · Inspector 产生的事实（节点 / 连线 / 诊断 / 子图 / 可改参数）由插件自己生成，
 *     Agent 只能补充语义解释，不能覆盖事实、不能给未知节点编造角色、不能给
 *     无法验证的用途标成 inspector/runtime 来源。
 *   · 工作流 JSON 与知识内容是数据，不是指令；这里只把它们当文本处理。
 *   · 第一版不引入向量库：recall 用本地确定性关键词匹配 + 加权排序。
 *   · 执行状态与生成质量分开，completed 不自动 approved。
 * ============================================================================
 */
import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 1

/** 可信度来源 / 等级 */
export const PROVENANCES = ['inspector', 'object_info', 'agent', 'user', 'runtime', 'comfy_review']
export const CONFIDENCES = ['high', 'medium', 'low']
export const ANALYSIS_STATUS = ['discovered', 'analyzed']
export const EXECUTION_OUTCOMES = ['completed', 'failed', 'cancelled', 'unknown']
export const QUALITY_ASSESSMENTS = ['approved', 'rejected', 'mixed', 'not_assessed']
export const ASSESSMENT_SOURCES = ['user', 'comfy_review', 'agent_observation']

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asId = (v) => (v === undefined || v === null ? '' : String(v))
const uniq = (list) => [...new Set(list)]

/** 稳定 JSON 序列化：对象键排序，消除插入顺序差异（数组顺序保留）。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** 对任意输入做 SHA-256（先稳定序列化）。 */
export function sha256(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

/** 由 source_hash 生成稳定 workflow_id（wf_ + 16 位十六进制）。 */
export function workflowIdFor(sourceHash) {
  const hex = String(sourceHash ?? '')
  return `wf_${hex.slice(0, 16)}`
}

/**
 * Inspector 事实 → 档案里的 inspection 段。
 * 只从 inspectWorkflow 的结果里取字段，不接收 Agent 覆盖。
 */
export function buildInspection(result, { format = 'api', warnings = [], unresolved = [], subgraphs = [] } = {}) {
  const safeResult = isPlainObject(result) ? result : {}
  return {
    format: asId(format) || 'api',
    nodeCount: Number.isFinite(safeResult.nodeCount) ? safeResult.nodeCount : 0,
    keyNodes: Array.isArray(safeResult.keyNodes) ? safeResult.keyNodes : [],
    edges: Array.isArray(safeResult.edges) ? safeResult.edges : [],
    editable_parameters: Array.isArray(safeResult.editable) ? safeResult.editable : [],
    diagnostics: Array.isArray(safeResult.diagnostics) ? safeResult.diagnostics : [],
    warnings: Array.isArray(warnings) ? warnings : [],
    subgraphs: Array.isArray(subgraphs) ? subgraphs : (Array.isArray(safeResult.subgraphs) ? safeResult.subgraphs : []),
    unresolved: Array.isArray(unresolved) ? unresolved : [],
  }
}

/**
 * 校验并净化 Agent 提交的 knowledge。
 *   · 只保留约定的字段；每条 role/guidance 强制带 confidence，未知值归 'low'。
 *   · 不保存完整正/负提示词：如果 Agent 误把 prompt 塞进字段，这里丢掉过长文本。
 *   · 缺失字段留空数组，不强制填满。
 * @returns {{knowledge:object, warnings:string[]}}
 */
export function sanitizeKnowledge(input) {
  const raw = isPlainObject(input) ? input : {}
  const warnings = []
  if (!isPlainObject(input)) warnings.push('knowledge 不是对象，已按空知识处理')
  const strList = (value, field) => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) {
      warnings.push(`knowledge.${field} 不是数组，已忽略`)
      return []
    }
    return value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 200)
  }
  const objectList = (value, field, keys) => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) {
      warnings.push(`knowledge.${field} 不是数组，已忽略`)
      return []
    }
    const out = []
    for (const item of value) {
      if (!isPlainObject(item)) continue
      const entry = {}
      for (const key of keys) {
        if (typeof item[key] === 'string' && item[key].trim().length > 0) entry[key] = item[key].trim().slice(0, 1000)
      }
      entry.confidence = CONFIDENCES.includes(item.confidence) ? item.confidence : 'low'
      if (Object.keys(entry).length > 1) out.push(entry)
    }
    return out.slice(0, 200)
  }
  const knowledge = {
    purpose: strList(raw.purpose, 'purpose'),
    workflow_steps: strList(raw.workflow_steps, 'workflow_steps'),
    node_roles: objectList(raw.node_roles, 'node_roles', ['node', 'role']),
    use_cases: strList(raw.use_cases, 'use_cases'),
    parameter_guidance: objectList(raw.parameter_guidance, 'parameter_guidance', ['parameter', 'guidance']),
    dependencies: strList(raw.dependencies, 'dependencies'),
    limitations: strList(raw.limitations, 'limitations'),
    troubleshooting: strList(raw.troubleshooting, 'troubleshooting'),
  }
  // Agent 常常把完整提示词误塞进 purpose/guidance，这里按长度兜底截断
  for (const field of ['purpose', 'workflow_steps', 'use_cases', 'dependencies', 'limitations', 'troubleshooting']) {
    knowledge[field] = knowledge[field].map((s) => (s.length > 400 ? s.slice(0, 400) + '…' : s))
  }
  return { knowledge, warnings }
}

/**
 * 验证 node_roles 里引用的节点是否真的存在于 inspector 的事实里。
 * 不存在的节点：保留条目但降为 low 并加注，避免 Agent 编造节点。
 */
export function crossCheckNodeRoles(knowledge, inspection) {
  const known = new Set((inspection?.keyNodes ?? []).map((n) => asId(n?.id ?? n?.node)))
  const allNodeIds = new Set()
  for (const edge of inspection?.edges ?? []) {
    allNodeIds.add(asId(edge?.from))
    allNodeIds.add(asId(edge?.to))
  }
  for (const entry of inspection?.editable_parameters ?? []) allNodeIds.add(asId(entry?.nodeId))
  for (const id of known) allNodeIds.add(id)
  const roles = (knowledge?.node_roles ?? []).map((role) => {
    const node = asId(role.node)
    // 允许写 class_type（如 "VAEEncode"）或节点 id；两者都不在事实里就标未验证
    const verified = allNodeIds.has(node)
      || (inspection?.keyNodes ?? []).some((n) => asId(n?.classType ?? n?.class_type) === node)
    if (!verified) return { ...role, confidence: 'low', note: '未在 Inspector 事实中找到该节点，标为未验证' }
    return role
  })
  return { ...knowledge, node_roles: roles }
}

/** 算档案的两个指纹与 id。 */
export function fingerprintsFor(sourceInput, parsed) {
  const sourceHash = sha256(sourceInput)
  const structureHash = sha256({
    format: parsed?.format ?? 'api',
    graph: parsed?.graph ?? {},
    diagnostics: parsed?.diagnostics ?? [],
    subgraphs: parsed?.subgraphs ?? [],
  })
  return { source_hash: sourceHash, structure_hash: structureHash, workflow_id: workflowIdFor(sourceHash) }
}

/**
 * 默认隐私脱敏：从档案文本里去掉完整提示词 / 图片路径 / token 等。
 * 这里对「要写进档案的字符串数组」做保守过滤；Graph 快照另按 store_graph 决定。
 */
function redactString(text) {
  let s = String(text ?? '')
  // 只脱敏「绝对/个人文件路径」：盘符开头、UNC、POSIX 根、含 Users/home 段的路径。
  // 模型引用如 diffusion_models/qwen_2.1.safetensors 是必要的非敏感配置，必须保留。
  s = s.replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\/]+\\[^\\/]+|(?:\/|\\)(?:Users|home|Documents|Desktop|tmp|Temp)[\\/])[^\s,，、;'"]+\.(?:png|jpe?g|webp|gif|safetensors|ckpt|sft|gguf)/gi, '[路径已脱敏]')
  // 明显的 token / key 赋值
  s = s.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[已脱敏]')
  if (s.length > 700) return s.slice(0, 700) + '…'
  return s
}
function redactList(list) {
  return (Array.isArray(list) ? list : []).map(redactString)
}

/**
 * 建一份完整档案（不落盘，供 index.js 调 store.upsert）。
 * @param {object} opts
 *   sourceInput  原始输入（用于 source_hash，通常是原始 graph 或 {prompt_id}）
 *   parsed       parseWorkflow 结果 { graph, format, warnings, diagnostics, subgraphs, unresolved }
 *   inspection   inspectWorkflow 结果
 *   source       { type:'prompt-index'|'history'|'graph'|'path', prompt_id, created_at }
 *   knowledge    Agent 提交的语义知识
 *   name/description/tags
 *   storeGraph   是否保存原始 Graph 快照
 *   existing     已存在的同 source_hash 档案（更新时保留 experiences / 修订记录）
 */
export function buildRecord(opts) {
  const {
    sourceInput, parsed, inspection, source, knowledge,
    name = '', description = '', tags = [], storeGraph = false, existing = null,
  } = opts
  const fp = fingerprintsFor(sourceInput, parsed)
  const clean = sanitizeKnowledge(knowledge)
  const checked = crossCheckNodeRoles(clean.knowledge, inspection)
  const insp = buildInspection(inspection, {
    format: parsed?.format,
    warnings: parsed?.warnings,
    unresolved: parsed?.unresolved,
    subgraphs: parsed?.subgraphs,
  })
  const now = new Date().toISOString()
  const prev = isPlainObject(existing) ? existing : null
  const revision = (Number(prev?.metadata?.revision) || 0) + 1

  // 原始 Graph 快照：只有 store_graph=true 才保存；prompt-index 来源优先保留引用，不重复复制。
  const srcType = asId(source?.type)
  const promptId = asId(source?.prompt_id)
  const graphStorage = srcType === 'prompt-index' && promptId
    ? { mode: 'prompt-index-reference', available: true, prompt_id: promptId, snapshot: null }
    : storeGraph
      ? { mode: 'snapshot', available: true, graph: parsed?.graph ?? null }
      : { mode: 'reference-only', available: srcType === 'history' && promptId, prompt_id: promptId, snapshot: null }
  // history 来源且没保存快照、又不是 prompt-index 持久引用 → graph_available=false
  if (graphStorage.mode === 'reference-only' && !(srcType === 'history' && promptId)) graphStorage.available = false

  const record = {
    schema_version: SCHEMA_VERSION,
    workflow_id: fp.workflow_id,
    name: redactString(name).slice(0, 200),
    description: redactString(description).slice(0, 1000),
    tags: uniq((Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string').map((t) => redactString(t).slice(0, 40))),
    fingerprints: { source_hash: fp.source_hash, structure_hash: fp.structure_hash },
    source: {
      type: srcType || 'graph',
      prompt_id: promptId,
      created_at: asId(source?.created_at) || (prev?.source?.created_at ?? now),
    },
    graph_storage: graphStorage,
    inspection: insp,
    knowledge: {
      ...checked,
      purpose: redactList(checked.purpose),
      workflow_steps: redactList(checked.workflow_steps),
      use_cases: redactList(checked.use_cases),
      dependencies: redactList(checked.dependencies),
      limitations: redactList(checked.limitations),
      troubleshooting: redactList(checked.troubleshooting),
    },
    experiences: Array.isArray(prev?.experiences) ? prev.experiences : [],
    learning_status: {
      analysis_status: 'analyzed',
      execution_status: prev?.learning_status?.execution_status ?? 'never_executed',
      quality_status: prev?.learning_status?.quality_status ?? 'unreviewed',
    },
    stats: {
      execution_completed: Number(prev?.stats?.execution_completed) || 0,
      execution_failed: Number(prev?.stats?.execution_failed) || 0,
      approved: Number(prev?.stats?.approved) || 0,
      rejected: Number(prev?.stats?.rejected) || 0,
    },
    metadata: {
      revision,
      created_at: prev?.metadata?.created_at ?? now,
      updated_at: now,
    },
  }
  if (clean.warnings.length > 0) record.knowledge.warnings = clean.warnings
  return { record, warnings: clean.warnings }
}

/** 把档案拆成可搜索的文本字段（recall 用）。 */
function searchableFields(record) {
  const k = isPlainObject(record?.knowledge) ? record.knowledge : {}
  const insp = isPlainObject(record?.inspection) ? record.inspection : {}
  return {
    name: typeof record?.name === 'string' ? record.name : '',
    description: typeof record?.description === 'string' ? record.description : '',
    tags: Array.isArray(record?.tags) ? record.tags.join(' ') : '',
    purpose: Array.isArray(k.purpose) ? k.purpose.join(' ') : '',
    node_types: (insp.keyNodes ?? []).map((n) => `${n?.classType ?? n?.class_type ?? ''} ${n?.id ?? ''}`).join(' '),
    workflow_steps: Array.isArray(k.workflow_steps) ? k.workflow_steps.join(' ') : '',
    parameter_guidance: Array.isArray(k.parameter_guidance) ? k.parameter_guidance.map((g) => `${g?.parameter ?? ''} ${g?.guidance ?? ''}`).join(' ') : '',
    use_cases: Array.isArray(k.use_cases) ? k.use_cases.join(' ') : '',
    experiences: (record?.experiences ?? []).map((e) => `${e?.feedback ?? ''} ${e?.parameter_changes ? JSON.stringify(e.parameter_changes) : ''}`).join(' '),
    dependencies: Array.isArray(k.dependencies) ? k.dependencies.join(' ') : '',
  }
}

/** 简单分词：中文按字/连续片段，英文按词，小写。 */
function tokenize(text) {
  const raw = String(text ?? '').toLowerCase()
  const latin = raw.match(/[a-z0-9_]+/g) ?? []
  const cjk = raw.match(/[\u3400-\u9fff]{1,6}/g) ?? []
  // 中文 2-6 字滑窗，兼顾「图像放大」与「放大」
  const cjkTokens = []
  for (const run of cjk) {
    for (let n = 2; n <= run.length; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) cjkTokens.push(run.slice(i, i + n))
    }
  }
  return [...new Set([...latin, ...cjkTokens])]
}

const FIELD_WEIGHTS = {
  name: 3,
  tags: 3,
  purpose: 4,
  use_cases: 3,
  node_types: 2,
  workflow_steps: 2,
  parameter_guidance: 1.5,
  dependencies: 1,
  experiences: 1,
  description: 0.5,
}

/**
 * 本地确定性检索。按字段命中加权 + 完整性/运行记录/确认来源加分排序。
 * 返回每条带 matched_reasons（让 Agent 能解释为什么选中）。
 */
export function rankForRecall(records, query, limit = 5) {
  const tokens = tokenize(query)
  const out = []
  for (const record of records) {
    const fields = searchableFields(record)
    let score = 0
    let matched = false
    const reasons = []
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      const hay = String(fields[field] ?? '').toLowerCase()
      if (!hay) continue
      const hits = tokens.filter((t) => t.length >= 2 && hay.includes(t))
      if (hits.length > 0) {
        matched = true
        const s = weight * hits.length
        score += s
        reasons.push(`${field} 命中 ${hits.slice(0, 4).join('、')}`)
      }
    }
    // 有 query 但一个词都没命中 → 不进候选（完整性/确认只作加分，不能凭空造匹配）
    if (tokens.length > 0 && !matched) continue
    if (tokens.length === 0) score = 0
    const k = record?.knowledge ?? {}
    const completeness = ['purpose', 'workflow_steps', 'use_cases', 'parameter_guidance', 'dependencies']
      .filter((f) => Array.isArray(k[f]) && k[f].length > 0).length
    score += completeness * 0.5
    if (completeness >= 4) reasons.push('知识档案较完整')
    const exp = Array.isArray(record?.experiences) ? record.experiences : []
    if (exp.length > 0) score += Math.min(3, exp.length * 0.5)
    const confirmed = exp.some((e) => e?.quality_assessment === 'approved'
      && (e?.assessment_source === 'user' || e?.assessment_source === 'comfy_review'))
    if (confirmed) {
      score += 2
      reasons.push('有用户/审图确认记录')
    }
    out.push({
      record,
      score,
      matched_reasons: reasons.slice(0, 6),
      graph_available: record?.graph_storage?.available === true,
    })
  }
  out.sort((a, b) => b.score - a.score
    || String(b.record?.metadata?.updated_at ?? '').localeCompare(String(a.record?.metadata?.updated_at ?? '')))
  const cap = Math.max(1, Math.min(50, Number(limit) || 5))
  return out.slice(0, cap)
}

/** recall 返回给 Agent 的精简条目。 */
export function recallSummary(entry) {
  const r = entry.record
  const st = isPlainObject(r?.learning_status) ? r.learning_status : {}
  const stats = isPlainObject(r?.stats) ? r.stats : {}
  return {
    workflow_id: r?.workflow_id,
    name: r?.name ?? '',
    description: r?.description ?? '',
    purpose: r?.knowledge?.purpose ?? [],
    tags: r?.tags ?? [],
    matched_reasons: entry.matched_reasons,
    learning_status: {
      analysis_status: st.analysis_status ?? 'discovered',
      execution_status: st.execution_status ?? 'never_executed',
      quality_status: st.quality_status ?? 'unreviewed',
    },
    execution_stats: {
      completed: stats.execution_completed ?? 0,
      failed: stats.execution_failed ?? 0,
      approved: stats.approved ?? 0,
      rejected: stats.rejected ?? 0,
    },
    graph_available: entry.graph_available,
    source: r?.source ?? {},
    dependencies: r?.knowledge?.dependencies ?? [],
    score: Math.round(entry.score * 100) / 100,
    note: '推荐命中不代表可直接执行；执行前仍需重新 inspect 并检查本机节点/模型依赖。',
  }
}

/** list 的过滤与摘要（摘要字段由 store 的 index entries 提供）。 */
export function filterList(entries, { keyword = '', tag = '', status = '', limit = 20 } = {}) {
  const kw = String(keyword ?? '').trim().toLowerCase()
  const tg = String(tag ?? '').trim().toLowerCase()
  const st = String(status ?? '').trim()
  let out = (Array.isArray(entries) ? entries : []).filter((e) => {
    if (tg && !(e?.tags ?? []).some((t) => String(t).toLowerCase() === tg)) return false
    if (st && [e?.analysis_status, e?.execution_status, e?.quality_status].includes(st) === false) return false
    if (kw) {
      const hay = `${e?.name ?? ''} ${e?.description ?? ''} ${(e?.tags ?? []).join(' ')}`.toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })
  out = out.slice().sort((a, b) => String(b?.updated_at ?? '').localeCompare(String(a?.updated_at ?? '')))
  return out.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
}

/**
 * 构造一条 feedback 事件（不落盘，供 store.appendExperience）。
 * 执行状态与质量评价分开；completed 不自动 approved。
 */
export function buildExperience({ workflow_id, prompt_id = '', execution_outcome = 'unknown',
  quality_assessment = 'not_assessed', assessment_source = 'agent_observation',
  feedback = '', parameter_changes = {} } = {}) {
  const outcome = EXECUTION_OUTCOMES.includes(execution_outcome) ? execution_outcome : 'unknown'
  const quality = QUALITY_ASSESSMENTS.includes(quality_assessment) ? quality_assessment : 'not_assessed'
  const source = ASSESSMENT_SOURCES.includes(assessment_source) ? assessment_source : 'agent_observation'
  return {
    workflow_id: asId(workflow_id),
    prompt_id: asId(prompt_id),
    execution_outcome: outcome,
    quality_assessment: quality,
    assessment_source: source,
    feedback: redactString(feedback).slice(0, 2000),
    parameter_changes: isPlainObject(parameter_changes) ? parameter_changes : {},
    at: new Date().toISOString(),
  }
}

/** 依据一条反馈事件更新档案的 learning_status 与 stats（不写 experiences，由 store 负责）。 */
export function applyExperienceToStatus(record, event) {
  const next = isPlainObject(record) ? { ...record } : {}
  const status = { ...(isPlainObject(record?.learning_status) ? record.learning_status : {}) }
  const stats = { ...(isPlainObject(record?.stats) ? record.stats : {}) }
  status.analysis_status = status.analysis_status ?? 'discovered'
  status.execution_status = status.execution_status ?? 'never_executed'
  status.quality_status = status.quality_status ?? 'unreviewed'
  if (event.execution_outcome === 'completed') {
    status.execution_status = 'executed'
    stats.execution_completed = (Number(stats.execution_completed) || 0) + 1
  } else if (event.execution_outcome === 'failed') {
    status.execution_status = 'execution_failed'
    stats.execution_failed = (Number(stats.execution_failed) || 0) + 1
  } else if (event.execution_outcome === 'cancelled') {
    // cancelled 只记事件，不改 executed/failed 状态
  }
  if (event.quality_assessment === 'approved') {
    status.quality_status = 'approved'
    stats.approved = (Number(stats.approved) || 0) + 1
  } else if (event.quality_assessment === 'rejected') {
    status.quality_status = 'rejected'
    stats.rejected = (Number(stats.rejected) || 0) + 1
  } else if (event.quality_assessment === 'mixed') {
    status.quality_status = 'mixed'
  }
  next.learning_status = status
  next.stats = stats
  next.metadata = {
    ...(isPlainObject(record?.metadata) ? record.metadata : {}),
    updated_at: new Date().toISOString(),
  }
  return next
}
