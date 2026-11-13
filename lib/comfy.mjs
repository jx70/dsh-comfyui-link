/**
 * lib/comfy.mjs —— 本地 ComfyUI 的 HTTP 客户端 + 内置 txt2img 工作流模板
 * ============================================================================
 * 这个文件**不 import 任何 @deepseek-ai/* **：它只依赖 Node 自带的 fetch，
 * 所以可以脱离 DSH 单独跑（`node selftest.mjs` 就是这么测的）。
 *
 * 用到的 ComfyUI 接口（都对着本机 0.30.2 实测过）：
 *   GET  /system_stats              服务 + GPU 信息
 *   GET  /models/{folder}           某个模型文件夹里的文件名
 *   GET  /object_info/{node_class}  单节点输入/输出规范
 *   GET  /object_info               全部节点（2.3MB，慢，慎调）
 *   POST /prompt                    {prompt: {节点id: {class_type, inputs}}} → {prompt_id, number, node_errors}
 *   GET  /history/{prompt_id}       有就返回 {prompt_id: {...}}，没有返回 {}
 *   GET  /api/jobs/{job_id}         任务状态（job id 就是 prompt id）
 *   GET  /api/jobs?limit=N          最近任务列表
 *   GET  /queue                     {queue_running, queue_pending}
 *   GET  /view?filename&subfolder&type  图片字节
 *   POST /interrupt | /free | /queue | /api/jobs/{id}/cancel
 * ============================================================================
 */

/** 我们关心的模型文件夹（别的文件夹不列，免得输出太长） */
export const MODEL_FOLDERS = ['diffusion_models', 'text_encoders', 'vae', 'checkpoints', 'loras']

/** ComfyUI 那边失败时抛这个，带上可路由的 code */
export class ComfyError extends Error {
  constructor(message, { code = 'COMFY', status, detail } = {}) {
    super(message)
    this.name = 'ComfyError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

/** 把调用方的取消信号和本次请求的超时合成一个 signal */
function mergeSignal(signal, timeoutMs) {
  const parts = []
  if (signal) parts.push(signal)
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) parts.push(AbortSignal.timeout(timeoutMs))
  if (parts.length === 0) return undefined
  return parts.length === 1 ? parts[0] : AbortSignal.any(parts)
}

/** 把 fetch 的底层错误翻译成人话（最常见的就是「服务没开」） */
function networkError(error, url) {
  const code = error?.cause?.code ?? error?.code
  if (error?.name === 'TimeoutError') {
    return new ComfyError(`请求 ComfyUI 超时（${url}）—— 它可能正在出图，或者进程卡住了`, { code: 'TIMEOUT' })
  }
  if (error?.name === 'AbortError') return new ComfyError('已取消', { code: 'CANCELLED' })
  if (code === 'ECONNREFUSED') {
    return new ComfyError(`连不上 ComfyUI（${url}）：ECONNREFUSED —— 服务大概没在跑`, { code: 'OFFLINE' })
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new ComfyError(`连不上 ComfyUI（${url}）：主机名解析失败`, { code: 'OFFLINE' })
  }
  if (code === 'ECONNRESET') return new ComfyError(`ComfyUI 断开了连接（${url}）`, { code: 'RESET' })
  return new ComfyError(`请求 ComfyUI 失败（${url}）：${error?.message ?? String(error)}`, { code: 'NETWORK' })
}

/** 毫秒转「几分几秒」这种给人看的形式 */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

/** 可取消的 sleep */
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ComfyError('已取消', { code: 'CANCELLED' }))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 造一个客户端。所有方法都吃 `{ signal }`，方便工具把取消一路传下去。
 * @param {{baseUrl?: string, timeoutMs?: number}} options
 */
