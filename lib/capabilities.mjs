/**
 * lib/capabilities.mjs —— 本机 ComfyUI「能力发现」层
 * ============================================================================
 * 为什么有这个文件：
 *   模型-agent 遇到陌生的图任务（去遮挡 / 抠图 / 换背景 / 局部改）时，最容易
 *   凭世界知识滑向通用 Python 方案（PIL / rembg / GrabCut）。本机 ComfyUI 其实
 *   早就有原生模型和节点（如 qwen_image_2.1 + TextEncodeQwenImage21 直接做参考图
 *   编辑），但没有一个工具能「按用途反查」。这个模块把「任务词 → 候选能力」做成
 *   可查、可缓存、真值来自本机 object_info 的纯函数。
 *
 * 立场（与 comfy_models 那条「不再点名某个模型」的测试一致）：
 *   · 不写死「某模型最懂某任务」。标签只来自**文件名模式 + 本机 object_info 节点**。
 *   · 真值是本机的 object_info 与模型文件名；词典只负责把中英任务词映射到
 *     节点类名模式 / 文件名模式，命中后列出的都是本机真实存在的东西。
 *   · 一个任务有多个候选就全列，标「多个候选」，不替用户/agent 选。
 *   · 全量 object_info 有 2.3MB，必须裁剪字段 + 进程内缓存，禁止反复全量拉。
 * ============================================================================
 */

/**
 * 能力条目：
 *   id        稳定标识
 *   label     一句中文用途
 *   taskWords 中英任务词 / 关键词（命中任意一个即算强相关）
 *   nodePat   节点类名正则（匹配本机 object_info 里的类名）
 *   pinNodes  标志性节点类名：命中后优先排到候选最前，避免被宽泛匹配挤掉
 *   modelPat  模型文件名正则（匹配 modelIndex 里的文件名）
 *   hint      给 agent 的关键提示（怎么搭工作流）
 *
 * 注意：这些是「候选模式」，命中后列出的节点/模型必须是本机真实存在的。
 */
export const CAPABILITIES = [
  {
    id: 'reference_edit',
    label: '参考图指令编辑（去遮挡 / 去物体 / 按指令改图）',
    taskWords: [
      '去遮挡', '去掉遮挡', '遮挡', '去物体', '去掉', '移除', '抠', '抠图', '换背景', '改图', '编辑', '局部改', '局部重绘',
      'reference', 'edit', 'instruction', 'remove object', 'remove', 'erase', 'inpaint', 'outpaint', 'matting',
    ],
    nodePat: /(TextEncodeQwenImage21|QwenImage.*Edit|ReferenceLatent|ImageEdit|Inpaint|TextEncodeQwenImageEdit)/i,
    pinNodes: [/^TextEncodeQwenImage(21|Edit)/i, /^TextEncodeQwenImageEditPlus$/i],
    modelPat: /(qwen.*image.*2|qwen.*edit|.*edit.*)/i,
    hint: '参考图送进编辑节点的 images 入参，配该模型的 CLIP/VAE，graph 模式直出；不必先算蒙版或走 Python 抠图。',
  },
  {
    id: 'matting',
    label: '主体分割 / 抠图（去背景、换透明底）',
    taskWords: ['抠图', '抠人', '去背景', '换背景', '透明底', '主体分割', 'matting', 'rembg', 'background removal', 'segment'],
    nodePat: /(RMBG|InspyreNet|BackgroundRemoval|RemoveBG|BiRefNet|SegmentAnything|SAM)/i,
    modelPat: /(rmbg|background_removal|u2net|isnet|birefnet|inspyrenet)/i,
    hint: '本机若有 RMBG 类节点/模型，直接用它出带 alpha 的图；不要自己 pip 装 rembg 或写 GrabCut。',
  },
  {
    id: 'txt2img',
    label: '文生图（按提示词从零生成）',
    taskWords: ['生图', '文生图', '画一张', '生成图片', 't2i', 'text to image', 'generate'],
    nodePat: /(EmptyLatentImage|EmptySD3LatentImage|CLIPTextEncode)/i,
    modelPat: /(anima|flux|sdxl|sd_?xl|krea|illustrious|checkpoint)/i,
    hint: '用 comfy_run 的 template 模式；搭复杂图先 comfy_node 查节点再走 graph 模式。',
  },
  {
    id: 'upscale',
    label: '放大 / 超分',
    taskWords: ['放大', '超分', '高清', '提高分辨率', 'upscale', 'super resolution', '4x'],
    nodePat: /(Upscale|ESRGAN|ImageScaleBy)/i,
    modelPat: /(upscale|esrgan|remacri|4x_)/i,
    hint: '用 comfy_upscale（算法放大，设置页开开关），或 graph 里挂超分模型。',
  },
  {
    id: 'controlnet',
    label: '姿态 / 线稿 / 深度控制',
    taskWords: ['控制', '姿态', '线稿', '深度', 'controlnet', 'pose', 'depth', 'canny', 'openpose'],
    nodePat: /(ControlNet|LLLite|T2IAdapter)/i,
    modelPat: /(controlnet|lllite|openpose|depth|canny)/i,
    hint: '在 graph 里接 ControlNet 节点，先 comfy_node 查它的输入口。',
  },
]

