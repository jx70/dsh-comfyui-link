/**
 * client.js —— ComfyUI 桥（浏览器半端）：设置页 + 输入框左侧的绘图控件
 * ============================================================================
 * ⭐ 关键：DSH 设置页的左侧导航条目**不会自动出现**，必须由客户端半端
 *    往 `settings.section` 槽位注册一个条目（这正是 dsh-bili-scroll 能出现在
 *    设置里、而纯 host 插件不出现的原因）。
 *
 * 两处 UI：
 *   1) settings.section  —— 审图 / 图生图 / 放大。**草稿 + 「保存」**：
 *      改动先落在本地草稿里，点保存才一次性写回（settings.mutate 就是落盘，
 *      没有单独的 flush API，所以「保存」= 攒够一批再提交）。
 *   2) conversation.input.left —— 「绘图」控件：生图模型下拉 + LoRA 开关。
 *      **只在「绘图模式」（preset id = draw）的会话里渲染**：别的模式没有生图
 *      这件事，挂着两个用不上的控件只会脏了输入框。判断依据是会话的
 *      agentPreset 投影（state.byId[sessionId].projectionValues.agentPreset），
 *      跟出厂 AgentPresetLabel 读的是同一份数据。
 *      这两个是即时生效的（改一下立刻写），因为它们要跟着手边的对话走。
 *      底层是同一个 configForms 命名空间里的 `draw` 段（volatile）。
 *
 * 这里不依赖 @deepseek-ai/dsh-client-ui-primitives（那套是官方壳内部件），
 * 而是直接绑定宿主侧已经生成好的 `configForms` 命名空间，用 React 手写。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-comfyui-link',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'comfyui.settings'

    const LOCALES = {
      zh: {
        nav: 'ComfyUI 桥',
        review: '审图（生图后自动把关）',
        reviewEnabled: '开启「生图后审图、不满自动重画」',
        provider: '审图模型 provider',
        providerHint: '留空 = 回退当前会话模型。',
        model: '审图模型 id',
        modelHint: '留空 = 回退当前会话模型。',
        maxAttempts: '最多重生成几次',
        extra: '额外审图要求',
        extraHint: '如「角色必须还原银色长发」',
        img2img: '图生图（img2img）',
        img2imgHint: 'comfy_run mode="img2img" 基于已有图重绘',
        upscale: '算法放大（upscale）',
        upscaleHint: 'comfy_upscale 放大一张已生成的图',
        output: '图片输出',
        outputDir: '输出目录',
        outputDirHint: '点「选择」挑一个目录；留空 = 图只留在 ComfyUI 自己的 output 里。',
        outputEmpty: '没选（图留在 ComfyUI 的 output）',
        outputClear: '清除',
        outputUnsupported: '这个平台没有系统文件夹选择框，输出目录在这里设不了；要改就写进 profile 的 cordis.patch.yml（output.dir）。',
        pick: '选择',
        pickHint: '弹出系统文件夹选择框挑一个目录',
        picking: '等待选择…',
        pickFailed: '打开选择框失败',
        choose: '选择审图模型',
        chooseHint: '从能看图的模型里挑一个（留空 = 回退当前会话模型）',
        loading: '正在读取模型列表…',
        emptyModels: '没找到能看图的模型（可在设置里配置能看图的服务商）',
        loadFailed: '读取模型列表失败',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        dirty: '有未保存的改动',
        idleHint: '改动先留在本地，点「保存」才写入。输入框左侧的绘图控件是即时生效的。',
        auto: '跟随当前会话模型',
        unavailable: '该插件当前未加载，暂时无法配置。',
        readOnly: '本部署的设置为只读。',
        drawBar: '绘图',
        drawModel: '生图模型',
        drawAuto: '自动（默认模型）',
        drawHint: '出图时用这个扩散模型',
        allowLora: '允许挂 LoRA（点一下关掉）',
        loraBlocked: 'LoRA 已关：不允许挂角色 LoRA（点一下打开）',
        drawLoadFailed: '读不到 ComfyUI 模型清单',
      },
      en: {
        nav: 'ComfyUI Bridge',
        review: 'Review (auto-check after generation)',
        reviewEnabled: 'Review after generating and auto-regenerate on dissatisfaction',
        provider: 'Review model provider',
        providerHint: 'Empty = fall back to the current session model.',
        model: 'Review model id',
        modelHint: 'Empty = fall back to the current session model.',
        maxAttempts: 'Max regenerate attempts',
        extra: 'Extra review requirements',
        extraHint: 'e.g. "the character must keep silver long hair"',
        img2img: 'Image-to-image (img2img)',
        img2imgHint: 'comfy_run mode="img2img" redraws from an existing image',
        upscale: 'Algorithmic upscale',
        upscaleHint: 'comfy_upscale enlarges an already-generated image',
        output: 'Image output',
        outputDir: 'Output directory',
        outputDirHint: 'Press Pick to choose a folder; empty = images stay in ComfyUI own output.',
        outputEmpty: 'Not chosen (images stay in ComfyUI own output)',
        outputClear: 'Clear',
        outputUnsupported: 'This platform has no native folder picker, so the output directory cannot be set here; edit output.dir in the profile cordis.patch.yml instead.',
        pick: 'Pick',
        pickHint: 'Open the system folder picker',
        picking: 'Waiting…',
        pickFailed: 'Could not open the folder picker',
        choose: 'Pick the review model',
        chooseHint: 'Pick one image-capable model (empty = fall back to the current session model)',
        loading: 'Loading models…',
        emptyModels: 'No image-capable models found (configure a provider that accepts images)',
        loadFailed: 'Failed to load models',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        dirty: 'Unsaved changes',
        idleHint: 'Edits stay local until you press Save. The draw controls beside the composer apply immediately.',
        auto: 'Follow the current session model',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        readOnly: 'This deployment stores settings read-only.',
        drawBar: 'Draw',
        drawModel: 'Diffusion model',
        drawAuto: 'Auto (default model)',
        drawHint: 'The diffusion model used for generation',
        allowLora: 'LoRA allowed (click to turn off)',
        loraBlocked: 'LoRA off: character LoRAs are blocked (click to allow)',
        drawLoadFailed: 'Cannot read the ComfyUI model list',
      },
    }

    const CSS = `
[data-comfy-settings]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:640px;}
[data-comfy-sec]{display:flex;flex-direction:column;gap:10px;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16));}
[data-comfy-sec]:last-child{border-bottom:0;padding-bottom:0;}
[data-comfy-h]{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
[data-comfy-row]{display:flex;align-items:flex-start;gap:10px;}
[data-comfy-grow]{flex:1;min-width:0;}
[data-comfy-label]{font-size:13px;color:var(--dsw-alias-label-primary,inherit);}
[data-comfy-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);margin-top:2px;}
[data-comfy-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;margin-top:2px;}
[data-comfy-sw][data-on]{background:#3b82f6;}
[data-comfy-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-comfy-sw][data-on] i{left:19px;}
[data-comfy-sw][disabled]{opacity:.45;cursor:default;}
[data-comfy-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-comfy-input]:focus{outline:none;border-color:#3b82f6;}
[data-comfy-num]{width:88px;}
[data-comfy-path]{box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;line-height:18px;
  min-height:32px;word-break:break-all;
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-comfy-path][data-empty]{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-comfy-actions]{display:flex;flex:none;align-items:center;gap:6px;}
[data-comfy-clear]{flex:none;padding:7px 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);transition:opacity .15s,color .15s;}
[data-comfy-clear]:hover{color:inherit;border-color:#ef4444;}
[data-comfy-clear]:focus-visible{outline:2px solid #3b82f6;outline-offset:1px;}
[data-comfy-clear][disabled]{opacity:.45;cursor:default;}
[data-comfy-pick]{flex:none;padding:7px 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;transition:opacity .15s;}
[data-comfy-pick]:hover{border-color:#3b82f6;}
[data-comfy-pick]:focus-visible{outline:2px solid #3b82f6;outline-offset:1px;}
[data-comfy-pick][disabled]{opacity:.45;cursor:default;}
[data-comfy-select]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-comfy-select]:focus{outline:none;border-color:#3b82f6;}
[data-comfy-select][disabled]{opacity:.5;cursor:default;}
[data-comfy-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-comfy-msg][data-bad]{color:#ef4444;}
[data-comfy-note][data-bad]{color:#ef4444;}
[data-comfy-status]{flex:1;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-comfy-status][data-bad]{color:#ef4444;}
[data-comfy-btn]{flex:none;padding:7px 14px;border-radius:8px;border:1px solid transparent;cursor:pointer;
  font-family:inherit;font-size:12px;background:#3b82f6;color:#fff;transition:opacity .15s;}
[data-comfy-btn][disabled]{opacity:.4;cursor:default;}
[data-comfy-btn]:focus-visible{outline:2px solid #93c5fd;outline-offset:1px;}
[data-comfy-drawbar]{display:flex;align-items:center;gap:6px;min-width:0;}
[data-comfy-mini]{max-width:190px;box-sizing:border-box;padding:4px 6px;border-radius:7px;font-size:11px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-comfy-mini]:focus{outline:none;border-color:#3b82f6;}
[data-comfy-mini][disabled]{opacity:.5;cursor:default;}
[data-comfy-chip]{flex:none;padding:3px 8px;border-radius:11px;cursor:pointer;font-family:inherit;
  font-size:11px;line-height:16px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.18));
  background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);transition:background .15s,color .15s;}
[data-comfy-chip][data-on]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-comfy-chip][disabled]{opacity:.45;cursor:default;}
`

    /* 读 configForms 命名空间的实时快照（form 可能不存在：对应插件没加载） */
    function useForm(form) {
      const subscribe = React.useCallback((cb) => (form ? form.subscribe(cb) : () => {}), [form])
      const read = React.useCallback(() => (form ? form.getSnapshot() : undefined), [form])
      return React.useSyncExternalStore(subscribe, read, read)
    }

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-comfy-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-comfy-row': '' },
        h('div', { 'data-comfy-grow': '' },
          h('div', { 'data-comfy-label': '' }, label),
          note ? h('div', { 'data-comfy-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    function TextRow({ label, note, value, onChange, disabled, numeric }) {
      const [draft, setDraft] = React.useState(null)
      React.useEffect(() => { setDraft(null) }, [value])
      const field = h('input', {
        'data-comfy-input': '',
        'data-comfy-num': numeric ? '' : undefined,
        type: numeric ? 'number' : 'text',
        value: draft === null ? String(value ?? '') : draft,
        disabled: Boolean(disabled),
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => {
          const v = draft === null ? null : (numeric ? Number(draft) : draft)
          setDraft(null)
          if (v === null) return
          if (numeric && !Number.isFinite(v)) return
          onChange(numeric ? Math.max(1, Math.min(5, Math.round(v))) : v)
        },
      })
      return h('div', { 'data-comfy-row': '' },
        h('div', { 'data-comfy-grow': '' },
          h('div', { 'data-comfy-label': '' }, label),
          note ? h('div', { 'data-comfy-note': '' }, note) : null,
          field,
        ),
      )
    }

    /* 宿主侧的路由：列出能看图的模型（浏览器半端没有 llm 服务） */
    const VISION_API = '/api/comfyui/vision-models'
    /* 宿主侧的路由：列出 ComfyUI 里有哪些模型（浏览器半端没有 comfy 客户端） */
    const DRAW_API = '/api/comfyui/draw-models'
    /* 宿主侧的路由：弹系统文件夹选择框（浏览器没有原生选目录能力） */
    const PICK_API = '/api/comfyui/pick-directory'

    /**
     * 让宿主弹一个原生文件夹选择框，返回用户挑的路径。
     * 取消 / 平台不支持都返回 ''（调用方什么都不改）。
     */
    async function pickFolder(initial) {
      const res = await fetch(PICK_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initial: String(initial ?? '') }),
      })
      const body = await res.json().catch(() => null)
      if (body && typeof body.path === 'string' && body.ok === true) return body.path
      if (body && body.cancelled === true) return ''
      const reason = body?.error || (body?.reason === 'unsupported' ? 'unsupported' : `HTTP ${res.status}`)
      const error = new Error(reason)
      error.reason = body?.reason ?? ''
      throw error
    }

    async function loadVisionModels() {
      const res = await fetch(VISION_API, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error(body?.error || 'unknown error')
      return Array.isArray(body.providers) ? body.providers : []
    }

    async function loadDrawModels() {
      let res
      try {
        res = await fetch(DRAW_API, { credentials: 'same-origin' })
      } catch (error) {
        throw new Error(error?.message ?? String(error))
      }
      let body = null
      try { body = await res.json() } catch { body = null }
      if (!res.ok || !body || body.ok !== true) {
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const folders = body.folders || {}
      return {
        unets: Array.isArray(folders.diffusion_models) ? folders.diffusion_models : [],
        loras: Array.isArray(folders.loras) ? folders.loras : [],
      }
    }

    /* 值编码成 "provider|model"，空串 = 跟随当前会话模型 */
    function encodeModel(provider, model) {
      return provider && model ? `${provider}|${model}` : ''
    }
    function decodeModel(value) {
      const at = String(value ?? '').indexOf('|')
      if (at <= 0) return { provider: '', model: '' }
      return { provider: value.slice(0, at), model: value.slice(at + 1) }
    }

    /**
     * 审图模型选择器：从宿主拉一份能看图的模型清单，按 provider 分组渲染。
     * 选中即写进设置页草稿的 review.provider / review.model。
     */
    function ModelPicker({ label, note, provider, model, onChange, disabled, t }) {
      const [state, setState] = React.useState({ status: 'loading', providers: [], error: '' })
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const pull = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: '' }))
        loadVisionModels().then(
          (providers) => { if (alive.current) setState({ status: 'ready', providers, error: '' }) },
          (error) => { if (alive.current) setState({ status: 'error', providers: [], error: error?.message ?? String(error) }) },
        )
      }, [])

      // 打开设置页时拉一次即可；以前那个「刷新」按钮已经删掉
      React.useEffect(() => { pull() }, [pull])

      const current = encodeModel(provider, model)
      const flat = []
      for (const p of state.providers) {
        for (const m of p.models ?? []) flat.push({ p, m, value: encodeModel(p.id, m.id) })
      }
      // 当前选中的组合不在清单里（比如手填的旧值）也要能显示出来，否则会静默丢值
      const stale = current !== '' && !flat.some((x) => x.value === current)

      const note2 = state.status === 'error'
        ? `${t('loadFailed')}：${state.error}`
        : state.status === 'loading'
          ? t('loading')
          : flat.length === 0
            ? t('emptyModels')
            : note

      return h('div', { 'data-comfy-row': '' },
        h('div', { 'data-comfy-grow': '' },
          h('div', { 'data-comfy-label': '' }, label),
          note2 ? h('div', {
            'data-comfy-note': '',
            'data-bad': state.status === 'error' ? '' : undefined,
          }, note2) : null,
          h('select', {
            'data-comfy-select': '',
            value: current,
            disabled: Boolean(disabled) || state.status !== 'ready',
            onChange: (e) => {
              const next = decodeModel(e.target.value)
              onChange(next.provider, next.model)
            },
          },
            h('option', { value: '' }, t('auto')),
            stale ? h('option', { value: current },
              `${provider} / ${model}（不在当前清单）`) : null,
            state.providers.map((p) => h('optgroup', { key: p.id, label: p.name },
              (p.models ?? []).map((m) => h('option', {
                key: `${p.id}|${m.id}`,
                value: encodeModel(p.id, m.id),
                title: m.description || m.id,
              }, m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id)))),
          ),
        ),
      )
    }

    /* 设置页里参与「草稿 + 保存」的字段（draw 段属于对话栏，不在设置页） */
    const EDITABLE = [
      ['review', 'enabled'],
      ['review', 'provider'],
      ['review', 'model'],
      ['review', 'maxAttempts'],
      ['review', 'extra'],
      ['img2img', 'enabled'],
      ['upscale', 'enabled'],
      ['output', 'dir'],
    ]

    function readPath(source, head, leaf) {
      const group = source ? source[head] : undefined
      return group ? group[leaf] : undefined
    }

    function Panel({ form, t }) {
      const snap = useForm(form)
      // 草稿按字段级别记：null = 完全跟随快照，有键 = 本地改过还没保存
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState('idle') // idle | saving | saved | error
      const [error, setError] = React.useState('')
      // 选目录：picking 期间按钮变灰（宿主那边也有一把锁，双保险防连点）
      const [picking, setPicking] = React.useState(false)
      const [pickError, setPickError] = React.useState('')
      const timer = React.useRef(null)
      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

      if (!snap || snap.status === 'unavailable') {
        return h('div', { 'data-comfy-settings': '' },
          h('div', { 'data-comfy-msg': '' }, t('unavailable')))
      }
      if (snap.status === 'loading') {
        return h('div', { 'data-comfy-settings': '' },
          h('div', { 'data-comfy-msg': '' }, t('loading')))
      }

      const snapValue = snap.value || {}
      const local = draft || {}
      const disabled = snap.writable === false
      const pick = (head, leaf) => {
        const key = `${head}.${leaf}`
        return Object.prototype.hasOwnProperty.call(local, key) ? local[key] : readPath(snapValue, head, leaf)
      }
      const set = (head, leaf, v) => {
        setStatus((s) => (s === 'saved' ? 'idle' : s))
        setDraft((prev) => ({ ...(prev || {}), [`${head}.${leaf}`]: v }))
      }

      const view = {
        review: {
          enabled: pick('review', 'enabled') === true,
          provider: pick('review', 'provider') ?? '',
          model: pick('review', 'model') ?? '',
          maxAttempts: pick('review', 'maxAttempts') ?? 1,
          extra: pick('review', 'extra') ?? '',
        },
        img2img: { enabled: pick('img2img', 'enabled') === true },
        upscale: { enabled: pick('upscale', 'enabled') === true },
        output: { dir: pick('output', 'dir') ?? '' },
      }

      const ops = []
      for (const [head, leaf] of EDITABLE) {
        const next = pick(head, leaf)
        const prev = readPath(snapValue, head, leaf)
        if (next === prev) continue
        let value = next
        if (value === undefined || value === null) {
          value = typeof prev === 'boolean' ? false : (typeof prev === 'number' ? 1 : '')
        }
        ops.push({ op: 'set', path: [head, leaf], value })
      }

      const save = () => {
        if (disabled || status === 'saving' || ops.length === 0) return
        setStatus('saving')
        setError('')
        form.mutate(ops).then(
          () => {
            // 快照这时已经是新值，清掉草稿就自然跟上
            setDraft(null)
            setStatus('saved')
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2400)
          },
          (err) => {
            setStatus('error')
            setError(err?.message ?? String(err))
          },
        )
      }

      /* 点「选择」：宿主弹原生文件夹选择框，挑完的路径只进草稿，仍要点「保存」 */
      const chooseOutputDir = () => {
        if (disabled || picking) return
        setPicking(true)
        setPickError('')
        pickFolder(view.output.dir).then(
          (picked) => {
            setPicking(false)
            if (typeof picked === 'string' && picked.length > 0) set('output', 'dir', picked)
          },
          (err) => {
            setPicking(false)
            setPickError(err?.reason === 'unsupported' ? t('outputUnsupported') : (err?.message || t('pickFailed')))
          },
        )
      }

      const noteText = status === 'error'
        ? `${t('saveFailed')}：${error}`
        : status === 'saving'
          ? t('saving')
          : status === 'saved'
            ? t('saved')
            : ops.length > 0
              ? t('dirty')
              : t('idleHint')

      return h('div', { 'data-comfy-settings': '' },
        disabled ? h('div', { 'data-comfy-msg': '' }, t('readOnly')) : null,

        /* 审图 */
        h('div', { 'data-comfy-sec': '' },
          h('div', { 'data-comfy-h': '' }, t('review')),
          h(ToggleRow, {
            label: t('reviewEnabled'),
            on: view.review.enabled,
            disabled,
            onChange: (v) => set('review', 'enabled', v),
          }),
          // 模型选择器始终显示：还没打开上面的总开关时也能先挑好 / 看清有哪些能看图的模型
          h(ModelPicker, {
            label: t('choose'), note: t('chooseHint'),
            provider: view.review.provider, model: view.review.model,
            disabled, t,
            onChange: (nextProvider, nextModel) => {
              set('review', 'provider', nextProvider)
              set('review', 'model', nextModel)
            },
          }),
          h(TextRow, {
            label: t('maxAttempts'), numeric: true,
            value: view.review.maxAttempts, disabled,
            onChange: (v) => set('review', 'maxAttempts', v),
          }),
          h(TextRow, {
            label: t('extra'), note: t('extraHint'),
            value: view.review.extra, disabled,
            onChange: (v) => set('review', 'extra', v),
          })),

        /* 图生图 */
        h('div', { 'data-comfy-sec': '' },
          h(ToggleRow, {
            label: t('img2img'), note: t('img2imgHint'),
            on: view.img2img.enabled, disabled,
            onChange: (v) => set('img2img', 'enabled', v),
          })),

        /* 放大 */
        h('div', { 'data-comfy-sec': '' },
          h(ToggleRow, {
            label: t('upscale'), note: t('upscaleHint'),
            on: view.upscale.enabled, disabled,
            onChange: (v) => set('upscale', 'enabled', v),
          })),

        /* 图片输出：只能靠「选择」按钮挑，不再提供手填框 */
        h('div', { 'data-comfy-sec': '' },
          h('div', { 'data-comfy-h': '' }, t('output')),
          h('div', { 'data-comfy-row': '' },
            h('div', { 'data-comfy-grow': '' },
              h('div', { 'data-comfy-label': '' }, t('outputDir')),
              h('div', { 'data-comfy-note': '' }, t('outputDirHint')),
              h('div', {
                'data-comfy-path': '',
                'data-empty': view.output.dir ? undefined : '',
                title: view.output.dir || undefined,
              }, view.output.dir || t('outputEmpty'))),
            h('div', { 'data-comfy-actions': '' },
              h('button', {
                'data-comfy-pick': '',
                type: 'button',
                disabled: Boolean(disabled) || picking,
                title: t('pickHint'),
                onClick: chooseOutputDir,
              }, picking ? t('picking') : t('pick')),
              view.output.dir
                ? h('button', {
                  'data-comfy-clear': '',
                  type: 'button',
                  disabled: Boolean(disabled) || picking,
                  onClick: () => { setPickError(''); set('output', 'dir', '') },
                }, t('outputClear'))
                : null)),
          pickError
            ? h('div', { 'data-comfy-note': '', 'data-bad': '' }, pickError)
            : null),

        /* 保存（攒够一批再一次写回；对话栏那两个选项不走这里） */
        h('div', { 'data-comfy-row': '' },
          h('button', {
            'data-comfy-btn': '',
            type: 'button',
            disabled: Boolean(disabled) || status === 'saving' || ops.length === 0,
            onClick: save,
          }, status === 'saving' ? t('saving') : t('save')),
          h('div', {
            'data-comfy-status': '',
            'data-bad': status === 'error' ? '' : undefined,
          }, noteText)),
      )
    }

    /**
     * 输入框左侧的绘图控件：生图模型 + LoRA 开关。
     * **只在「绘图模式」里出现** —— 会话的 agentPreset 投影不是 draw 时整体返回 null，
     * 别的模式（标准/极简/PTC/创造）不该被这两个用不上的控件占位。
     * 新建会话还没记录投影时，退回「默认预设」来判（两者都不是 draw 就不显示）。
     * 这两项是即时生效的（改一下立刻写回 draw 段），所以不参与设置页的「保存」。
     */
    function DrawBar({ form, t, sessionId, useSessions, defaultPresetOf }) {
      const snap = useForm(form)
      const [models, setModels] = React.useState({ status: 'loading', unets: [], error: '' })
      const [fallbackPreset, setFallbackPreset] = React.useState(undefined)
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      // 跟出厂 AgentPresetLabel 读同一份投影：新建会话还没记录 preset 时是 undefined
      const readPreset = typeof useSessions === 'function' ? useSessions : () => undefined
      const preset = readPreset((state) => {
        const raw = state?.byId?.[sessionId]?.projectionValues?.agentPreset
        return typeof raw === 'string' ? raw : undefined
      })

      React.useEffect(() => {
        if (preset !== undefined || typeof defaultPresetOf !== 'function') return undefined
        let live = true
        defaultPresetOf().then(
          (id) => { if (live) setFallbackPreset(id) },
          () => { if (live) setFallbackPreset('') },
        )
        return () => { live = false }
      }, [preset, defaultPresetOf])

      const effective = preset ?? fallbackPreset
      const inDraw = effective === 'draw'

      React.useEffect(() => {
        if (!inDraw) return undefined
        loadDrawModels().then(
          (next) => { if (alive.current) setModels({ status: 'ready', unets: next.unets, error: '' }) },
          (error) => {
            if (alive.current) setModels({ status: 'error', unets: [], error: error?.message ?? String(error) })
          },
        )
        return undefined
      }, [inDraw])

      if (!inDraw) return null
      if (!snap || snap.status === 'unavailable' || snap.status === 'loading') return null
      const value = snap.value || {}
      const draw = value.draw || {}
      const disabled = snap.writable === false
      const unet = typeof draw.unet === 'string' ? draw.unet : ''
      const lora = draw.lora === true
      const setDraw = (key, v) => {
        form.mutate([{ op: 'set', path: ['draw', key], value: v }]).catch(() => {})
      }

      const note = models.status === 'error'
        ? `${t('drawLoadFailed')}：${models.error}`
        : models.status === 'loading'
          ? t('loading')
          : `${t('drawHint')}${models.unets.length > 0 ? `（${models.unets.length}）` : ''}`
      const stale = unet !== '' && !models.unets.includes(unet)

      return h('div', { 'data-comfy-drawbar': '', title: note },
        h('select', {
          'data-comfy-mini': '',
          'aria-label': t('drawModel'),
          title: note,
          value: unet,
          disabled: Boolean(disabled) || models.status === 'loading',
          onChange: (e) => setDraw('unet', e.target.value),
        },
          h('option', { value: '' }, t('drawAuto')),
          stale ? h('option', { value: unet }, unet) : null,
          models.unets.map((name) => h('option', { key: name, value: name }, name))),
        h('button', {
          'data-comfy-chip': '',
          'data-on': lora ? '' : undefined,
          'aria-pressed': lora ? 'true' : 'false',
          type: 'button',
          disabled: Boolean(disabled),
          title: lora ? t('allowLora') : t('loraBlocked'),
          onClick: () => { if (!disabled) setDraw('lora', !lora) },
        }, 'LoRA'))
    }

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      const tagId = 'dsh-comfyui-link/settings'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-comfyui-link'
      style.dataset.pluginCss = tagId
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    const inject = ['slots', 'locale', 'configForms']

    /** agent-preset-registry 的设置命名空间（出厂常量，读默认预设用） */
    const PRESET_NS = 'agent-preset-registry'

    /**
     * 读出「默认预设」的 id：新建会话还没记录 agentPreset 投影时用它兜底判断。
     * 空串 = 读不到（那就干脆不显示绘图控件，宁可不显示也别在别的模式里乱塞）。
     */
    function defaultPresetReader(ctx) {
      return async () => {
        const form = ctx.configForms.get(PRESET_NS)
        if (!form) return ''
        const snap = form.getSnapshot()
        const value = snap?.value || {}
        const id = typeof value.selectedDefault === 'string' && value.selectedDefault !== ''
          ? value.selectedDefault
          : (typeof value.default === 'string' ? value.default : '')
        return id
      }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, LOCALES), 'comfyui: settings dictionaries')
      ctx.effect(() => installStyle(), 'comfyui: settings styles')

      const form = ctx.configForms.get('comfyui')
      const defaultPresetOf = defaultPresetReader(ctx)

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'comfyui',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, () => h(Panel, { form, t })))

      // 输入框左侧：生图模型 + LoRA 开关 —— 只在「绘图模式」的会话里渲染。
      // inject(sessionId) 把会话 id 与 configForms 句柄透给组件；组件再用标准 prop
      // useSessions 读 agentPreset 投影，preset !== 'draw' 时直接不渲染。
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'comfyui-draw',
        order: 60,
        label: () => t('drawBar'),
        locale: NS,
        inject: (sessionId) => ({ sessionId, form, defaultPresetOf }),
      }, DrawBar))
    }

    return { inject, apply }
  },
})