export function createClient({ baseUrl = 'http://127.0.0.1:8188', timeoutMs = 15000 } = {}) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const abs = (path) => new URL(String(path).replace(/^\//, ''), root).href

  async function request(path, { method = 'GET', body, signal, timeoutMs: perCall } = {}) {
    const url = abs(path)
    const init = { method, signal: mergeSignal(signal, perCall ?? timeoutMs) }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    let res
    try {
      res = await fetch(url, init)
    } catch (error) {
      throw networkError(error, url)
    }
    const text = await res.text()
    let data
    try {
      data = text.length === 0 ? null : JSON.parse(text)
    } catch {
      data = text
    }
    if (!res.ok) {
      const detail = typeof data === 'object' && data !== null ? data : { body: String(data).slice(0, 500) }
      throw new ComfyError(`ComfyUI 返回 ${res.status}（${method} ${path}）`, {
        code: 'HTTP',
        status: res.status,
        detail,
      })
    }
    return data
  }

  async function bytes(path, { signal, timeoutMs: perCall } = {}) {
    const url = abs(path)
    let res
    try {
      res = await fetch(url, { signal: mergeSignal(signal, perCall ?? timeoutMs) })
    } catch (error) {
      throw networkError(error, url)
    }
    if (!res.ok) {
      throw new ComfyError(`取图失败：ComfyUI 返回 ${res.status}（${path}）`, { code: 'HTTP', status: res.status })
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  return {
    baseUrl: root.replace(/\/$/, ''),

    /** 服务 + GPU 信息 */
    systemStats: (opts) => request('/system_stats', opts),

    /** 某个模型文件夹里的文件；文件夹不存在就当空数组 */
    async models(folder, opts) {
      try {
        const list = await request(`/models/${encodeURIComponent(folder)}`, opts)
        return Array.isArray(list) ? list : []
      } catch (error) {
        if (error instanceof ComfyError && (error.status === 404 || error.status === 400)) return []
        throw error
      }
    },

    /** 一次拿齐我们要的几个模型文件夹 */
    async modelIndex(opts) {
      const out = {}
      for (const folder of MODEL_FOLDERS) out[folder] = await this.models(folder, opts)
      return out
    },

    /** 单节点规范 */
    async nodeInfo(nodeClass, opts) {
      const data = await request(`/object_info/${encodeURIComponent(nodeClass)}`, opts)
      return data?.[nodeClass] ?? null
    },

    /** 全部节点（大，调用方自己缓存） */
    objectInfo: (opts) => request('/object_info', opts),

    /** 队列：正在跑的 + 排队的 */
    queue: (opts) => request('/queue', opts),

    /** 队列剩余条数（最轻的探活） */
    prompt: (opts) => request('/prompt', opts),

    /** 最近任务列表 */
    async jobs({ limit = 5, status } = {}, opts) {
      const query = new URLSearchParams({ limit: String(limit) })
      if (status) query.set('status', status)
      const data = await request(`/api/jobs?${query}`, opts)
      return Array.isArray(data?.jobs) ? data.jobs : []
    },

    /** 单个任务；不存在返回 null */
    async job(jobId, opts) {
      try {
        return await request(`/api/jobs/${encodeURIComponent(jobId)}`, opts)
      } catch (error) {
        if (error instanceof ComfyError && error.status === 404) return null
        throw error
      }
    },

    /** 某次生成的完整历史（含所有输出图）；还没有就返回 null */
    async historyEntry(promptId, opts) {
      const data = await request(`/history/${encodeURIComponent(promptId)}`, opts)
      return data?.[promptId] ?? null
    },

    /** 最近的生成历史列表 */
    async history(limit = 5, opts) {
      const data = await request(`/history?max_items=${encodeURIComponent(limit)}`, opts)
      return Object.entries(data ?? {}).map(([promptId, entry]) => ({ promptId, entry }))
    },

    /**
     * 提交一个 API 格式的工作流图。
     * 注意：这一层**不抛 HTTP 错**——ComfyUI 的图校验失败（400）会带着
     * node_errors 回来，那正好是模型改图需要的线索，所以原样交回去。
     * @returns {Promise<{ok: boolean, promptId?: string, number?: number, error?: string, nodeErrors?: unknown}>}
     */
    async submit(graph, { clientId, signal } = {}) {
      const payload = { prompt: graph, client_id: clientId ?? 'dsh-comfyui' }
      try {
        const data = await request('/prompt', { method: 'POST', body: payload, signal })
        return { ok: true, promptId: data?.prompt_id, number: data?.number, nodeErrors: data?.node_errors }
      } catch (error) {
        if (error instanceof ComfyError && error.code === 'HTTP' && error.detail) {
          const detail = error.detail
          return {
            ok: false,
            error: typeof detail.error === 'string' ? detail.error : detail.error?.message ?? `HTTP ${error.status}`,
            nodeErrors: detail.node_errors ?? null,
          }
        }
        throw error
      }
    },

    /** 图片字节 */
    view({ filename, subfolder = '', type = 'output' }, opts) {
      const query = new URLSearchParams({ filename, subfolder, type })
      return bytes(`/view?${query}`, opts)
    },

    /**
     * 上传一张图片到 ComfyUI 的 input 目录（img2img / 放大用）。
     * 走官方标准端点 POST /upload/image，multipart 字段 image / type / overwrite。
     * @returns {Promise<{name: string, subfolder: string, type: string}>}
     */
    async uploadImage(bytes, { filename = 'input.png', overwrite = true, subfolder = '', type = 'input' } = {}, opts = {}) {
      const form = new FormData()
      form.append('image', new Blob([bytes], { type: 'application/octet-stream' }), filename)
      form.append('type', type)
      form.append('overwrite', overwrite ? 'true' : 'false')
      if (subfolder) form.append('subfolder', subfolder)

      const url = abs('/upload/image')
      let res
      try {
        res = await fetch(url, {
          method: 'POST',
          body: form,
          signal: mergeSignal(opts.signal, opts.timeoutMs ?? timeoutMs),
        })
      } catch (error) {
        throw networkError(error, url)
      }
      const text = await res.text()
      let data
      try {
        data = text.length === 0 ? null : JSON.parse(text)
      } catch {
        data = text
      }
      if (!res.ok) {
        const detail = typeof data === 'object' && data !== null ? data : { body: String(data).slice(0, 500) }
        throw new ComfyError(`上传图片失败：ComfyUI 返回 ${res.status}（/upload/image）`, {
          code: 'HTTP',
          status: res.status,
          detail,
        })
      }
      return data
    },

    /** 中断正在跑的那个 */
    interrupt: (opts) => request('/interrupt', { method: 'POST', body: {}, ...opts }),

    /** 释放显存 / 卸载模型 */
    free: ({ unloadModels = false, freeMemory = true } = {}, opts) =>
      request('/free', { method: 'POST', body: { unload_models: unloadModels, free_memory: freeMemory }, ...opts }),

    /** 清空排队（不动正在跑的） */
    clearQueue: (opts) => request('/queue', { method: 'POST', body: { clear: true }, ...opts }),

    /** 取消某个任务（在跑就中断，在排队就删掉；已结束返回 cancelled:false） */
    cancelJob: (jobId, opts) =>
      request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: {}, ...opts }),
  }
}

/** 把用户的覆盖项和自动挑选拼起来：点名了就必须存在，否则给一份可选清单 */
function pickModel(available, wanted, folderLabel) {
  const list = Array.isArray(available) ? available : []
  if (wanted) {
    if (list.includes(wanted)) return wanted
    throw new ComfyError(
      `${folderLabel}「${wanted}」不存在；本机可选：${list.length ? list.join(', ') : '（这个文件夹是空的）'}`,
      { code: 'MODEL' },
    )
  }
  if (list.length === 0) {
    throw new ComfyError(`${folderLabel} 文件夹里一个模型都没有，没法用内置模板；改用 graph 传自己的工作流`, {
      code: 'MODEL',
    })
  }
  return list[0]
}

/**
 * 挑这次要用的模型文件。不点名就用文件夹里第一个。
 * @param {Record<string, string[]>} index - modelIndex() 的结果
 * @param {{unet?: string, clip?: string, vae?: string}} wanted
 */
export function resolveModels(index, wanted = {}) {
  return {
    unet: pickModel(index.diffusion_models, wanted.unet, '扩散模型（diffusion_models）'),
    clip: pickModel(index.text_encoders, wanted.clip, '文本编码器（text_encoders）'),
    vae: pickModel(index.vae, wanted.vae, 'VAE（vae）'),
  }
}

/**
 * 内置 txt2img 工作流（Qwen-Image / Anima 系三件套加载器）。
 * 结构照抄本机跑通过的那份，节点号固定，改参数只改 inputs。
 *
 * 连线必须写成 ["节点id字符串", 输出序号]。ComfyUI 的
 * execution.py:933 是 `prompt[o_id]['class_type']`，数字 id 会直接 KeyError。
 */
export function buildTxt2Img(options) {
  const {
    unet,
    clip,
    clipType = 'stable_diffusion',
    vae,
    prompt,
    negative,
    width = 1024,
    height = 1024,
    batch = 1,
    steps = 30,
    cfg = 4.9,
    seed = 0,
    sampler = 'euler',
    scheduler = 'simple',
    filenamePrefix = 'dsh/comfy',
    lora,
    loraStrength = 0.8,
  } = options

  const graph = {
    1: {
      class_type: 'UNETLoader',
      inputs: { unet_name: unet, weight_dtype: 'default' },
      _meta: { title: '加载扩散模型' },
    },
    2: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: clip, type: clipType, device: 'default' },
      _meta: { title: '加载文本编码器' },
    },
    3: { class_type: 'VAELoader', inputs: { vae_name: vae }, _meta: { title: '加载 VAE' } },
    4: {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['2', 0] },
      _meta: { title: '正面提示词' },
    },
    5: {
      class_type: 'CLIPTextEncode',
      inputs: { text: negative, clip: ['2', 0] },
      _meta: { title: '负面提示词' },
    },
    6: {
      class_type: 'EmptySD3LatentImage',
      inputs: { width, height, batch_size: batch },
      _meta: { title: '空白潜空间' },
    },
    7: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1,
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
      },
      _meta: { title: '采样器' },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] }, _meta: { title: '解码' } },
    9: {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: filenamePrefix },
      _meta: { title: '保存图像' },
    },
  }

  // 可选 LoRA：在 UNETLoader/CLIPLoader 之后插一个 LoraLoader（节点 10），
  // 用它输出的 model/clip 替换原来直接连进采样器和文本编码的连线。
  if (lora) {
    graph[10] = {
      class_type: 'LoraLoader',
      inputs: {
        model: ['1', 0],
        clip: ['2', 0],
        lora_name: lora,
        strength_model: loraStrength,
        strength_clip: loraStrength,
      },
      _meta: { title: '加载 LoRA' },
    }
    graph[4].inputs.clip = ['10', 1]
    graph[5].inputs.clip = ['10', 1]
    graph[7].inputs.model = ['10', 0]
  }

  return graph
}

