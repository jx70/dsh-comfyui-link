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
        pageHint: '改完点「保存」才生效。',
        features: '功能开关',
        featuresNote: '关掉后对应工具会被拒绝',
        review: '审图',
        reviewNote: '生图后自动把关，不满意就重画',
        reviewEnabled: '开启审图',
        provider: '审图模型 provider',
        providerHint: '留空 = 跟随当前会话',
        model: '审图模型 id',
        modelHint: '留空 = 跟随当前会话',
        maxAttempts: '最多重生成几次',
        img2img: '图生图（img2img）',
        img2imgHint: '基于已有图重绘',
        upscale: '算法放大（upscale）',
        upscaleHint: '放大一张已生成的图',
        output: '图片输出',
        outputNote: '出图后额外复制一份到此处',
        outputDir: '输出目录',
        outputDirHint: '留空 = 图只留在 ComfyUI 的 output',
        outputEmpty: '没选（图留在 ComfyUI 的 output）',
        outputClear: '清除',
        outputUnsupported: '此平台无文件夹选择框；请改 cordis.patch.yml 的 output.dir',
        loraDocs: 'LoRA 提示词',
        loraDocsNote: '挂 LoRA 时按内容挑一篇并进 prompt',
        loraDocsDir: '提示词目录',
        loraDocsHint: '可混放角色/画风/tag 文档，文件名不必对齐；留空不读',
        loraDocsEmpty: '没选（不读提示词文档）',
        loraDocsBudget: '字数预算',
        loraDocsBudgetHint: '每篇最多并入多少字（200–20000），超了在换行处收口',
        loraDocsFound: '已识别 {n} 篇候选（{m} 篇像提示词）',
        loraDocsReadFailed: '读不了这个目录',
        pick: '选择',
        pickHint: '打开系统文件夹选择框',
        picking: '等待选择…',
        pickFailed: '打开选择框失败',
        choose: '选择审图模型',
        chooseHint: '挑一个能看图的模型（留空 = 跟随当前会话）',
        loading: '正在读取模型列表…',
        emptyModels: '没找到能看图的模型',
        loadFailed: '读取模型列表失败',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        dirty: '有未保存的改动',
        auto: '跟随当前会话模型',
        unavailable: '该插件当前未加载，暂时无法配置。',
        readOnly: '本部署的设置为只读。',
        drawBar: '绘图',
        drawModel: '生图模型',
        drawAuto: '自动（默认模型）',
        drawHint: '出图用的模型（整合包/三件套均可）',
        drawGroupUnet: '扩散模型（三件套）',
        drawGroupCheckpoint: '整合包（checkpoints，一个文件带 MODEL/CLIP/VAE）',
        allowLora: '允许挂 LoRA（点一下关掉）',
        loraBlocked: 'LoRA 已关：不允许挂角色 LoRA（点一下打开）',
        drawLoadFailed: '读不到 ComfyUI 模型清单',
        // ── 会话视图「ComfyUI」页 ──
        viewTab: 'ComfyUI',
        wsWorkflow: '工作流',
        wsImages: '产出图片',
        wsQueue: '队列',
        wsRefresh: '刷新',
        wsRefreshing: '刷新中…',
        wsEmpty: '还没有生成记录。用对话里的绘图工具出一张图，或点「刷新」。',
        wsOffline: 'ComfyUI 没在跑（{url}）。先把本机 ComfyUI 启动起来再刷新。',
        wsRunning: '正在跑',
        wsPending: '排队中',
        wsRecent: '最近完成',
        wsNoQueue: '队列是空的',
        wsParams: '可改参数',
        wsPrompt: '正面提示词',
        wsNegative: '负面提示词',
        wsWidth: '宽',
        wsHeight: '高',
        wsSteps: '步数',
        wsCfg: 'CFG',
        wsSeed: '种子',
        wsSampler: '采样器',
        wsScheduler: '调度器',
        wsLora: 'LoRA',
        wsResubmit: '改参重提交',
        wsSubmitting: '提交中…',
        wsSubmitted: '已提交 · prompt_id {id}',
        wsGraph: '节点图',
        wsNodeCount: '{n} 个节点 · {m} 条连线',
        wsEnlarge: '放大',
        wsClose: '关闭',
        wsFindWorkflow: '反查工作流',
        wsNoWorkflow: '这张图查不到工作流：{reason}',
        wsSourceIndex: '来自出图索引',
        wsSourceHistory: '来自 ComfyUI 历史',
        wsClickImage: '点一张图，看它当时用的完整工作流，并改参重生成。',
        wsSelectWorkflow: '从下面选一次生成记录，查看/编辑它当时的工作流。',
        wsPickEmpty: '还没有生成记录。用对话里的 comfy_run 出一张图，这里就会出现它。',
        wsNoGraph: '这条记录没有可用的工作流节点图。',
        wsLoadFailed: '读不到工作区数据：{reason}',
        wsLegend: '图例',
        wsKindLoader: '模型加载',
        wsKindClip: '文本编码',
        wsKindLatent: '潜变量',
        wsKindSampler: '采样器',
        wsKindLora: 'LoRA',
        wsKindVae: 'VAE',
        wsKindOutput: '输出',
        wsKindOther: '其他',
        wsLegendHint: '点击高亮该类节点，再点一次取消',
        // 节点用途说明（具体节点优先，按类别兜底）
        wsHelpCheckpoint: '加载生图模型（MODEL / CLIP / VAE）',
        wsHelpUnet: '加载扩散模型（三件套的 MODEL）',
        wsHelpLora: '加载 LoRA 微调并控制强度',
        wsHelpClip: '把文字编码成提示词条件',
        wsHelpLatent: '建空白 latent，决定尺寸与批量',
        wsHelpSampler: '采样去噪，生图的核心步骤',
        wsHelpVaeDecode: '把 latent 解码成可见图片',
        wsHelpVaeEncode: '把图片编码成 latent',
        wsHelpControlnet: 'ControlNet 姿态 / 边缘控制',
        wsHelpUpscale: '放大 / 缩放图片',
        wsHelpSave: '保存图片到 output 目录',
        wsHelpPreview: '预览生成的图片',
        wsHelpLoadImage: '加载已有的图片',
        wsHelpKindLoader: '加载模型或资源',
        wsHelpKindClip: '文本编码 / 处理',
        wsHelpKindLatent: '潜变量操作',
        wsHelpKindSampler: '采样 / 去噪',
        wsHelpKindLora: 'LoRA 微调',
        wsHelpKindVae: 'VAE 编解码',
        wsHelpKindOutput: '输出 / 保存',
        wsHelpKindOther: '其他处理节点',
        // 队列条目
        wsQNodes: '{n} 个节点',
        wsQPrompt: '提示词',
        wsQNoPrompt: '（无提示词信息）',
        wsQOpen: '查看它的工作流',
        wsQProgress: '进度',
        wsQQueued: '第 {n} 位',
        wsQUnknown: '未知任务',
        wsQModel: '模型',
        wsLoraAdd: '+ 添加 LoRA',
        wsLoraDel: '删除',
        wsLoraNone: '还没加 LoRA。点上面按钮添加。',
        wsLoraModelStrength: '模型强度',
        wsLoraClipStrength: '文本强度',
        wsLoraPick: '选择 LoRA 文件',
      },
      en: {
        nav: 'ComfyUI Bridge',
        pageHint: 'Nothing is saved until you press Save.',
        features: 'Feature switches',
        featuresNote: 'Off = matching tool call refuses',
        review: 'Review',
        reviewNote: 'Auto-check after generation and regenerate on dissatisfaction',
        reviewEnabled: 'Enable review',
        provider: 'Review model provider',
        providerHint: 'Empty = follow current session',
        model: 'Review model id',
        modelHint: 'Empty = follow current session',
        maxAttempts: 'Max regenerate attempts',
        img2img: 'Image-to-image (img2img)',
        img2imgHint: 'Redraw from an existing image',
        upscale: 'Algorithmic upscale',
        upscaleHint: 'Enlarge an already-generated image',
        output: 'Image output',
        outputNote: 'Copy an extra image here after generating',
        outputDir: 'Output directory',
        outputDirHint: 'Empty = images stay in ComfyUI output',
        outputEmpty: 'Not chosen (images stay in ComfyUI own output)',
        outputClear: 'Clear',
        outputUnsupported: 'No folder picker here; edit output.dir in cordis.patch.yml',
        loraDocs: 'LoRA prompts',
        loraDocsNote: 'On LoRA use, pick one doc by content and merge in',
        loraDocsDir: 'Prompt directory',
        loraDocsHint: 'Mix character/style/tag docs; names need not match; empty = none',
        loraDocsEmpty: 'Not chosen (no prompt documents are read)',
        loraDocsBudget: 'Character budget',
        loraDocsBudgetHint: 'Max chars merged per doc (200–20000); cuts at line break',
        loraDocsFound: '{n} candidate(s) found ({m} look like prompts)',
        loraDocsReadFailed: 'Cannot read this directory',
        pick: 'Pick',
        pickHint: 'Open folder picker',
        picking: 'Waiting…',
        pickFailed: 'Could not open the folder picker',
        choose: 'Pick the review model',
        chooseHint: 'Pick an image-capable model (empty = current session)',
        loading: 'Loading models…',
        emptyModels: 'No image-capable models found',
        loadFailed: 'Failed to load models',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        dirty: 'Unsaved changes',
        auto: 'Follow the current session model',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        readOnly: 'This deployment stores settings read-only.',
        drawBar: 'Draw',
        drawModel: 'Diffusion model',
        drawAuto: 'Auto (default model)',
        drawHint: 'Generation model (checkpoint or diffusion model)',
        drawGroupUnet: 'Diffusion models',
        drawGroupCheckpoint: 'Checkpoints (single-file MODEL/CLIP/VAE)',
        allowLora: 'LoRA allowed (click to turn off)',
        loraBlocked: 'LoRA off: character LoRAs are blocked (click to allow)',
        drawLoadFailed: 'Cannot read the ComfyUI model list',
        // ── Conversation view "ComfyUI" page ──
        viewTab: 'ComfyUI',
        wsWorkflow: 'Workflow',
        wsImages: 'Outputs',
        wsQueue: 'Queue',
        wsRefresh: 'Refresh',
        wsRefreshing: 'Refreshing…',
        wsEmpty: 'No generations yet. Generate one with the drawing tools, or press Refresh.',
        wsOffline: 'ComfyUI is not running ({url}). Start the local ComfyUI, then refresh.',
        wsRunning: 'Running',
        wsPending: 'Pending',
        wsRecent: 'Recently finished',
        wsNoQueue: 'The queue is empty',
        wsParams: 'Editable parameters',
        wsPrompt: 'Positive prompt',
        wsNegative: 'Negative prompt',
        wsWidth: 'Width',
        wsHeight: 'Height',
        wsSteps: 'Steps',
        wsCfg: 'CFG',
        wsSeed: 'Seed',
        wsSampler: 'Sampler',
        wsScheduler: 'Scheduler',
        wsLora: 'LoRA',
        wsResubmit: 'Resubmit with edits',
        wsSubmitting: 'Submitting…',
        wsSubmitted: 'Submitted · prompt_id {id}',
        wsGraph: 'Node graph',
        wsNodeCount: '{n} nodes · {m} links',
        wsEnlarge: 'Enlarge',
        wsClose: 'Close',
        wsFindWorkflow: 'Find workflow',
        wsNoWorkflow: 'No workflow found for this image: {reason}',
        wsSourceIndex: 'From generation index',
        wsSourceHistory: 'From ComfyUI history',
        wsClickImage: 'Click an image to see the exact workflow that made it, then regenerate with edits.',
        wsSelectWorkflow: 'Pick a generation below to view/edit its workflow.',
        wsPickEmpty: 'No generations yet. Run comfy_run in the chat and it shows up here.',
        wsNoGraph: 'This record has no usable workflow graph.',
        wsLoadFailed: 'Cannot load workspace data: {reason}',
        wsLegend: 'Legend',
        wsKindLoader: 'Model loader',
        wsKindClip: 'Text encode',
        wsKindLatent: 'Latent',
        wsKindSampler: 'Sampler',
        wsKindLora: 'LoRA',
        wsKindVae: 'VAE',
        wsKindOutput: 'Output',
        wsKindOther: 'Other',
        wsLegendHint: 'Click to highlight nodes of this kind, click again to clear',
        // What each node does (specific node first, category fallback)
        wsHelpCheckpoint: 'Loads the model (MODEL / CLIP / VAE)',
        wsHelpUnet: 'Loads the diffusion model (MODEL in a triad)',
        wsHelpLora: 'Applies a LoRA fine-tune with strength control',
        wsHelpClip: 'Encodes text into a conditioning prompt',
        wsHelpLatent: 'Creates an empty latent: size and batch',
        wsHelpSampler: 'Denoising sampler — the core generation step',
        wsHelpVaeDecode: 'Decodes the latent into a visible image',
        wsHelpVaeEncode: 'Encodes an image into a latent',
        wsHelpControlnet: 'ControlNet pose / edge guidance',
        wsHelpUpscale: 'Upscales / resizes an image',
        wsHelpSave: 'Saves the image to the output folder',
        wsHelpPreview: 'Previews a generated image',
        wsHelpLoadImage: 'Loads an existing image',
        wsHelpKindLoader: 'Loads a model or resource',
        wsHelpKindClip: 'Text encoding / processing',
        wsHelpKindLatent: 'Latent operations',
        wsHelpKindSampler: 'Sampling / denoising',
        wsHelpKindLora: 'LoRA fine-tune',
        wsHelpKindVae: 'VAE encode / decode',
        wsHelpKindOutput: 'Output / saving',
        wsHelpKindOther: 'Other processing node',
        // Queue entries
        wsQNodes: '{n} nodes',
        wsQPrompt: 'Prompt',
        wsQNoPrompt: '(no prompt info)',
        wsQOpen: 'View its workflow',
        wsQProgress: 'Progress',
        wsQQueued: '#{n} in line',
        wsQUnknown: 'Unknown task',
        wsQModel: 'Model',
        wsLoraAdd: '+ Add LoRA',
        wsLoraDel: 'Remove',
        wsLoraNone: 'No LoRA yet. Click Add above.',
        wsLoraModelStrength: 'Model strength',
        wsLoraClipStrength: 'CLIP strength',
        wsLoraPick: 'Pick a LoRA file',
      },
    }

    const CSS = `
[data-comfy-settings]{--comfy-accent:#3b82f6;--comfy-accent-hover:#3b82f6;display:flex;flex-direction:column;gap:12px;padding:2px 2px 8px;max-width:720px;}
[data-comfy-page-title]{display:flex;flex-direction:column;gap:2px;padding:0 2px 4px;}
[data-comfy-title]{font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary,inherit);}
[data-comfy-sec]{display:flex;flex-direction:column;gap:12px;padding:12px 14px;
  background:var(--dsw-alias-settings-card-fill,transparent);border-radius:var(--dsw-radius-xl,16px);}
[data-comfy-fields]{display:flex;flex-direction:column;gap:12px;}
[data-comfy-switches]{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;}
[data-comfy-switches] [data-comfy-row]{padding:10px 12px;align-items:center;
  border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,transparent);}
[data-comfy-switches] [data-comfy-label]{font-weight:400;}
[data-comfy-sec-head]{display:flex;flex-direction:column;gap:2px;}
[data-comfy-h]{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary,inherit);}
[data-comfy-sub]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-comfy-row]{display:flex;align-items:flex-start;gap:10px;}
[data-comfy-grow]{flex:1;min-width:0;}
[data-comfy-label]{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary,#81858c);}
[data-comfy-note]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);margin-top:2px;}
[data-comfy-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;margin-top:2px;}
[data-comfy-sw][data-on]{background:var(--comfy-accent,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)));}
[data-comfy-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-switch-thumb);transition:left .15s;display:block;}
[data-comfy-sw][data-on] i{left:19px;}
[data-comfy-sw][disabled]{opacity:.4;cursor:default;}
[data-comfy-input]{width:100%;box-sizing:border-box;padding:0 10px;height:32px;border-radius:var(--dsw-radius-md,12px);
  font-size:13px;
  border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3,rgba(128,128,128,.28)));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;}
[data-comfy-input]:focus{outline:none;border-color:var(--comfy-accent);}
[data-comfy-input][disabled]{opacity:.6;cursor:default;}
[data-ws-select]{cursor:pointer;padding-right:6px;}
[data-ws-select] option{background:var(--dsw-alias-bg-layer-0,#1a1a1e);color:var(--dsw-alias-label-primary,inherit);}
[data-ws-lora-editor]{margin-top:12px;padding:10px;border:1px solid var(--dsw-alias-border,rgba(128,128,128,.18));
  border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));}
[data-ws-lora-list]{display:flex;flex-direction:column;gap:10px;margin:8px 0;}
[data-ws-lora-row]{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;align-items:end;
  padding:8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));}
[data-ws-lora-del]{height:32px;min-width:32px;padding:0 8px;font-size:16px;line-height:1;}
[data-ws-lora-add]{margin-top:2px;}
[data-comfy-num]{width:88px;}
[data-comfy-path]{box-sizing:border-box;padding:7px 10px;border-radius:var(--dsw-radius-md,12px);font-size:13px;line-height:18px;
  min-height:32px;word-break:break-all;
  border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3,rgba(128,128,128,.28)));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;}
[data-comfy-path][data-empty]{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-comfy-actions]{display:flex;flex:none;align-items:center;gap:6px;}
[data-comfy-clear]{flex:none;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;
  font-family:inherit;font-size:12px;line-height:18px;border:0;
  background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);transition:background .15s,color .15s;}
@media (hover:hover){[data-comfy-clear]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.12));
  color:var(--dsw-alias-state-error-primary);}}
[data-comfy-clear]:focus-visible{outline:none;
  box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--comfy-accent));}
[data-comfy-clear][disabled]{opacity:.4;cursor:default;}
[data-comfy-pick]{flex:none;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;
  font-family:inherit;font-size:12px;line-height:18px;
  border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));
  background:0 0;color:var(--dsw-alias-label-primary,inherit);transition:background .15s;}
@media (hover:hover){[data-comfy-pick]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));}}
[data-comfy-pick]:focus-visible{outline:none;
  box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--comfy-accent));}
[data-comfy-pick][disabled]{opacity:.4;cursor:default;}
[data-comfy-select]{width:100%;box-sizing:border-box;padding:0 32px 0 10px;height:32px;
  border-radius:var(--dsw-radius-md,12px);font-size:13px;cursor:pointer;appearance:none;
  border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3,rgba(128,128,128,.28)));
  background-color:var(--dsw-alias-bg-layer-1,transparent);
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;
  color:var(--dsw-alias-label-primary,inherit);font-family:inherit;}
[data-comfy-select]:focus{outline:none;border-color:var(--comfy-accent);}
[data-comfy-select][disabled]{opacity:.6;cursor:default;}
[data-comfy-msg]{font-size:12px;line-height:18px;padding:10px 12px;border-radius:var(--dsw-radius-lg,16px);
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-comfy-msg][data-bad]{color:var(--dsw-alias-state-error-primary);
  background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.12));}
[data-comfy-note][data-bad]{color:var(--dsw-alias-state-error-primary);}
[data-comfy-status]{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-comfy-status][data-bad]{color:var(--dsw-alias-state-error-primary);}
[data-comfy-status][data-ok]{color:var(--dsw-alias-state-success-primary);}
[data-comfy-btn]{flex:none;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);border:0;cursor:pointer;
  font-family:inherit;font-size:14px;line-height:22px;
  background:var(--comfy-accent,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)));
  color:var(--dsw-alias-label-primary-foreground);transition:background .15s,opacity .15s;}
@media (hover:hover){[data-comfy-btn]:hover:not([disabled]){background:var(--comfy-accent-hover,var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary)));}}
[data-comfy-btn][disabled]{cursor:default;}
[data-comfy-btn]:focus-visible{outline:none;
  box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--comfy-accent));}
[data-comfy-savebar]{display:flex;align-items:center;gap:10px;padding:0 2px 8px;
  border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16));}
[data-comfy-drawbar]{display:flex;align-items:center;gap:6px;min-width:0;}
[data-comfy-mini]{max-width:190px;box-sizing:border-box;height:26px;padding:0 24px 0 8px;border-radius:var(--dsw-radius-sm,8px);
  font-size:12px;cursor:pointer;appearance:none;
  border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));
  background-color:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.14));
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position:right 8px center;background-repeat:no-repeat;background-size:12px 12px;
  color:var(--dsw-alias-label-primary,inherit);font-family:inherit;}
[data-comfy-mini]:focus{outline:none;border-color:var(--comfy-accent);}
[data-comfy-mini][disabled]{opacity:.6;cursor:default;}
/* 展开的选项列表由浏览器自己画表面色，必须显式给底色与字色 —— 靠继承会在暗色下糊成白字白底 */
[data-comfy-mini] option,
[data-comfy-select] option{background:var(--dsw-alias-bg-layer-1,#353638);
  color:var(--dsw-alias-label-primary,#f9fafb);}
[data-comfy-chip]{flex:none;height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;font-family:inherit;
  font-size:12px;line-height:24px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));
  background:0 0;color:var(--dsw-alias-label-secondary,#9aa0a6);transition:background .15s,color .15s;}
[data-comfy-chip][data-on]{background:var(--comfy-accent,var(--dsw-alias-brand-primary));
  border-color:var(--comfy-accent,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground);}
[data-comfy-chip]:focus-visible{outline:none;
  box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--comfy-accent));}
[data-comfy-chip][disabled]{opacity:.4;cursor:default;}
/* ── k91 会话视图「ComfyUI」页 ── */
[data-comfy-workspace]{--ws-accent:var(--comfy-accent,#3b82f6);display:flex;flex-direction:column;gap:12px;
  height:100%;min-height:320px;box-sizing:border-box;padding:12px 14px 20px;overflow:auto;}
[data-ws-toolbar]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-ws-tabs]{display:flex;gap:6px;flex:1;min-width:0;}
[data-ws-body]{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;}
[data-ws-h]{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary,inherit);}
[data-ws-note]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ws-muted]{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:6px 0;}
[data-ws-workflow]{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;}
[data-ws-left]{display:flex;flex-direction:column;gap:12px;flex:1 1 420px;min-width:0;}
[data-ws-graph-wrap],[data-ws-params]{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:var(--dsw-radius-xl,16px);
  background:var(--dsw-alias-settings-card-fill,transparent);min-width:280px;}
[data-ws-graph-wrap]{flex:none;min-width:0;}
[data-ws-params]{flex:0 1 360px;}
[data-ws-graph-scroll]{overflow:auto;max-width:100%;max-height:480px;border-radius:var(--dsw-radius-md,12px);
  background-color:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));
  background-image:radial-gradient(rgba(128,128,128,.28) .8px,transparent .8px);background-size:18px 18px;}
[data-ws-graph]{position:relative;--ws-node-w:184px;}
[data-ws-edges]{position:absolute;inset:0;pointer-events:none;overflow:visible;}
[data-ws-edges path]{transition:stroke-opacity .15s;}
[data-ws-edges circle]{pointer-events:none;}
[data-ws-node]{position:absolute;box-sizing:border-box;border-radius:var(--dsw-radius-md,10px);
  border:1px solid var(--ws-node-color,rgba(128,128,128,.5));
  background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));
  box-shadow:0 2px 8px rgba(0,0,0,.18);overflow:hidden;}
[data-ws-node-head]{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;line-height:18px;
  padding:4px 8px;color:var(--dsw-alias-label-primary,inherit);
  background-color:var(--ws-node-color,rgba(128,128,128,.5));}
[data-ws-node-head] [data-ws-node-dot]{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.92);flex:none;}
[data-ws-node-head] [data-ws-node-id]{opacity:.75;font-weight:400;font-size:10px;}
[data-ws-node-body]{padding:5px 8px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary,#9aa0a6);word-break:break-all;}
[data-ws-node-help]{font-size:10px;line-height:14px;color:var(--ws-node-color,var(--dsw-alias-label-secondary));
  font-weight:500;padding-bottom:3px;margin-bottom:3px;border-bottom:1px solid rgba(128,128,128,.16);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-ws-node-body] [data-ws-kv]{display:flex;gap:4px;white-space:nowrap;overflow:hidden;}
[data-ws-node-body] [data-ws-k]{color:var(--dsw-alias-label-tertiary,#9aa0a6);flex:none;}
[data-ws-node-body] [data-ws-v]{color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;}
[data-ws-port]{position:absolute;width:9px;height:9px;border-radius:50%;
  border:2px solid var(--dsw-alias-bg-layer-2,rgba(128,128,128,.4));
  background:var(--ws-node-color,rgba(128,128,128,.5));top:50%;transform:translateY(-50%);}
[data-ws-port][data-ws-in]{left:-5px;}
[data-ws-port][data-ws-out]{right:-5px;}
[data-ws-legend]{display:flex;gap:6px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ws-legend-item]{display:inline-flex;align-items:center;gap:4px;cursor:pointer;
  padding:3px 7px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,8px);
  background:transparent;color:inherit;font:inherit;transition:opacity .15s,border-color .15s,background .15s;}
[data-ws-legend-item]:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));}
[data-ws-legend-item][data-ws-hl]{border-color:var(--dsw-alias-accent,currentColor);
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,inherit);}
[data-ws-legend-item][data-ws-dim]{opacity:.4;}
[data-ws-legend i]{width:8px;height:8px;border-radius:50%;display:inline-block;}
[data-ws-node]{transition:opacity .15s,box-shadow .15s;}
[data-ws-node][data-ws-hl]{box-shadow:0 0 0 2px var(--ws-node-color),0 0 16px 2px var(--ws-node-color);z-index:3;}
[data-ws-node][data-ws-dim]{opacity:.22;filter:grayscale(.6);}
[data-ws-edges] path{transition:stroke-opacity .15s,stroke-width .15s;}
[data-ws-grid]{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}
[data-ws-field]{display:flex;flex-direction:column;gap:3px;min-width:0;}
[data-ws-field][data-ws-wide]{grid-column:1/-1;}
[data-ws-label]{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-ws-textarea]{height:auto;min-height:56px;padding:6px 10px;resize:vertical;font-family:inherit;}
[data-ws-picker]{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:var(--dsw-radius-xl,16px);
  background:var(--dsw-alias-settings-card-fill,transparent);flex:none;}
[data-ws-pick-list]{display:flex;flex-direction:column;gap:4px;overflow-y:auto;max-height:150px;}
[data-ws-pick-row]{display:flex;gap:10px;align-items:center;text-align:left;cursor:pointer;
  padding:6px 8px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));color:inherit;font:inherit;
  transition:background .12s,border-color .12s;}
[data-ws-pick-row]:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));}
[data-ws-pick-row][data-on]{border-color:var(--dsw-alias-accent,currentColor);
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.14));}
[data-ws-pick-thumb]{width:36px;height:36px;flex:none;object-fit:cover;border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));display:flex;align-items:center;
  justify-content:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ws-pick-main]{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}
[data-ws-pick-title]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;}
[data-ws-pick-id]{font-family:var(--dsw-font-mono,monospace);font-size:11px;
  color:var(--dsw-alias-label-secondary,inherit);}
[data-ws-pick-prompt]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-ws-gallery]{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;}
[data-ws-thumb]{display:flex;flex-direction:column;gap:4px;border-radius:var(--dsw-radius-md,12px);overflow:hidden;
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));}
[data-ws-img]{width:100%;height:140px;object-fit:cover;cursor:zoom-in;display:block;background:rgba(128,128,128,.1);}
[data-ws-thumb-bar]{display:flex;align-items:center;gap:6px;padding:4px 6px;}
[data-ws-thumb-name]{flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ws-queue]{display:flex;flex-direction:column;gap:14px;}
[data-ws-queue-sec]{display:flex;flex-direction:column;gap:6px;}
[data-ws-queue-list]{display:flex;flex-direction:column;gap:4px;}
[data-ws-queue-item]{display:flex;align-items:center;gap:10px;font-size:12px;line-height:18px;padding:6px 8px;
  border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));
  color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-ws-queue-thumb]{width:40px;height:40px;flex:none;object-fit:cover;border-radius:var(--dsw-radius-sm,6px);
  cursor:zoom-in;background:rgba(128,128,128,.14);}
[data-ws-queue-noimg]{width:40px;height:40px;flex:none;display:flex;align-items:center;justify-content:center;
  border-radius:var(--dsw-radius-sm,6px);background:rgba(128,128,128,.12);
  color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:14px;}
[data-ws-queue-main]{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
[data-ws-queue-title]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
[data-ws-queue-id]{font-family:ui-monospace,monospace;color:var(--dsw-alias-label-primary,inherit);}
[data-ws-queue-num]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ws-queue-tag]{font-size:10px;padding:1px 6px;border-radius:999px;
  background:rgba(128,128,128,.16);color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-ws-queue-prompt]{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-ws-queue-acts]{flex:none;display:flex;gap:6px;}
[data-ws-lightbox]{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.72);padding:24px;}
[data-ws-lightbox-inner]{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:100%;max-height:100%;overflow:auto;}
[data-ws-lightbox-inner img]{display:block;flex:0 0 auto;width:auto;height:auto;max-width:100%;max-height:calc(100vh - 120px);object-fit:contain;border-radius:var(--dsw-radius-md,12px);}
[data-ws-lightbox-bar]{display:flex;align-items:center;gap:8px;color:rgb(249,250,251);font-size:12px;}
[data-ws-lightbox-bar span]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
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

    function TextRow({ label, note, value, onChange, disabled, numeric, min, max }) {
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
          // 夹取范围由调用方给（maxAttempts 是 1–5，字数预算是 200–20000）
          onChange(numeric ? Math.max(min ?? 1, Math.min(max ?? 5, Math.round(v))) : v)
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

    /*
     * 桌面端（Electron）的页面来源是 dsh-app://app/，相对 /api 的请求在那里解析不到宿主，
     * 所以要走 preload 装的 __DSH_TRANSPORT__.fetch —— 它收「文档相对」的路径，自己
     * 解析到宿主的 origin。浏览器里没有这个钩子，就用页面自己的 fetch。
     */
    function hostFetch(route, init) {
      const transport = globalThis.__DSH_TRANSPORT__
      if (typeof transport?.fetch === 'function') {
        // 出厂写法是把钩子取出来当裸函数调（`const send = transport?.fetch`），
        // 这里保持一样：不绑 this，也别传 /api/... 全路径。
        const send = transport.fetch
        return send(route.replace(/^\/+/, ''), init)
      }
      if (typeof globalThis.fetch !== 'function') throw new Error('这个页面没有可用的 fetch')
      return globalThis.fetch(route, init)
    }

    /* 桌面端 preload 的原生目录选择桥；有它就不必让宿主去 spawn PowerShell */
    function desktopPicker() {
      const bridge = globalThis.__DSH_DIRECTORY_PICKER__
      return typeof bridge?.pick === 'function' ? bridge : undefined
    }

    /* 宿主侧的路由：列出能看图的模型（浏览器半端没有 llm 服务） */
    const VISION_API = '/api/comfyui/vision-models'
    /* 宿主侧的路由：列出 ComfyUI 里有哪些模型（浏览器半端没有 comfy 客户端） */
    const DRAW_API = '/api/comfyui/draw-models'
    /* 宿主侧的路由：弹系统文件夹选择框（浏览器没有原生选目录能力） */
    const PICK_API = '/api/comfyui/pick-directory'
    /* 宿主侧的路由：LoRA 提示词目录里识别到几篇文档 */
    const LORA_DOCS_API = '/api/comfyui/lora-docs'

    // ── k91 会话视图「ComfyUI」页的数据路由 ──────────────────────────────
    const WORKSPACE_API = {
      snapshot: '/api/comfyui/workspace/snapshot',
      workflow: '/api/comfyui/workspace/workflow',
      image: '/api/comfyui/workspace/image',
      submit: '/api/comfyui/workspace/submit',
    }
    // ComfyUI 未启动 / 取不到 object_info 时的兜底枚举（和 KSampler 默认一致）
    const FALLBACK_SAMPLERS = ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'ddim', 'uni_pc']
    const FALLBACK_SCHEDULERS = ['simple', 'normal', 'exponential', 'sgm_uniform', 'karras', 'ddim_uniform', 'beta']

    /**
     * 让宿主弹一个原生文件夹选择框，返回用户挑的路径。
     * 取消 / 平台不支持都返回 ''（调用方什么都不改）。
     *
     * 桌面端优先用 preload 的原生桥（Electron 自己弹框，取消就是 null）；
     * 浏览器端没有这个桥，改走宿主的 POST 路由（宿主 spawn PowerShell）。
     */
    async function pickFolder(initial) {
      const bridge = desktopPicker()
      if (bridge) {
        let picked
        try {
          picked = await bridge.pick()
        } catch (error) {
          const failure = new Error(error?.message ?? String(error))
          failure.reason = 'failed'
          throw failure
        }
        return typeof picked === 'string' ? picked : ''
      }
      const res = await hostFetch(PICK_API, {
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

    /**
     * 问宿主：LoRA 提示词目录里识别到几篇候选、其中几篇像提示词。
     * 只用来在设置页显示「已识别 N 篇候选（M 篇像提示词）」，读失败不阻塞表单。
     */
    async function loadLoraDocs(dir) {
      const res = await hostFetch(LORA_DOCS_API, { credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!body || body.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
      return {
        dir: String(body.dir ?? dir ?? ''),
        count: Number(body.count ?? 0),
        promptish: Number(body.promptish ?? 0),
        docs: Array.isArray(body.docs) ? body.docs : [],
      }
    }

    async function loadVisionModels() {
      const res = await hostFetch(VISION_API, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error(body?.error || 'unknown error')
      return Array.isArray(body.providers) ? body.providers : []
    }

    async function loadDrawModels() {
      let res
      try {
        res = await hostFetch(DRAW_API, { credentials: 'same-origin' })
      } catch (error) {
        throw new Error(error?.message ?? String(error))
      }
      let body = null
      try { body = await res.json() } catch { body = null }
      if (!res.ok || !body || body.ok !== true) {
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const folders = body.folders || {}
      const unets = Array.isArray(folders.diffusion_models) ? folders.diffusion_models : []
      const checkpoints = Array.isArray(folders.checkpoints) ? folders.checkpoints : []
      return {
        unets,
        checkpoints,
        names: [...unets, ...checkpoints],
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
      ['img2img', 'enabled'],
      ['upscale', 'enabled'],
      ['output', 'dir'],
      ['loraDocs', 'dir'],
      ['loraDocs', 'maxChars'],
    ]

    /* 数字字段清空时的回退值：宿主对越界值是硬拒绝，回退必须落在 schema 的 min/max 之内 */
    const NUM_FALLBACK = { 'review.maxAttempts': 1, 'loraDocs.maxChars': 4000 }

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
      // LoRA 提示词目录：另一个选择按钮 + 「识别到几篇」的反馈
      const [docsPicking, setDocsPicking] = React.useState(false)
      const [docsPickError, setDocsPickError] = React.useState('')
      const [docsInfo, setDocsInfo] = React.useState({ status: 'idle', count: 0, promptish: 0, error: '' })
      const timer = React.useRef(null)
      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

      // 下面两个 effect 必须在任何 return 之前 —— hooks 顺序不能随渲染分支变化
      const docsDir = draft && Object.prototype.hasOwnProperty.call(draft, 'loraDocs.dir')
        ? draft['loraDocs.dir']
        : (snap?.value?.loraDocs?.dir ?? '')

      /* 问宿主「这个目录里识别到几篇候选、其中几篇像提示词」；路径空就清空状态，不发请求 */
      const refreshLoraDocs = (dir) => {
        if (typeof dir !== 'string' || dir.length === 0) {
          setDocsInfo({ status: 'idle', count: 0, promptish: 0, error: '' })
          return
        }
        setDocsInfo((prev) => ({ ...prev, status: 'loading' }))
        loadLoraDocs(dir).then(
          (info) => setDocsInfo({ status: 'ready', count: info.count, promptish: info.promptish, error: '' }),
          (err) => setDocsInfo({ status: 'error', count: 0, promptish: 0, error: err?.message ?? String(err) }),
        )
      }
      // 路径一变（选目录 / 清除 / 保存成功后的快照）就重新数一遍
      React.useEffect(() => {
        refreshLoraDocs(docsDir)
      }, [docsDir, status === 'saved' ? 'saved' : ''])

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
        },
        img2img: { enabled: pick('img2img', 'enabled') === true },
        upscale: { enabled: pick('upscale', 'enabled') === true },
        output: { dir: pick('output', 'dir') ?? '' },
        loraDocs: { dir: pick('loraDocs', 'dir') ?? '', maxChars: pick('loraDocs', 'maxChars') ?? 4000 },
      }

      const ops = []
      for (const [head, leaf] of EDITABLE) {
        const next = pick(head, leaf)
        const prev = readPath(snapValue, head, leaf)
        if (next === prev) continue
        let value = next
        if (value === undefined || value === null) {
          const fallback = NUM_FALLBACK[`${head}.${leaf}`]
          value = typeof prev === 'boolean' ? false : (typeof prev === 'number' ? (fallback ?? 1) : '')
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

      /* LoRA 提示词目录：同样只给「选择」，选完立刻问宿主「识别到几篇」 */
      const chooseLoraDocsDir = () => {
        if (disabled || docsPicking) return
        setDocsPicking(true)
        setDocsPickError('')
        pickFolder(view.loraDocs.dir).then(
          (picked) => {
            setDocsPicking(false)
            if (typeof picked === 'string' && picked.length > 0) set('loraDocs', 'dir', picked)
          },
          (err) => {
            setDocsPicking(false)
            setDocsPickError(err?.reason === 'unsupported' ? t('outputUnsupported') : (err?.message || t('pickFailed')))
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
              : ''

      return h('div', { 'data-comfy-settings': '' },
        h('div', { 'data-comfy-page-title': '' },
          h('div', { 'data-comfy-title': '' }, t('nav')),
          h('div', { 'data-comfy-sub': '' }, t('pageHint'))),

        /* 保存（攒够一批再一次写回；对话栏那两个选项不走这里）——固定在页首，不随下面的卡片滚动 */
        h('div', { 'data-comfy-savebar': '' },
          h('button', {
            'data-comfy-btn': '',
            type: 'button',
            disabled: Boolean(disabled) || status === 'saving' || ops.length === 0,
            onClick: save,
          }, status === 'saving' ? t('saving') : t('save')),
          h('div', {
            'data-comfy-status': '',
            'data-bad': status === 'error' ? '' : undefined,
            'data-ok': status === 'saved' ? '' : undefined,
          }, noteText)),

        disabled ? h('div', { 'data-comfy-msg': '' }, t('readOnly')) : null,

        /* 审图 */
        h('div', { 'data-comfy-sec': '' },
          h('div', { 'data-comfy-sec-head': '' },
            h('div', { 'data-comfy-h': '' }, t('review')),
            h('div', { 'data-comfy-sub': '' }, t('reviewNote'))),
          h('div', { 'data-comfy-fields': '' },
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
            }))),

        /* 功能开关：图生图 / 放大 */
        h('div', { 'data-comfy-sec': '' },
          h('div', { 'data-comfy-sec-head': '' },
            h('div', { 'data-comfy-h': '' }, t('features')),
            h('div', { 'data-comfy-sub': '' }, t('featuresNote'))),
          h('div', { 'data-comfy-switches': '' },
            h(ToggleRow, {
              label: t('img2img'), note: t('img2imgHint'),
              on: view.img2img.enabled, disabled,
              onChange: (v) => set('img2img', 'enabled', v),
            }),
            h(ToggleRow, {
              label: t('upscale'), note: t('upscaleHint'),
              on: view.upscale.enabled, disabled,
              onChange: (v) => set('upscale', 'enabled', v),
            }))),

        /* 图片输出：只能靠「选择」按钮挑，不再提供手填框 */
        h('div', { 'data-comfy-sec': '' },
          h('div', { 'data-comfy-sec-head': '' },
            h('div', { 'data-comfy-h': '' }, t('output')),
            h('div', { 'data-comfy-sub': '' }, t('outputNote'))),
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

        /* LoRA 提示词：目录里混放什么都行，挂 LoRA 出图时按内容挑一篇并进 prompt */
        h('div', { 'data-comfy-sec': '', 'data-comfy-lora-docs': '' },
          h('div', { 'data-comfy-sec-head': '' },
            h('div', { 'data-comfy-h': '' }, t('loraDocs')),
            h('div', { 'data-comfy-sub': '' }, t('loraDocsNote'))),
          h('div', { 'data-comfy-row': '' },
            h('div', { 'data-comfy-grow': '' },
              h('div', { 'data-comfy-label': '' }, t('loraDocsDir')),
              h('div', { 'data-comfy-note': '' }, t('loraDocsHint')),
              h('div', {
                'data-comfy-path': '',
                'data-empty': view.loraDocs.dir ? undefined : '',
                title: view.loraDocs.dir || undefined,
              }, view.loraDocs.dir || t('loraDocsEmpty'))),
            h('div', { 'data-comfy-actions': '' },
              h('button', {
                'data-comfy-pick': '',
                type: 'button',
                disabled: Boolean(disabled) || docsPicking,
                title: t('pickHint'),
                onClick: chooseLoraDocsDir,
              }, docsPicking ? t('picking') : t('pick')),
              view.loraDocs.dir
                ? h('button', {
                  'data-comfy-clear': '',
                  type: 'button',
                  disabled: Boolean(disabled) || docsPicking,
                  onClick: () => { setDocsPickError(''); set('loraDocs', 'dir', '') },
                }, t('outputClear'))
                : null)),
          // 字数上限：文档太长时决定喂多少，配小了会砍内容，配大了可能串味
          h('div', { 'data-comfy-row': '', 'data-comfy-budget': '' },
            h(TextRow, {
              label: t('loraDocsBudget'),
              note: t('loraDocsBudgetHint'),
              numeric: true,
              min: 200,
              max: 20000,
              value: view.loraDocs.maxChars,
              disabled,
              onChange: (v) => set('loraDocs', 'maxChars', v),
            })),
          // 路径下面立刻反馈「识别到几篇候选、其中几篇像提示词」，选错目录能当场看出来
          docsInfo.status === 'error'
            ? h('div', { 'data-comfy-note': '', 'data-bad': '' }, `${t('loraDocsReadFailed')}：${docsInfo.error}`)
            : docsInfo.status === 'ready'
              ? h('div', { 'data-comfy-note': '', 'data-comfy-doc-count': String(docsInfo.count) },
                t('loraDocsFound')
                  .replace('{n}', String(docsInfo.count))
                  .replace('{m}', String(docsInfo.promptish)))
              : docsInfo.status === 'loading'
                ? h('div', { 'data-comfy-note': '' }, t('loading'))
                : null,
          docsPickError
            ? h('div', { 'data-comfy-note': '', 'data-bad': '' }, docsPickError)
            : null),
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
      const [models, setModels] = React.useState({ status: 'loading', names: [], unets: [], checkpoints: [], error: '' })
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
          (next) => {
            if (alive.current) setModels({ status: 'ready', names: next.names, unets: next.unets, checkpoints: next.checkpoints, error: '' })
          },
          (error) => {
            if (alive.current) setModels({ status: 'error', names: [], unets: [], checkpoints: [], error: error?.message ?? String(error) })
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

      const total = models.unets.length + models.checkpoints.length
      const note = models.status === 'error'
        ? `${t('drawLoadFailed')}：${models.error}`
        : models.status === 'loading'
          ? t('loading')
          : `${t('drawHint')}${total > 0 ? `（${total}）` : ''}`
      const stale = unet !== '' && !models.names.includes(unet)
      // 整合包（checkpoints）和三件套分两组列，选中的名字自己说明用哪种加载器
      const groups = []
      if (models.unets.length > 0) {
        groups.push(h('optgroup', { key: 'unet', label: t('drawGroupUnet') },
          models.unets.map((name) => h('option', { key: name, value: name }, name))))
      }
      if (models.checkpoints.length > 0) {
        groups.push(h('optgroup', { key: 'ckpt', label: t('drawGroupCheckpoint') },
          models.checkpoints.map((name) => h('option', { key: name, value: name }, name))))
      }

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
          groups),
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

    // ════════════════════════════════════════════════════════════════════════
    // k91 会话视图「ComfyUI」页
    // ════════════════════════════════════════════════════════════════════════

    /** 不依赖宿主 locale 是否支持插值：自己做 {key} 替换 */
    function interp(text, vars) {
      return String(text ?? '').replace(/\{(\w+)\}/g, (_m, k) => (vars && k in vars ? String(vars[k]) : ''))
    }

    /** 把搜索参数安全拼到图片代理路由上 */
    function imageUrl(image) {
      const q = new URLSearchParams()
      q.set('filename', String(image?.filename ?? ''))
      if (image?.subfolder) q.set('subfolder', String(image.subfolder))
      if (image?.type) q.set('type', String(image.type))
      return `${WORKSPACE_API.image}?${q.toString()}`
    }

    /** 节点类别 → 配色 / 图例键。顺序即匹配优先级。 */
    const WS_KINDS = [
      { id: 'lora', label: 'wsKindLora', color: '#c084fc', test: /lora/i },
      { id: 'loader', label: 'wsKindLoader', color: '#60a5fa', test: /loader|checkpoint|unet|load/i },
      { id: 'clip', label: 'wsKindClip', color: '#34d399', test: /clip|textencode|encode/i },
      { id: 'latent', label: 'wsKindLatent', color: '#fbbf24', test: /latent|noise/i },
      { id: 'sampler', label: 'wsKindSampler', color: '#f87171', test: /sampler|sample/i },
      { id: 'vae', label: 'wsKindVae', color: '#22d3ee', test: /vae/i },
      { id: 'output', label: 'wsKindOutput', color: '#a3e635', test: /saveimage|previewimage|output/i },
    ]
    const WS_OTHER = { id: 'other', label: 'wsKindOther', color: '#94a3b8' }
    const kindOf = (classType) => WS_KINDS.find((k) => k.test.test(classType || '')) ?? WS_OTHER

    /** 具体节点 → 用途说明的文案键；未命中则按类别兜底。 */
    const WS_NODE_HELP = [
      { test: /checkpointloader/i, key: 'wsHelpCheckpoint' },
      { test: /unetloader/i, key: 'wsHelpUnet' },
      { test: /loraloader/i, key: 'wsHelpLora' },
      { test: /textencode|cliptext/i, key: 'wsHelpClip' },
      { test: /emptylatent|latentimage/i, key: 'wsHelpLatent' },
      { test: /vaedecode/i, key: 'wsHelpVaeDecode' },
      { test: /vaeencode/i, key: 'wsHelpVaeEncode' },
      { test: /controlnet/i, key: 'wsHelpControlnet' },
      { test: /upscale|imagescale/i, key: 'wsHelpUpscale' },
      { test: /saveimage|save/i, key: 'wsHelpSave' },
      { test: /previewimage|preview/i, key: 'wsHelpPreview' },
      { test: /loadimage/i, key: 'wsHelpLoadImage' },
    ]
    const KIND_HELP = {
      loader: 'wsHelpKindLoader', clip: 'wsHelpKindClip', latent: 'wsHelpKindLatent',
      sampler: 'wsHelpKindSampler', lora: 'wsHelpKindLora', vae: 'wsHelpKindVae',
      output: 'wsHelpKindOutput', other: 'wsHelpKindOther',
    }
    const helpOf = (classType, t) => {
      const specific = WS_NODE_HELP.find((h) => h.test.test(classType || ''))
      const key = specific?.key ?? KIND_HELP[kindOf(classType).id]
      return key ? t(key) : ''
    }

    /**
     * 从 API 图建分层 DAG 布局：无入边的节点排最左，依赖它的依次往右；
     * 同层节点竖排。这样提示词 → 潜变量 → 采样器 → 输出的流向一眼可见。
     */
    function buildGraphLayout(graph) {
      const ids = Object.keys(graph ?? {})
      const idSet = new Set(ids)
      const preds = new Map(ids.map((id) => [id, []]))
      const links = []
      for (const id of ids) {
        const inputs = graph[id]?.inputs ?? {}
        for (const [name, value] of Object.entries(inputs)) {
          if (!Array.isArray(value) || typeof value[0] !== 'string' || !idSet.has(value[0]) || value[0] === id) continue
          preds.get(id).push(value[0])
          links.push({ from: value[0], to: id, input: name, slot: value[1] })
        }
      }
      // layer = max(所有前驱 layer) + 1；visiting 防止异常环导致死循环
      const layer = new Map(ids.map((id) => [id, 0]))
      const visiting = new Set()
      const layerOf = (id) => {
        if (visiting.has(id)) return 0
        visiting.add(id)
        let lv = 0
        for (const p of preds.get(id) ?? []) lv = Math.max(lv, layerOf(p) + 1)
        visiting.delete(id)
        return lv
      }
      for (const id of ids) layer.set(id, layerOf(id))
      const byLayer = new Map()
      for (const id of ids) {
        const lv = layer.get(id)
        if (!byLayer.has(lv)) byLayer.set(lv, [])
        byLayer.get(lv).push(id)
      }
      const cols = [...byLayer.keys()].sort((a, b) => a - b)
      const pos = new Map()
      cols.forEach((lv, col) => {
        byLayer.get(lv).sort().forEach((id, row) => pos.set(id, { col, row }))
      })
      const maxRows = Math.max(1, ...[...byLayer.values()].map((a) => a.length))
      return { ids, pos, links, cols, maxRows }
    }

    /** 节点图：分层布局 + 类别配色 + 箭头连线 + 输入/输出端口，零外部依赖。 */
    function GraphCanvas({ graph, t, highlight }) {
      const { ids, pos, links, maxRows } = React.useMemo(() => buildGraphLayout(graph), [graph])
      const nodeW = 184
      const colGap = 92
      const rowGap = 14
      const headH = 20
      const cellW = nodeW + colGap
      const cellH = 96 + rowGap
      const maxCol = Math.max(0, ...ids.map((id) => pos.get(id)?.col ?? 0))
      const width = (maxCol + 1) * cellW + 12
      const height = maxRows * cellH + 12
      // 端口锚点在节点标题行中心，连线贴着端口走
      const anchor = (id, out) => {
        const p = pos.get(id) ?? { col: 0, row: 0 }
        return { x: p.col * cellW + (out ? nodeW : 0), y: p.row * cellH + headH / 2 + 4 }
      }
      const kinds = [...new Set([...WS_KINDS, WS_OTHER])]
      return h('div', { 'data-ws-graph': '', style: { width, height } },
        h('svg', { width, height, 'data-ws-edges': '' },
          h('defs', null, ...kinds.map((k) =>
            h('marker', {
              key: k.id, id: `ws-arrow-${k.id}`, viewBox: '0 0 8 8',
              refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
            }, h('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: k.color })))),
          ...links.map((link, i) => {
            const a = anchor(link.from, true)
            const b = anchor(link.to, false)
            const mx = a.x + (b.x - a.x) * 0.5
            const kind = kindOf(graph[link.from]?.class_type)
            return h('path', {
              key: i,
              d: `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`,
              fill: 'none',
              stroke: kind.color,
              'stroke-width': highlight && highlight === kind.id ? 2.6 : 1.6,
              'stroke-opacity': highlight && highlight !== kind.id ? 0.15 : 0.85,
              'data-ws-dim': highlight && highlight !== kind.id ? '' : undefined,
              'marker-end': `url(#ws-arrow-${kind.id})`,
            })
          })),
        ...ids.map((id) => {
          const node = graph[id]
          const p = pos.get(id)
          const inputs = node?.inputs ?? {}
          const kind = kindOf(node?.class_type)
          const help = helpOf(node?.class_type, t)
          const kvs = Object.entries(inputs)
            .filter(([, v]) => !Array.isArray(v) || typeof v[0] !== 'string')
            .slice(0, 3)
            .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
          return h('div', {
            key: id,
            'data-ws-node': '',
            'data-ws-kind': kind.id,
            'data-ws-hl': highlight === kind.id ? '' : undefined,
            'data-ws-dim': highlight && highlight !== kind.id ? '' : undefined,
            title: `${node?.class_type ?? '?'} — ${help}`,
            style: { left: p.col * cellW, top: p.row * cellH, width: nodeW, '--ws-node-color': kind.color },
          },
            h('div', { 'data-ws-node-head': '', title: node?.class_type ?? '' },
              h('i', { 'data-ws-node-dot': '' }),
              h('span', null, node?.class_type ?? '?'),
              h('span', { 'data-ws-node-id': '' }, `#${id}`)),
            h('div', { 'data-ws-node-body': '' },
              help ? h('div', { 'data-ws-node-help': '', title: help }, help) : null,
              ...(kvs.length ? kvs : []).map(([k, v]) =>
                h('div', { 'data-ws-kv': '' },
                  h('span', { 'data-ws-k': '' }, k),
                  h('span', { 'data-ws-v': '', title: v }, v)))),
            h('span', { 'data-ws-port': '', 'data-ws-in': '' }),
            h('span', { 'data-ws-port': '', 'data-ws-out': '' }))
        }))
    }

    /** 图例：只显示这张图里实际出现的类别；点击高亮/取消该类节点。 */
    function GraphLegend({ graph, t, highlight, onHighlight }) {
      const present = new Set(Object.values(graph ?? {}).map((n) => kindOf(n?.class_type).id))
      return h('div', { 'data-ws-legend': '', title: t('wsLegendHint') },
        [...WS_KINDS, WS_OTHER].filter((k) => present.has(k.id)).map((k) =>
          h('button', {
            key: k.id,
            type: 'button',
            'data-ws-legend-item': '',
            'data-ws-hl': highlight === k.id ? '' : undefined,
            'data-ws-dim': highlight && highlight !== k.id ? '' : undefined,
            onClick: () => onHighlight?.(highlight === k.id ? null : k.id),
          },
            h('i', { style: { background: k.color } }),
            t(k.label))))
    }

    /** 参数编辑器：改完点「改参重提交」，POST 给宿主写回图并排队。 */
    function ParamEditor({ record, t, onSubmit, submitting, samplers, schedulers, loras }) {
      const initial = record?.params ?? {}
      // 下拉选项：优先用后端给的 object_info 枚举，空/离线时用内置兜底；
      // 当前工作流用的值若不在列表里（冷门采样器），补进去以免选中丢失。
      const withCurrent = (list, current) => {
        const out = Array.isArray(list) && list.length ? [...list] : []
        if (current && !out.includes(current)) out.unshift(current)
        return out.length ? out : [current || '']
      }
      const samplerOptions = withCurrent(samplers, initial.sampler || 'euler')
      const schedulerOptions = withCurrent(schedulers, initial.scheduler || 'simple')
      const loraOptions = Array.isArray(loras) ? loras : []
      // 把 record 里的 LoRA 变成可编辑列表（保留 id / 强度）
      const loraListOf = (p) => (Array.isArray(p?.lora) ? p.lora : []).map((l) => ({
        id: l?.id ?? '',
        name: l?.name ?? '',
        strengthModel: l?.strengthModel ?? 1,
        strengthClip: l?.strengthClip ?? 1,
      }))
      const [draft, setDraft] = React.useState({
        prompt: initial.prompt ?? '',
        negative: initial.negative ?? '',
        width: initial.width > 0 ? initial.width : 1024,
        height: initial.height > 0 ? initial.height : 1024,
        steps: initial.steps > 0 ? initial.steps : 30,
        cfg: initial.cfg ?? 4.9,
        seed: initial.seed ?? 0,
        sampler: initial.sampler ?? 'euler',
        scheduler: initial.scheduler ?? 'simple',
        loraList: loraListOf(initial),
      })
      React.useEffect(() => {
        const p = record?.params ?? {}
        setDraft({
          prompt: p.prompt ?? '', negative: p.negative ?? '',
          width: p.width > 0 ? p.width : 1024, height: p.height > 0 ? p.height : 1024,
          steps: p.steps > 0 ? p.steps : 30, cfg: p.cfg > 0 ? p.cfg : 4.9, seed: p.seed ?? 0,
          sampler: p.sampler ?? 'euler', scheduler: p.scheduler ?? 'simple',
          loraList: loraListOf(p),
        })
      }, [record])

      const field = (key, label, opts = {}) => h('label', { 'data-ws-field': '' },
        h('span', { 'data-ws-label': '' }, label),
        opts.options
          ? h('select', {
              'data-comfy-input': '', 'data-ws-select': '',
              value: draft[key] ?? '',
              onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.value })),
            }, ...opts.options.map((v) => h('option', { key: v, value: v }, v)))
          : h('input', {
              'data-comfy-input': '',
              type: opts.numeric ? 'number' : 'text',
              value: draft[key] ?? '',
              onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.value })),
            }))

      const setLora = (index, patch) => setDraft((d) => ({
        ...d, loraList: d.loraList.map((it, i) => (i === index ? { ...it, ...patch } : it)),
      }))
      const addLora = () => setDraft((d) => ({
        ...d,
        loraList: [...d.loraList, {
          id: '', name: loraOptions[0] ?? '', strengthModel: 1, strengthClip: 1,
        }],
      }))
      const delLora = (index) => setDraft((d) => ({
        ...d, loraList: d.loraList.filter((_, i) => i !== index),
      }))
      // 新增的 LoRA 没 id；已有 LoRA 下拉里没有它的名字时补进去，避免选中丢失
      const loraOptionsFor = (value) => value && !loraOptions.includes(value) ? [value, ...loraOptions] : loraOptions

      const loraEditor = h('div', { 'data-ws-lora-editor': '' },
        h('div', { 'data-ws-h': '' }, t('wsLora')),
        (draft.loraList ?? []).length === 0
          ? h('div', { 'data-ws-muted': '' }, t('wsLoraNone'))
          : h('div', { 'data-ws-lora-list': '' }, ...(draft.loraList ?? []).map((item, i) =>
            h('div', { key: i, 'data-ws-lora-row': '' },
              h('label', { 'data-ws-field': '', 'data-ws-wide': '' },
                h('span', { 'data-ws-label': '' }, `${t('wsLora')} ${i + 1}`),
                h('select', {
                  'data-comfy-input': '', 'data-ws-select': '',
                  value: item.name ?? '',
                  onChange: (e) => setLora(i, { name: e.target.value }),
                },
                  h('option', { value: '' }, t('wsLoraPick')),
                  ...loraOptionsFor(item.name).map((v) => h('option', { key: v, value: v }, v)))),
              h('label', { 'data-ws-field': '' },
                h('span', { 'data-ws-label': '' }, t('wsLoraModelStrength')),
                h('input', {
                  'data-comfy-input': '', type: 'number', step: '0.05', min: '0', max: '2',
                  value: item.strengthModel ?? 1,
                  onChange: (e) => setLora(i, { strengthModel: e.target.value }),
                })),
              h('label', { 'data-ws-field': '' },
                h('span', { 'data-ws-label': '' }, t('wsLoraClipStrength')),
                h('input', {
                  'data-comfy-input': '', type: 'number', step: '0.05', min: '0', max: '2',
                  value: item.strengthClip ?? 1,
                  onChange: (e) => setLora(i, { strengthClip: e.target.value }),
                })),
              h('button', {
                'data-comfy-chip': '', type: 'button', title: t('wsLoraDel'),
                'data-ws-lora-del': '',
                onClick: () => delLora(i),
              }, '×')))),
        h('button', {
          'data-comfy-chip': '', type: 'button', 'data-ws-lora-add': '',
          onClick: addLora,
        }, t('wsLoraAdd')))

      return h('div', { 'data-ws-params': '' },
        h('div', { 'data-ws-h': '' }, t('wsParams')),
        h('label', { 'data-ws-field': '', 'data-ws-wide': '' },
          h('span', { 'data-ws-label': '' }, t('wsPrompt')),
          h('textarea', {
            'data-comfy-input': '',
            'data-ws-textarea': '',
            rows: 3,
            value: draft.prompt,
            onChange: (e) => setDraft((d) => ({ ...d, prompt: e.target.value })),
          })),
        h('label', { 'data-ws-field': '', 'data-ws-wide': '' },
          h('span', { 'data-ws-label': '' }, t('wsNegative')),
          h('textarea', {
            'data-comfy-input': '',
            'data-ws-textarea': '',
            rows: 2,
            value: draft.negative,
            onChange: (e) => setDraft((d) => ({ ...d, negative: e.target.value })),
          })),
        h('div', { 'data-ws-grid': '' },
          field('width', t('wsWidth'), { numeric: true }),
          field('height', t('wsHeight'), { numeric: true }),
          field('steps', t('wsSteps'), { numeric: true }),
          field('cfg', t('wsCfg'), { numeric: true }),
          field('seed', t('wsSeed'), { numeric: true }),
          field('sampler', t('wsSampler'), { options: samplerOptions }),
          field('scheduler', t('wsScheduler'), { options: schedulerOptions })),
        loraEditor,
        h('button', {
          'data-comfy-btn': '', type: 'button',
          disabled: submitting || !record?.graph,
          onClick: () => onSubmit({
            graph: record.graph,
            params: {
              ...draft,
              width: Number(draft.width), height: Number(draft.height),
              steps: Number(draft.steps), cfg: Number(draft.cfg), seed: Number(draft.seed),
              lora: (draft.loraList ?? []).map((it) => ({
                id: it.id, name: it.name,
                strengthModel: Number(it.strengthModel), strengthClip: Number(it.strengthClip),
              })),
            },
            title: record.title ?? '',
          }),
        }, submitting ? t('wsSubmitting') : t('wsResubmit')))
    }

    /** 图库：缩略图 + 点击放大 + 「反查工作流」。 */
    function ImageGallery({ generated, t, onFind, onEnlarge }) {
      const images = []
      for (const rec of generated ?? []) {
        for (const f of rec.files ?? []) {
          images.push({ ...f, promptId: rec.promptId, createdAt: rec.createdAt, title: rec.title })
        }
      }
      if (images.length === 0) return h('div', { 'data-comfy-msg': '' }, t('wsEmpty'))
      return h('div', { 'data-ws-gallery': '' },
        ...images.map((img, i) => h('div', { key: `${img.promptId}-${i}`, 'data-ws-thumb': '' },
          h('img', {
            src: imageUrl(img), alt: img.filename, loading: 'lazy',
            'data-ws-img': '', onClick: () => onEnlarge(img),
          }),
          h('div', { 'data-ws-thumb-bar': '' },
            h('span', { 'data-ws-thumb-name': '', title: img.filename }, img.filename),
            h('button', {
              'data-comfy-chip': '', type: 'button',
              onClick: () => onFind({ promptId: img.promptId, filename: img.filename }),
            }, t('wsFindWorkflow'))))))
    }

    /** 大图查看弹层 */
    function Lightbox({ image, t, onClose, onFind }) {
      if (!image) return null
      return h('div', { 'data-ws-lightbox': '', onClick: onClose },
        h('div', { 'data-ws-lightbox-inner': '', onClick: (e) => e.stopPropagation() },
          h('img', { src: imageUrl(image), alt: image.filename }),
          h('div', { 'data-ws-lightbox-bar': '' },
            h('span', {}, image.filename),
            h('button', { 'data-comfy-chip': '', type: 'button', onClick: () => onFind({ promptId: image.promptId, filename: image.filename }) }, t('wsFindWorkflow')),
            h('button', { 'data-comfy-chip': '', type: 'button', onClick: onClose }, t('wsClose')))))
    }

    /** 队列面板 */
    /** 从队列项 / job 里抽出统一字段（ComfyUI 队列项是数组：[序号, prompt_id, 图, extra, 输出节点]）。 */
    function queueMeta(item) {
      if (Array.isArray(item)) {
        return {
          number: Number.isFinite(Number(item[0])) ? Number(item[0]) : null,
          promptId: String(item[1] ?? ''),
          graph: item[2] && typeof item[2] === 'object' ? item[2] : null,
          status: '',
        }
      }
      const graph = item?.prompt && typeof item.prompt === 'object' && !Array.isArray(item.prompt)
        ? item.prompt
        : (item?.graph && typeof item.graph === 'object' ? item.graph : null)
      return {
        number: Number.isFinite(Number(item?.number)) ? Number(item.number) : null,
        promptId: String(item?.id ?? item?.prompt_id ?? ''),
        graph,
        status: String(item?.status ?? ''),
      }
    }

    /** 从一张 API 图里粗略取个「人话」摘要：提示词首句 + 尺寸 + 步数。 */
    function graphSummary(graph) {
      if (!graph || typeof graph !== 'object') return { prompt: '', size: '', steps: '' }
      let prompt = ''
      let size = ''
      let steps = ''
      for (const node of Object.values(graph)) {
        const inputs = node?.inputs ?? {}
        const type = String(node?.class_type ?? '')
        if (!prompt && /clip.*text|text.*encode/i.test(type) && typeof inputs.text === 'string') prompt = inputs.text
        if (!size && Number.isFinite(Number(inputs.width)) && Number.isFinite(Number(inputs.height))) {
          size = `${inputs.width}×${inputs.height}`
        }
        if (!steps && Number.isFinite(Number(inputs.steps))) steps = String(inputs.steps)
      }
      return { prompt, size, steps }
    }

    function QueuePanel({ snapshot, t, onOpen, onEnlarge }) {
      const running = snapshot?.queue?.running ?? []
      const pending = snapshot?.queue?.pending ?? []
      const jobs = snapshot?.jobs ?? []
      const generated = snapshot?.generated ?? []
      // prompt_id → 已产出的图（索引里有 files 才能出缩略图）
      const fileOf = React.useMemo(() => {
        const map = new Map()
        for (const rec of generated) {
          const first = Array.isArray(rec?.files) ? rec.files[0] : null
          if (rec?.promptId && first) map.set(String(rec.promptId), first)
        }
        return map
      }, [generated])

      const row = (item, index) => {
        const meta = queueMeta(item)
        const summary = graphSummary(meta.graph)
        const image = meta.promptId ? fileOf.get(meta.promptId) : null
        const nodeCount = meta.graph ? Object.keys(meta.graph).length : 0
        const label = meta.promptId ? meta.promptId.slice(0, 8) : t('wsQUnknown')
        return h('div', { key: meta.promptId || index, 'data-ws-queue-item': '' },
          image
            ? h('img', {
                'data-ws-queue-thumb': '', src: imageUrl(image), alt: label,
                loading: 'lazy', onClick: () => onEnlarge?.({ ...image, promptId: meta.promptId }),
                title: t('wsClickImage'),
              })
            : h('span', { 'data-ws-queue-noimg': '' }, '—'),
          h('div', { 'data-ws-queue-main': '' },
            h('div', { 'data-ws-queue-title': '' },
              h('span', { 'data-ws-queue-id': '' }, label),
              meta.number !== null ? h('span', { 'data-ws-queue-num': '' }, `#${meta.number}`) : null,
              nodeCount ? h('span', { 'data-ws-queue-tag': '' }, interp(t('wsQNodes'), { n: nodeCount })) : null,
              meta.status ? h('span', { 'data-ws-queue-tag': '' }, meta.status) : null,
              summary.size ? h('span', { 'data-ws-queue-tag': '' }, summary.size) : null,
              summary.steps ? h('span', { 'data-ws-queue-tag': '' }, `${t('wsSteps')} ${summary.steps}`) : null),
            h('div', { 'data-ws-queue-prompt': '', title: summary.prompt || '' },
              summary.prompt ? summary.prompt.slice(0, 120) : t('wsQNoPrompt'))),
          h('div', { 'data-ws-queue-acts': '' },
            meta.promptId
              ? h('button', {
                  'data-comfy-chip': '', type: 'button', title: t('wsQOpen'),
                  onClick: () => onOpen?.({ promptId: meta.promptId }),
                }, t('wsQOpen'))
              : null))
      }

      /** 「最近完成」的行：索引记录（带图 + 参数）优先，纯 job 只显示 id 与状态。 */
      const recordRow = (entry, index) => {
        const rec = entry.kind === 'record' ? entry.record : null
        const job = entry.kind === 'job' ? entry.job : null
        const promptId = String(rec?.promptId ?? job?.id ?? job?.prompt_id ?? '')
        const image = rec && Array.isArray(rec.files) && rec.files.length
          ? rec.files[0]
          : (Array.isArray(job?.images) && job.images.length ? job.images[0] : null)
        const params = rec?.params ?? {}
        const nodeCount = rec?.graph ? Object.keys(rec.graph).length : 0
        const label = promptId ? promptId.slice(0, 8) : t('wsQUnknown')
        const promptText = String(params.prompt ?? '')
        return h('div', { key: promptId || index, 'data-ws-queue-item': '' },
          image
            ? h('img', {
                'data-ws-queue-thumb': '', src: imageUrl(image), alt: label, loading: 'lazy',
                onClick: () => onEnlarge?.({ ...image, promptId }),
                title: t('wsClickImage'),
              })
            : h('span', { 'data-ws-queue-noimg': '' }, '—'),
          h('div', { 'data-ws-queue-main': '' },
            h('div', { 'data-ws-queue-title': '' },
              h('span', { 'data-ws-queue-id': '' }, label),
              h('span', { 'data-ws-queue-tag': '' }, entry.status),
              nodeCount ? h('span', { 'data-ws-queue-tag': '' }, interp(t('wsQNodes'), { n: nodeCount })) : null,
              params.width && params.height ? h('span', { 'data-ws-queue-tag': '' }, `${params.width}×${params.height}`) : null,
              params.steps ? h('span', { 'data-ws-queue-tag': '' }, `${t('wsSteps')} ${params.steps}`) : null,
              params.model ? h('span', { 'data-ws-queue-tag': '' }, String(params.model).slice(0, 24)) : null),
            h('div', { 'data-ws-queue-prompt': '', title: promptText },
              promptText ? promptText.slice(0, 120) : t('wsQNoPrompt'))),
          h('div', { 'data-ws-queue-acts': '' },
            promptId
              ? h('button', {
                  'data-comfy-chip': '', type: 'button', title: t('wsQOpen'),
                  onClick: () => onOpen?.({ promptId }),
                }, t('wsQOpen'))
              : null))
      }

      const doneSection = (rows) => h('div', { 'data-ws-queue-sec': '' },
        h('div', { 'data-ws-h': '' }, `${t('wsRecent')}${rows.length ? ` (${rows.length})` : ''}`),
        rows.length === 0
          ? h('div', { 'data-ws-muted': '' }, t('wsNoQueue'))
          : h('div', { 'data-ws-queue-list': '' }, ...rows.map(recordRow)))

      const section = (title, items) => h('div', { 'data-ws-queue-sec': '' },
        h('div', { 'data-ws-h': '' }, `${title}${items.length ? ` (${items.length})` : ''}`),
        items.length === 0
          ? h('div', { 'data-ws-muted': '' }, t('wsNoQueue'))
          : h('div', { 'data-ws-queue-list': '' }, ...items.map(row)))

      const done = jobs.filter((j) => ['completed', 'success', 'finished'].includes(String(j?.status ?? '').toLowerCase()))
      // 「最近完成」优先用索引里的生成记录：它们带产出文件（能出缩略图）与参数，
      // jobs 只用来补状态；索引没有的才退回 job 本身。
      const doneRows = React.useMemo(() => {
        const statusOf = new Map()
        for (const j of done) {
          const id = String(j?.id ?? j?.prompt_id ?? '')
          if (id) statusOf.set(id, String(j?.status ?? 'completed'))
        }
        const seen = new Set()
        const rows = []
        for (const rec of generated) {
          const id = String(rec?.promptId ?? '')
          if (!id || seen.has(id)) continue
          seen.add(id)
          rows.push({ kind: 'record', record: rec, status: statusOf.get(id) ?? 'completed' })
        }
        for (const j of done) {
          const id = String(j?.id ?? j?.prompt_id ?? '')
          if (!id || seen.has(id)) continue
          seen.add(id)
          rows.push({ kind: 'job', job: j, status: String(j?.status ?? 'completed') })
        }
        return rows
      }, [done, generated])

      return h('div', { 'data-ws-queue': '' },
        section(t('wsRunning'), running),
        section(t('wsPending'), pending),
        doneSection(doneRows))
    }

    /**
     * 会话视图组件。conversation.view 的注册组件会收到注入的 props；
     * 这里只依赖 hostFetch（全局可用），不强依赖具体 props 形状。
     */
    function ComfyWorkspace({ t }) {
      const [tab, setTab] = React.useState('workflow')
      const [snapshot, setSnapshot] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [lookup, setLookup] = React.useState({ loading: false, reason: '', source: '' })
      const [enlarged, setEnlarged] = React.useState(null)
      const [highlight, setHighlight] = React.useState(null)
      const [submitting, setSubmitting] = React.useState(false)
      const [submitMsg, setSubmitMsg] = React.useState('')
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])
      // 切换工作流时清掉图例高亮，免得新图没有该类节点却整片变暗
      React.useEffect(() => { setHighlight(null) }, [selected])

      const refresh = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const res = await hostFetch(WORKSPACE_API.snapshot, { method: 'GET' })
          const data = await res.json()
          if (!alive.current) return
          if (!data?.ok) setError(data?.error ?? data?.reason ?? 'unknown')
          setSnapshot(data)
        } catch (e) {
          if (alive.current) setError(String(e?.message ?? e))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      // 默认选中最近一次生成记录的工作流
      React.useEffect(() => {
        if (selected || !snapshot?.generated?.length) return
        const first = snapshot.generated[0]
        if (first?.graph) {
          setSelected({ ...first, source: 'index' })
        } else {
          // 索引里没 graph（旧记录）→ 走反查
          hostFetch(`${WORKSPACE_API.workflow}?promptId=${encodeURIComponent(first.promptId)}`, { method: 'GET' })
            .then((r) => r.json())
            .then((data) => {
              if (alive.current && data?.ok) setSelected({ ...data, source: data.source })
            })
            .catch(() => {})
        }
      }, [snapshot, selected])

      const findWorkflow = React.useCallback(async ({ promptId, filename }) => {
        setLookup({ loading: true, reason: '', source: '' })
        setSubmitMsg('')
        try {
          const q = new URLSearchParams()
          if (promptId) q.set('promptId', promptId)
          if (filename) q.set('filename', filename)
          const res = await hostFetch(`${WORKSPACE_API.workflow}?${q.toString()}`, { method: 'GET' })
          const data = await res.json()
          if (!alive.current) return
          if (data?.ok) {
            setSelected({ ...data, source: data.source })
            setTab('workflow')
            setLookup({ loading: false, reason: '', source: data.source })
          } else {
            setLookup({ loading: false, reason: data?.reason ?? '查不到', source: '' })
          }
        } catch (e) {
          if (alive.current) setLookup({ loading: false, reason: String(e?.message ?? e), source: '' })
        }
      }, [])

      const resubmit = React.useCallback(async (payload) => {
        setSubmitting(true)
        setSubmitMsg('')
        try {
          const res = await hostFetch(WORKSPACE_API.submit, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const data = await res.json()
          if (!alive.current) return
          if (data?.ok) {
            setSubmitMsg(interp(t('wsSubmitted'), { id: data.promptId }))
            refresh()
          } else {
            setSubmitMsg(data?.reason ?? '提交失败')
          }
        } catch (e) {
          if (alive.current) setSubmitMsg(String(e?.message ?? e))
        } finally {
          if (alive.current) setSubmitting(false)
        }
      }, [refresh, t])

      const offline = snapshot && snapshot.online === false
      return h('div', { 'data-comfy-workspace': '' },
        h('div', { 'data-ws-toolbar': '' },
          h('div', { 'data-ws-tabs': '' },
            ...[['workflow', 'wsWorkflow'], ['images', 'wsImages'], ['queue', 'wsQueue']].map(([key, label]) =>
              h('button', {
                key, 'data-comfy-chip': '', 'data-on': tab === key ? '' : undefined,
                type: 'button', onClick: () => setTab(key),
              }, t(label)))),
          h('button', {
            'data-comfy-chip': '', type: 'button', disabled: loading,
            onClick: refresh,
          }, loading ? t('wsRefreshing') : t('wsRefresh'))),

        offline ? h('div', { 'data-comfy-msg': '', 'data-bad': '' }, interp(t('wsOffline'), { url: snapshot?.baseUrl ?? '' })) : null,
        error ? h('div', { 'data-comfy-msg': '', 'data-bad': '' }, interp(t('wsLoadFailed'), { reason: error })) : null,
        lookup.reason ? h('div', { 'data-comfy-msg': '', 'data-bad': '' }, interp(t('wsNoWorkflow'), { reason: lookup.reason })) : null,
        lookup.source ? h('div', { 'data-comfy-msg': '' }, t(lookup.source === 'index' ? 'wsSourceIndex' : 'wsSourceHistory')) : null,
        submitMsg ? h('div', { 'data-comfy-msg': '' }, submitMsg) : null,

        tab === 'workflow' ? h('div', { 'data-ws-body': '' },
          selected?.graph
            ? h('div', { 'data-ws-workflow': '' },
                h('div', { 'data-ws-left': '' },
                  h('div', { 'data-ws-graph-wrap': '' },
                    h('div', { 'data-ws-note': '' }, interp(t('wsNodeCount'), {
                      n: Object.keys(selected.graph).length,
                      m: buildGraphLayout(selected.graph).links.length,
                    })),
                    h('div', { 'data-ws-graph-scroll': '' }, h(GraphCanvas, { graph: selected.graph, t, highlight })),
                    h(GraphLegend, { graph: selected.graph, t, highlight, onHighlight: setHighlight })),
                  h('div', { 'data-ws-picker': '' },
                    (snapshot?.generated ?? []).length === 0
                      ? h('div', { 'data-ws-muted': '' }, t('wsPickEmpty'))
                      : h('div', { 'data-ws-pick-list': '' }, ...(snapshot?.generated ?? []).map((rec) => {
                        const params = rec?.params ?? {}
                        const promptText = String(params.prompt ?? '')
                        const thumb = Array.isArray(rec?.files) && rec.files.length ? rec.files[0] : null
                        const on = selected?.promptId === rec.promptId
                        return h('button', {
                          key: rec.promptId, type: 'button',
                          'data-ws-pick-row': '', 'data-on': on ? '' : undefined,
                          onClick: async () => {
                            if (rec.graph) { setSelected({ ...rec, source: 'index' }); return }
                            await findWorkflow({ promptId: rec.promptId })
                          },
                        },
                          thumb
                            ? h('img', { 'data-ws-pick-thumb': '', src: imageUrl(thumb), alt: '', loading: 'lazy' })
                            : h('span', { 'data-ws-pick-thumb': '', 'data-empty': '' }, '—'),
                          h('div', { 'data-ws-pick-main': '' },
                            h('div', { 'data-ws-pick-title': '' },
                              h('span', { 'data-ws-pick-id': '' }, String(rec.promptId).slice(0, 8)),
                              params.width && params.height
                                ? h('span', { 'data-ws-queue-tag': '' }, `${params.width}×${params.height}`) : null,
                              params.steps ? h('span', { 'data-ws-queue-tag': '' }, `${t('wsSteps')} ${params.steps}`) : null),
                            h('div', { 'data-ws-pick-prompt': '', title: promptText },
                              promptText ? promptText.slice(0, 140) : t('wsQNoPrompt'))))
                      })))),
                h(ParamEditor, {
                  record: selected, t, onSubmit: resubmit, submitting,
                  samplers: snapshot?.samplers?.length ? snapshot.samplers : FALLBACK_SAMPLERS,
                  schedulers: snapshot?.schedulers?.length ? snapshot.schedulers : FALLBACK_SCHEDULERS,
                  loras: snapshot?.loras ?? [],
                }))
            : h('div', { 'data-comfy-msg': '' }, t('wsSelectWorkflow')))
          : null,

        tab === 'images' ? h('div', { 'data-ws-body': '' },
          h('div', { 'data-ws-note': '' }, t('wsClickImage')),
          h(ImageGallery, { generated: snapshot?.generated, t, onFind: findWorkflow, onEnlarge: setEnlarged }))
          : null,

        tab === 'queue' ? h('div', { 'data-ws-body': '' }, h(QueuePanel, {
          snapshot, t, onEnlarge: setEnlarged,
          onOpen: ({ promptId, filename }) => {
            if (promptId) findWorkflow({ promptId })
            else if (filename) findWorkflow({ filename })
            else setTab('workflow')
          },
        })) : null,

        h(Lightbox, { image: enlarged, t, onClose: () => setEnlarged(null), onFind: findWorkflow })
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

      // 会话视图顶部切换：「ComfyUI」页 —— 节点图 / 产出图 / 队列 / 图→工作流反查。
      // 视图 label 由 conversation.view 的注册项生成；数据源走宿主只读/提交路由。
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'comfyui-workspace',
        order: 60,
        label: () => t('viewTab'),
        locale: NS,
      }, () => h(ComfyWorkspace, { t })))
    }

    return { inject, apply }
  },
})