/** object_info 里一个节点我们只保留这些字段 —— 砍掉 huge enum，避免 2.3MB 全量回传 */
function slimNode(name, raw) {
  if (!raw || typeof raw !== 'object') return null
  const input = raw.input ?? {}
  const keys = (group) => {
    const obj = input?.[group]
    return obj && typeof obj === 'object' ? Object.keys(obj).filter((k) => !k.startsWith('_')) : []
  }
  return {
    name: String(raw.name ?? name),
    display_name: raw.display_name ? String(raw.display_name) : '',
    category: raw.category ? String(raw.category) : '',
    description: raw.description ? String(raw.description).slice(0, 300) : '',
    requiredInputs: keys('required'),
    optionalInputs: keys('optional'),
  }
}

/**
 * 把 /object_info 全量响应裁成轻量节点表。
 * 导出纯函数，便于单测；入参是完整的 object_info 对象。
 */
export function slimObjectInfo(objectInfo) {
  const out = []
  if (!objectInfo || typeof objectInfo !== 'object') return out
  for (const [name, raw] of Object.entries(objectInfo)) {
    const node = slimNode(name, raw)
    if (node) out.push(node)
  }
  return out
}

/**
 * 单一入口：给定「任务词 + 轻量节点表 + 模型文件名索引」，算出候选能力分组。
 * 返回数组，每项 { id, label, hint, nodes: [...], models: [...], match: 'task'|'fallback' }。
 */
export function findCapabilities(task, nodes, modelIndex) {
  const query = String(task ?? '').toLowerCase().trim()
  const files = []
  if (modelIndex && typeof modelIndex === 'object') {
    for (const list of Object.values(modelIndex)) {
      if (Array.isArray(list)) for (const f of list) files.push(String(f))
    }
  }

  // 先按「任务词」筛出本轮真正关心的能力。任务词一个都没命中就返回空 ——
  // 不能因为本机装了某节点就把它当答案硬塞给用户（那是新的误判）。
  const hitCaps = CAPABILITIES.filter((cap) =>
    cap.taskWords.some((word) => query.includes(String(word).toLowerCase())),
  )
  if (hitCaps.length === 0) return []

  const results = []
  for (const cap of hitCaps) {
    const matchedNodes = nodes.filter((node) => cap.nodePat.test(node.name) || cap.nodePat.test(node.display_name))
    // 标志性节点优先：pinNodes 命中的排最前，避免被 Inpaint 这类宽泛匹配挤出前 8
    const pins = Array.isArray(cap.pinNodes) ? cap.pinNodes : []
    matchedNodes.sort((a, b) => {
      const pa = pins.some((re) => re.test(a.name)) ? 0 : 1
      const pb = pins.some((re) => re.test(b.name)) ? 0 : 1
      return pa - pb
    })
    const matchedModels = files.filter((file) => cap.modelPat.test(file))
    results.push({
      id: cap.id,
      label: cap.label,
      hint: cap.hint,
      nodes: matchedNodes.slice(0, 8),
      models: matchedModels.slice(0, 8),
      // 本机没找到对应节点/模型但任务词命中：标记为 fallback（内置词典经验候选）
      match: matchedNodes.length === 0 && matchedModels.length === 0 ? 'fallback' : 'task',
    })
  }

  results.sort((a, b) => {
    if (a.match !== b.match) return a.match === 'task' ? -1 : 1
    return (b.nodes.length + b.models.length) - (a.nodes.length + a.models.length)
  })
  return results
}

/**
 * 给单个模型文件名打能力标签（comfy_models 用）。
 * 只按文件名模式，不查 object_info，纯函数。
 */
export function labelModel(file) {
  const name = String(file ?? '')
  const labels = []
  for (const cap of CAPABILITIES) {
    if (cap.modelPat.test(name)) labels.push(cap.label.split('（')[0])
  }
  // 去重，保持顺序
  return [...new Set(labels)]
}

/**
 * 按关键词搜节点类名（comfy_node 用）。
 * 完整类名（大小写不敏感精确命中）返回 exact；否则按子串/正则返回候选。
 */
export function searchNodes(keyword, nodes) {
  const q = String(keyword ?? '').trim()
  if (!q) return { exact: null, candidates: [] }
  const lower = q.toLowerCase()
  const exact = nodes.find((node) => node.name.toLowerCase() === lower || node.display_name.toLowerCase() === lower) ?? null
  if (exact) return { exact, candidates: [] }
  const candidates = nodes.filter((node) =>
    node.name.toLowerCase().includes(lower) ||
    node.display_name.toLowerCase().includes(lower) ||
    node.category.toLowerCase().includes(lower),
  )
  return { exact: null, candidates: candidates.slice(0, 20) }
}