/**
 * 内置 img2img 工作流：加载一张已有图片 → VAEEncode → 采样（denoise < 1）→ 解码 → 存图。
 * 节点号固定：1 UNETLoader, 2 CLIPLoader, 3 VAELoader, 4/5 CLIPTextEncode 正/负,
 *             6 LoadImage, 7 VAEEncode, 8 KSampler, 9 VAEDecode, 10 SaveImage。
 */
export function buildImg2Img(options) {
  const {
    unet,
    clip,
    clipType = 'stable_diffusion',
    vae,
    imageName,
    prompt,
    negative,
    denoise = 0.6,
    steps = 30,
    cfg = 4.9,
    seed = 0,
    sampler = 'euler',
    scheduler = 'simple',
    filenamePrefix = 'dsh/img2img',
  } = options

  if (!imageName) throw new ComfyError('img2img 必须给 imageName（上传到 ComfyUI input 目录后的文件名）', { code: 'GRAPH' })

  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' }, _meta: { title: '加载扩散模型' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: clipType, device: 'default' }, _meta: { title: '加载文本编码器' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: vae }, _meta: { title: '加载 VAE' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] }, _meta: { title: '正面提示词' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] }, _meta: { title: '负面提示词' } },
    6: { class_type: 'LoadImage', inputs: { image: imageName }, _meta: { title: '载入底图' } },
    7: { class_type: 'VAEEncode', inputs: { pixels: ['6', 0], vae: ['3', 0] }, _meta: { title: '编码潜空间' } },
    8: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise,
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['7', 0],
      },
      _meta: { title: '采样器' },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] }, _meta: { title: '解码' } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: filenamePrefix }, _meta: { title: '保存图像' } },
  }
}

