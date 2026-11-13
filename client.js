/**
 * client.js —— ComfyUI 桥（浏览器半端）：在「设置」里注册一页
 * ============================================================================
 * ⭐ 关键：DSH 设置页的左侧导航条目**不会自动出现**，必须由客户端半端
 *    往 `settings.section` 槽位注册一个条目（这正是 dsh-bili-scroll 能出现在
 *    设置里、而纯 host 插件不出现的原因）。
 *
 * 这里不依赖 @deepseek-ai/dsh-client-ui-primitives（那套是官方壳内部件），
 * 而是直接绑定宿主侧已经生成好的 `configForms` 命名空间（Config schema 的
 * volatile 字段），用 React 手写一个表单，改动即时写回（live 热生效）。
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
        lora: 'LoRA',
        loraHint: 'comfy_run 的 lora 参数挂角色 LoRA',
        upscale: '算法放大（upscale）',
        upscaleHint: 'comfy_upscale 放大一张已生成的图',
        choose: '选择审图模型',
        chooseHint: '从能看图的模型里挑一个（留空 = 回退当前会话模型）',
        loading: '正在读取模型列表…',
        emptyModels: '没找到能看图的模型（可在设置里配置能看图的服务商）',
        loadFailed: '读取模型列表失败',
        refresh: '刷新',
        auto: '跟随当前会话模型',
        unavailable: '该插件当前未加载，暂时无法配置。',
        readOnly: '本部署的设置为只读。',
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
        lora: 'LoRA',
        loraHint: 'comfy_run lora parameter to attach a character LoRA',
        upscale: 'Algorithmic upscale',
        upscaleHint: 'comfy_upscale enlarges an already-generated image',
        choose: 'Pick the review model',
        chooseHint: 'Pick one image-capable model (empty = fall back to the current session model)',
        loading: 'Loading models…',
        emptyModels: 'No image-capable models found (configure a provider that accepts images)',
        loadFailed: 'Failed to load models',
        refresh: 'Refresh',
        auto: 'Follow the current session model',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        readOnly: 'This deployment stores settings read-only.',
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
[data-comfy-select]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-comfy-select]:focus{outline:none;border-color:#3b82f6;}
[data-comfy-select][disabled]{opacity:.5;cursor:default;}
[data-comfy-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-comfy-msg][data-bad]{color:#ef4444;}
[data-comfy-note][data-bad]{color:#ef4444;}
[data-comfy-link]{font-size:11px;color:#3b82f6;cursor:pointer;background:none;border:0;padding:0;font-family:inherit;}
[data-comfy-link][disabled]{opacity:.4;cursor:default;}
`

    /* 读 configForms 命名空间的实时快照 */
    function useForm(form) {
      const subscribe = React.useCallback((cb) => form.subscribe(cb), [form])
      return React.useSyncExternalStore(subscribe, () => form.getSnapshot(), () => form.getSnapshot())
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
      return h('div', { 'data-comfy-row': '' },
        h('div', { 'data-comfy-grow': '' },
          h('div', { 'data-comfy-label': '' }, label),
          note ? h('div', { 'data-comfy-note': '' }, note) : null,
          h('input', {
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
          }),
        ),
      )
    }

    /* 宿主侧的路由：列出能看图的模型（浏览器半端没有 llm 服务） */
    const VISION_API = '/api/comfyui/vision-models'

    async function loadVisionModels() {
      const res = await fetch(VISION_API, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error(body?.error || 'unknown error')
      return Array.isArray(body.providers) ? body.providers : []
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
     * 选中即写回 review.provider / review.model。
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
          h('div', { 'data-comfy-row': '' },
            h('div', { 'data-comfy-label': '', style: { flex: 1 } }, label),
            h('button', {
              'data-comfy-link': '',
              disabled: disabled || state.status === 'loading',
              onClick: pull,
            }, t('refresh'))),
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

    function Panel({ form, t }) {
      const snap = useForm(form)

      if (!snap || snap.status === 'unavailable') {
        return h('div', { 'data-comfy-settings': '' },
          h('div', { 'data-comfy-msg': '' }, t('unavailable')))
      }
      const value = snap.value || {}
      const review = value.review || {}
      const disabled = snap.writable === false
      const set = (path, v) => {
        form.mutate([{ op: 'set', path, value: v }]).catch(() => {})
      }
      const get = (path) => {
        let cur = value
        for (const k of path) cur = (cur && typeof cur === 'object') ? cur[k] : undefined
        return cur
      }

      return h('div', { 'data-comfy-settings': '' },
        disabled ? h('div', { 'data-comfy-msg': '' }, t('readOnly')) : null,

        /* 审图 */
        h('div', { 'data-comfy-sec': '' },
          h('div', { 'data-comfy-h': '' }, t('review')),
          h(ToggleRow, {
            label: t('reviewEnabled'),
            on: review.enabled === true,
            disabled,
            onChange: (v) => set(['review', 'enabled'], v),
          }),
          // 模型选择器始终显示：还没打开上面的总开关时也能先挑好 / 看清有哪些能看图的模型
          h(ModelPicker, {
            label: t('choose'), note: t('chooseHint'),
            provider: review.provider ?? '', model: review.model ?? '',
            disabled, t,
            onChange: (nextProvider, nextModel) => {
              set(['review', 'provider'], nextProvider)
              set(['review', 'model'], nextModel)
            },
          }),
          h(TextRow, {
            label: t('maxAttempts'), numeric: true,
            value: review.maxAttempts ?? 1, disabled,
            onChange: (v) => set(['review', 'maxAttempts'], v),
          }),
          h(TextRow, {
            label: t('extra'), note: t('extraHint'),
            value: review.extra ?? '', disabled,
            onChange: (v) => set(['review', 'extra'], v),
          })),

        /* 图生图 */
        h('div', { 'data-comfy-sec': '' },
          h(ToggleRow, {
            label: t('img2img'), note: t('img2imgHint'),
            on: (value.img2img || {}).enabled === true, disabled,
            onChange: (v) => set(['img2img', 'enabled'], v),
          })),

        /* LoRA */
        h('div', { 'data-comfy-sec': '' },
          h(ToggleRow, {
            label: t('lora'), note: t('loraHint'),
            on: (value.lora || {}).enabled === true, disabled,
            onChange: (v) => set(['lora', 'enabled'], v),
          })),

        /* 放大 */
        h('div', { 'data-comfy-sec': '' },
          h(ToggleRow, {
            label: t('upscale'), note: t('upscaleHint'),
            on: (value.upscale || {}).enabled === true, disabled,
            onChange: (v) => set(['upscale', 'enabled'], v),
          })),
      )
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

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, LOCALES), 'comfyui: settings dictionaries')
      ctx.effect(() => installStyle(), 'comfyui: settings styles')

      const form = ctx.configForms.get('comfyui')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'comfyui',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, () => h(Panel, { form, t })))
    }

    return { inject, apply }
  },
})
