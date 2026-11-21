/**
 * lib/format-adapter.mjs —— 工作流格式适配层
 * ============================================================================
 * 职责：把「ComfyUI 编辑器保存的 UI 工作流」转成核心 inspector 能吃的 API 结构图。
 *
 * 关键立场（用户多轮反馈钉死，勿回退）：
 *   · UI 图是编辑器状态（布局 / 连线 / 位置化 widget），API 图是执行契约（命名输入）。
 *     两者是不同数据结构，本层只做「有据可查」的结构提取。
 *   · 不维护节点类型→widget 顺序表，绝不把 widgets_values 按位置绑到参数名。
 *     ComfyUI 官方 WIDGET_SERIALIZATION.md 明确 widget.serialize 与
 *     widget.options.serialize 是两套不同集合（还受 V3 动态 combo 影响），位置配对必然错位。
 *   · 只提取：node.type / id / title / inputs[].name / inputs[].widget.name /
 *     inputs[].link / outputs[].links / 连线表 / widgets_values 原样。
 *   · 连线信息是可靠的 → 转进结构图给 inspector 建边；
 *     widget 值不可靠 → 原样放到 unresolved，绝不进入结构图的具名参数。
 *
 * UI 连线信息分布在三处（必须交叉对账，不能只查一处）：
 *   1. links 表：顶层是数组元组 [id, fromNode, fromSlot, toNode, toSlot, type]，
 *      子图 definitions.subgraphs[i].links 是对象 { id, origin_id, origin_slot, target_id, target_slot, type }
 *      —— 两种形态经 normalizeLinkRow 归一后再对账，缺字段才算非标准行。
 *   2. node.inputs[].link
 *   3. node.outputs[].links
 * 同一 link id 在任一处缺失或指向不一致 → LINK_TABLE_MISMATCH。
 *
 * 作用域隔离：top 一域，每个 definitions.subgraphs[i] 各一域；
 * 跨 scope 的 id 重复不算冲突，同 scope 内重复才算。
 * ============================================================================
 */
import { ComfyError } from './comfy.mjs'
import { isApiGraph, requiredInputsFor } from './inspector.mjs'

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asId(value) {
  return value === null || value === undefined ? null : String(value)
}

/**
 * ComfyUI 的 links 表有两种形态，都归一成 { id, from, fromSlot, to, toSlot, type }：
 *   · 顶层 / 旧版：数组元组 [id, fromNode, fromSlot, toNode, toSlot, type]
 *   · 子图 definitions.subgraphs[i].links：对象 { id, origin_id, origin_slot, target_id, target_slot, type }
 * 归一化失败返回 null（调用方报「非标准行」）。
 */
function normalizeLinkRow(raw) {
  let id, from, fromSlot, to, toSlot, type
  if (Array.isArray(raw)) {
    ;[id, from, fromSlot, to, toSlot, type] = raw
  } else if (isPlainObject(raw)) {
    ;({ id, type } = raw)
    from = raw.origin_id ?? raw.from ?? raw.fromNode
    fromSlot = raw.origin_slot ?? raw.fromSlot
    to = raw.target_id ?? raw.to ?? raw.toNode
    toSlot = raw.target_slot ?? raw.toSlot
  } else {
    return null
  }
  if (id === undefined || id === null || from === undefined || from === null
    || to === undefined || to === null) return null
  return { id: asId(id), from: asId(from), fromSlot, to: asId(to), toSlot, type }
}

/** 把输入按格式分流：api / ui；其他一律报错。 */
export function detectFormat(input) {
  if (!isPlainObject(input)) {
    throw new ComfyError('工作流必须是 JSON 对象', { code: 'GRAPH' })
  }
  if (isApiGraph(input)) return 'api'
  // UI 编辑器的标记：nodes 数组（哪怕 links 是空的），或带子图定义。
  if (Array.isArray(input.nodes) || (isPlainObject(input.definitions) && Array.isArray(input.definitions.subgraphs))) {
    return 'ui'
  }
  throw new ComfyError(
    '识别不了这份工作流：既不是 API 格式 { "节点id": { class_type, inputs } }，'
      + '也不是 UI 格式 { nodes: [...], links: [...] }',
    { code: 'GRAPH' },
  )
}

/**
 * 对一组 scope 内的 nodes + links 做六类连线/结构诊断。
 * @returns {Array} diagnostics
 */