/**
 * 内置放大工作流：LoadImage → ImageScale（算法放大，不依赖 upscale_models）→ SaveImage。
 * 节点号固定：1 LoadImage, 2 ImageScale, 3 SaveImage。
 */
export function buildUpscale(options) {
  const {
    imageName,
    width,
    height,
    method = 'lanczos',
    crop = 'disabled',
    filenamePrefix = 'dsh/upscale',
  } = options

  if (!imageName) throw new ComfyError('放大必须给 imageName（上传到 ComfyUI input 目录后的文件名）', { code: 'GRAPH' })
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new ComfyError('放大必须给正整数 width / height', { code: 'GRAPH' })
  }

  return {
    1: { class_type: 'LoadImage', inputs: { image: imageName }, _meta: { title: '载入底图' } },
    2: {
      class_type: 'ImageScale',
      inputs: { image: ['1', 0], upscale_method: method, width, height, crop },
      _meta: { title: '放大' },
    },
    3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: filenamePrefix }, _meta: { title: '保存图像' } },
  }
}

/**
 * 校验并归一化一份外部传入的 API 格式工作流图。
 * 最常见的错法是直接贴了「界面里保存的工作流」（{nodes:[...], links:[...]}），
 * 那种要 ComfyUI 前端转换，后端不认 —— 这里提前拦下来并说清楚。
 */