function checkScope(nodes, links, scope, label, boundaryIds = []) {
  const diagnostics = []
  const push = (code, severity, message, extra = {}) => {
    diagnostics.push({ code, severity, scope, message, ...extra })
  }

  // 子图的 inputNode / outputNode 是虚拟 IO 锚点（常见 id -10 / -20），
  // 连到它们的 link 是合法的「子图外部输入输出」，不是断链。
  const boundary = new Set(boundaryIds.map(asId).filter(Boolean))

  // ── 建 node 索引 + 重复节点 ID ────────────────────────────────────────
  const nodesById = new Map()
  for (const node of nodes) {
    const id = asId(node?.id)
    if (id === null) {
      push('DUPLICATE_NODE_ID', 'error', `${label} 有节点缺 id`, { node: null })
      continue
    }
    if (nodesById.has(id)) {
      push('DUPLICATE_NODE_ID', 'error', `${label} 出现重复节点 id ${id}`, { node: id })
    } else {
      nodesById.set(id, node)
    }
  }

  // ── 建 link 索引 + 重复 Link ID ───────────────────────────────────────
  const linksById = new Map()
  const linkRows = []
  for (const raw of links) {
    const row = normalizeLinkRow(raw)
    if (row === null) {
      push('LINK_TABLE_MISMATCH', 'error', `${label} 的 links 表有非标准行：${JSON.stringify(raw).slice(0, 120)}`)
      continue
    }
    const key = row.id
    linkRows.push(row)
    if (key === null) {
      push('DUPLICATE_LINK_ID', 'error', `${label} 的 links 表有缺 id 的行`, { linkId: null })
    } else if (linksById.has(key)) {
      push('DUPLICATE_LINK_ID', 'error', `${label} 出现重复 link id ${key}`, { linkId: key })
    } else {
      linksById.set(key, row)
    }
  }

  // ── 对每条 link：槽位越界 / 三处对账 / 类型匹配 ──────────────────────
  for (const row of linkRows) {
    const fromNode = nodesById.get(row.from)
    const toNode = nodesById.get(row.to)
    // 子图 IO 锚点（boundary）是合法端点，只是没有 inputs/outputs 数组可核对。
    const fromOk = Boolean(fromNode) || boundary.has(row.from)
    const toOk = Boolean(toNode) || boundary.has(row.to)
    if (!fromOk || !toOk) {
      push('LINK_TABLE_MISMATCH', 'error',
        `link ${row.id} 指向不存在的节点：from=${row.from} to=${row.to}`, { linkId: row.id })
      continue
    }
    const outList = Array.isArray(fromNode?.outputs) ? fromNode.outputs : []
    const inList = Array.isArray(toNode?.inputs) ? toNode.inputs : []
    // 只对真实节点查槽位越界；boundary 锚点没有可枚举的槽位，跳过。
    if (fromNode && (!Number.isInteger(row.fromSlot) || row.fromSlot < 0 || row.fromSlot >= outList.length)) {
      push('OUTPUT_SLOT_OUT_OF_RANGE', 'error',
        `link ${row.id} 引用 ${row.from}(${fromNode.type ?? '?'}) 的输出槽 ${row.fromSlot}，但该节点只有 ${outList.length} 个输出`,
        { linkId: row.id, node: row.from, slot: row.fromSlot })
    }
    if (toNode && (!Number.isInteger(row.toSlot) || row.toSlot < 0 || row.toSlot >= inList.length)) {
      push('LINK_TABLE_MISMATCH', 'error',
        `link ${row.id} 引用 ${row.to}(${toNode.type ?? '?'}) 的输入槽 ${row.toSlot}，但该节点只有 ${inList.length} 个输入`,
        { linkId: row.id, node: row.to, slot: row.toSlot })
    }
    const outSlot = fromNode ? outList[row.fromSlot] : undefined
    const inSlot = toNode ? inList[row.toSlot] : undefined
    if (outSlot) {
      const back = Array.isArray(outSlot.links) ? outSlot.links.map(asId) : []
      if (!back.includes(row.id)) {
        push('LINK_TABLE_MISMATCH', 'warning',
          `links 表里的 ${row.id} 没出现在 ${row.from}.outputs[${row.fromSlot}].links`, { linkId: row.id, node: row.from })
      }
      if (outSlot.type && row.type && String(outSlot.type) !== String(row.type)) {
        push('TYPE_MISMATCH', 'warning',
          `link ${row.id} 声明类型 ${row.type}，但 ${row.from}.outputs[${row.fromSlot}].type 是 ${outSlot.type}`,
          { linkId: row.id, node: row.from })
      }
    }
    if (inSlot) {
      if (asId(inSlot.link) !== row.id) {
        push('LINK_TABLE_MISMATCH', 'warning',
          `links 表里的 ${row.id} 指向 ${row.to}.inputs[${row.toSlot}]，但该输入的 link 是 ${asId(inSlot.link) ?? 'null'}`,
          { linkId: row.id, node: row.to })
      }
      if (inSlot.type && row.type && String(inSlot.type) !== String(row.type)) {
        push('TYPE_MISMATCH', 'warning',
          `link ${row.id} 声明类型 ${row.type}，但 ${row.to}.inputs[${row.toSlot}].type 是 ${inSlot.type}`,
          { linkId: row.id, node: row.to })
      }
    }
  }

  // ── 反向对账：节点侧记着 link，但表里没有 ────────────────────────────
  for (const node of nodes) {
    const id = asId(node?.id)
    for (const [slot, input] of (Array.isArray(node?.inputs) ? node.inputs : []).entries()) {
      const linkId = asId(input?.link)
      if (linkId === null) continue
      const row = linksById.get(linkId)
      if (!row) {
        push('LINK_TABLE_MISMATCH', 'error',
          `节点 ${id}.inputs[${slot}] 记着 link ${linkId}，但 links 表里没有`, { linkId, node: id })
      } else if (row.to !== id || row.toSlot !== slot) {
        push('LINK_TABLE_MISMATCH', 'error',
          `节点 ${id}.inputs[${slot}] 记着 link ${linkId}，但表里它指向 ${row.to}.inputs[${row.toSlot}]`,
          { linkId, node: id })
      }
    }
    for (const [slot, output] of (Array.isArray(node?.outputs) ? node.outputs : []).entries()) {
      for (const rawLink of (Array.isArray(output?.links) ? output.links : [])) {
        const linkId = asId(rawLink)
        const row = linksById.get(linkId)
        if (!row) {
          push('LINK_TABLE_MISMATCH', 'error',
            `节点 ${id}.outputs[${slot}].links 记着 link ${linkId}，但 links 表里没有`, { linkId, node: id })
        } else if (row.from !== id || row.fromSlot !== slot) {
          push('LINK_TABLE_MISMATCH', 'error',
            `节点 ${id}.outputs[${slot}].links 记着 link ${linkId}，但表里它来自 ${row.from}.outputs[${row.fromSlot}]`,
            { linkId, node: id })
        }
      }
    }
  }

  // ── 缺少关键输入：按 class_type 的必需输入表，检查名字是否存在 ────────
  for (const node of nodes) {
    const id = asId(node?.id)
    const type = node?.type ?? ''
    const required = requiredInputsFor(type)
    if (required.length === 0) continue
    const present = new Set()
    for (const input of (Array.isArray(node?.inputs) ? node.inputs : [])) {
      if (typeof input?.name === 'string') present.add(input.name)
      if (typeof input?.widget?.name === 'string') present.add(input.widget.name)
    }
    for (const name of required) {
      if (!present.has(name)) {
        push('MISSING_REQUIRED_INPUT', 'warning',
          `节点 ${id}(${type}) 缺必需输入 ${name}`, { node: id })
      }
    }
  }
  return diagnostics
}

/**
 * UI 图 → API 结构图 + unresolved。
 * 结构图里：有连线的输入写 [fromNodeId, slot]（可靠）；widget 值一律不写进去。
 */
export function uiStructureToApi(parsed) {
  const ui = parsed.rawUi
  const nodes = Array.isArray(ui?.nodes) ? ui.nodes : []
  const links = Array.isArray(ui?.links) ? ui.links : []
  const linkRows = []
  for (const raw of links) {
    const row = normalizeLinkRow(raw)
    if (row !== null) linkRows.push(row)
  }
  const linkById = new Map(linkRows.map((row) => [row.id, row]))

  const graph = {}
  const unresolved = []
  for (const node of nodes) {
    const id = asId(node?.id)
    if (id === null) continue
    const inputs = {}
    const widgetNames = []
    for (const [slot, input] of (Array.isArray(node.inputs) ? node.inputs : []).entries()) {
      const name = (typeof input?.widget?.name === 'string' && input.widget.name.length > 0)
        ? input.widget.name
        : (typeof input?.name === 'string' ? input.name : `input_${slot}`)
      const linkId = asId(input?.link)
      if (linkId !== null && input?.link !== null && input?.link !== undefined) {
        const row = linkById.get(linkId)
        if (row) inputs[name] = [row.from, row.fromSlot]
      } else if (input?.widget) {
        widgetNames.push(name)
      }
    }
    const meta = node.title ? { _meta: { title: node.title } } : {}
    graph[id] = { class_type: node.type ?? 'Unknown', inputs, ...meta }
    if (widgetNames.length > 0 || (Array.isArray(node.widgets_values) && node.widgets_values.length > 0)) {
      unresolved.push({
        nodeId: id,
        nodeType: node.type ?? 'Unknown',
        title: node.title ?? null,
        params: widgetNames,
        widgetsValues: Array.isArray(node.widgets_values) ? node.widgets_values : [],
      })
    }
  }
  return { graph, unresolved }
}