export function normalizeGraph(graph) {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new ComfyError('graph 必须是一个对象：{ "节点id": { class_type, inputs } }', { code: 'GRAPH' })
  }
  if (Array.isArray(graph.nodes) || Array.isArray(graph.links)) {
    throw new ComfyError(
      'graph 看起来是「界面版工作流」（有 nodes/links 数组），后端只认 API 格式：{ "节点id": { class_type, inputs } }。'
        + '在 ComfyUI 里用「导出 (API)」或 Save (API Format) 拿到的那种才对。',
      { code: 'GRAPH' },
    )
  }
  if (graph.prompt && typeof graph.prompt === 'object' && !Array.isArray(graph.prompt)) {
    throw new ComfyError('graph 外面不该再包一层 prompt；直接传 { "节点id": { class_type, inputs } } 这一层', {
      code: 'GRAPH',
    })
  }
  const entries = Object.entries(graph)
  if (entries.length === 0) throw new ComfyError('graph 是空的，至少要有一个节点', { code: 'GRAPH' })
  const out = {}
  for (const [id, node] of entries) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new ComfyError(`graph["${id}"] 不是节点对象`, { code: 'GRAPH' })
    }
    if (typeof node.class_type !== 'string' || node.class_type.length === 0) {
      throw new ComfyError(`graph["${id}"] 缺 class_type`, { code: 'GRAPH' })
    }
    if (node.inputs === null || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      throw new ComfyError(`graph["${id}"].inputs 必须是对象`, { code: 'GRAPH' })
    }
    // 复制一份再返回：调用方传进来的图往往被冻结（工具参数过校验层后就是只读的），
    // 而 injectPrompt 后面要往 inputs 里写提示词。顺手也避免改坏调用方自己的对象。
    out[id] = { ...node, inputs: { ...node.inputs } }
  }
  return out
}

/** 图里各节点是啥，给输出做一张小地图 */
export function summarizeGraph(graph) {
  const nodes = Object.entries(graph).map(([id, node]) => ({
    id,
    class_type: node.class_type,
    title: node._meta?.title,
  }))
  const byClass = {}
  for (const node of nodes) byClass[node.class_type] = (byClass[node.class_type] ?? 0) + 1
  return { count: nodes.length, nodes, byClass }
}

/**
 * 把提示词写进外来工作流图：点名了就用那个节点，没点名就找第一个 CLIPTextEncode。
 * @returns 实际写进去的节点 id（找不到就返回 null）
 */
export function injectPrompt(graph, text, nodeId) {
  if (typeof text !== 'string' || text.length === 0) return null
  if (nodeId) {
    const node = graph[nodeId]
    if (!node) {
      throw new ComfyError(
        `prompt_node 说的节点 "${nodeId}" 不在这张图里；图里的节点有：${Object.keys(graph).join(', ')}`,
        { code: 'GRAPH' },
      )
    }
    node.inputs = { ...node.inputs, text }
    return nodeId
  }
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type === 'CLIPTextEncode') {
      node.inputs = { ...node.inputs, text }
      return id
    }
  }
  return null
}

/** 从历史记录里把输出图摊平成一个列表 */
export function collectImages(entry) {
  const images = []
  for (const [nodeId, out] of Object.entries(entry?.outputs ?? {})) {
    for (const list of Object.values(out ?? {})) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item && typeof item.filename === 'string') {
          images.push({
            nodeId,
            filename: item.filename,
            subfolder: item.subfolder ?? '',
            type: item.type ?? 'output',
          })
        }
      }
    }
  }
  return images
}