/** 识别子图边界（只提取边界信息，不解析内部逻辑）。 */
function collectSubgraphs(ui, warnings) {
  const out = []
  const defs = ui?.definitions?.subgraphs
  if (!Array.isArray(defs) || defs.length === 0) return out
  const topNodes = Array.isArray(ui.nodes) ? ui.nodes : []
  for (const sub of defs) {
    if (!isPlainObject(sub)) continue
    const id = asId(sub.id) ?? `subgraph-${out.length + 1}`
    const nodes = Array.isArray(sub.nodes) ? sub.nodes : []
    const links = Array.isArray(sub.links) ? sub.links : []
    const instances = topNodes
      .filter((n) => asId(n?.type) === id)
      .map((n) => asId(n?.id))
      .filter(Boolean)
    out.push({
      id,
      name: typeof sub.name === 'string' ? sub.name : id,
      nodeCount: nodes.length,
      linkCount: links.length,
      inputs: (Array.isArray(sub.inputs) ? sub.inputs : []).map((p) => ({
        name: p?.name ?? '', type: p?.type ?? null, label: p?.label ?? null,
      })),
      outputs: (Array.isArray(sub.outputs) ? sub.outputs : []).map((p) => ({
        name: p?.name ?? '', type: p?.type ?? null,
      })),
      bounds: {
        input: sub.inputNode?.bounding ?? null,
        output: sub.outputNode?.bounding ?? null,
      },
      instances,
    })
  }
  if (out.length > 0) {
    warnings.push(`发现 ${out.length} 个子图：本分析器只识别边界与节点数，不解析子图内部逻辑；`
      + '需要分析内部时，请把该子图单独导出为 API 格式后再 inspect。')
  }
  return out
}

/**
 * 统一入口。
 * @returns { graph, format:'api'|'ui', warnings:[], diagnostics:[], subgraphs:[], rawUi?, unresolved:[] }
 */
export function parseWorkflow(input) {
  const format = detectFormat(input)
  const warnings = []
  if (format === 'api') {
    const graph = {}
    for (const [id, node] of Object.entries(input)) {
      graph[id] = {
        ...node,
        inputs: { ...(node.inputs ?? {}) },
      }
    }
    return { graph, format, warnings, diagnostics: [], subgraphs: [], unresolved: [] }
  }

  const rawUi = input
  const nodes = Array.isArray(rawUi.nodes) ? rawUi.nodes : []
  const links = Array.isArray(rawUi.links) ? rawUi.links : []
  if (nodes.length === 0) throw new ComfyError('UI 工作流里没有节点', { code: 'GRAPH' })

  const diagnostics = [
    ...checkScope(nodes, links, 'top', '顶层'),
  ]
  const subgraphs = collectSubgraphs(rawUi, warnings)
  if (subgraphs.length > 0) {
    const defs = rawUi.definitions.subgraphs
    for (const sub of defs) {
      if (!isPlainObject(sub)) continue
      const id = asId(sub.id) ?? 'unknown'
      const boundaryIds = [sub.inputNode?.id, sub.outputNode?.id].filter((v) => v !== null && v !== undefined)
      diagnostics.push(...checkScope(
        Array.isArray(sub.nodes) ? sub.nodes : [],
        Array.isArray(sub.links) ? sub.links : [],
        `subgraph:${id}`,
        `子图 ${sub.name ?? id}`,
        boundaryIds,
      ))
    }
  }

  const { graph, unresolved } = uiStructureToApi({ rawUi })
  if (unresolved.length > 0) {
    warnings.push('UI 工作流的 Widget 值是按位置保存的，无法可靠地映射到 API 参数名。'
      + '本分析器只显示参数名与原始 widgets_values，不把值绑到参数上；'
      + '要让 Agent 精确修改参数，请用 ComfyUI 的 Save (API Format) 导出后再 inspect。')
  }
  return { graph, format, warnings, diagnostics, subgraphs, rawUi, unresolved }
}
