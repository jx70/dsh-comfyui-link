# Changelog

All notable changes to this project are documented here.
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.6.0] - 2026-11-14

### 新增

- **LoRA 提示词文档**：设置页多一栏「LoRA 提示词 → 提示词目录」，挑一个目录，挂 LoRA 出图时插件自己去里面挑一篇最合适的文档，把提示词段并进 `prompt`，并在结果文本里交代挑中了哪篇、为什么、加了几个字。
  - **不靠命名约定**：目录里可以混放各种东西（角色说明、画风笔记、tag 清单、图片，甚至模型文件本身），文件名也不必与 LoRA 名对齐。插件把认得的文档读进来**打分**：**文档和这个 LoRA 的模型文件在同一个文件夹里 +120（该文件夹只有这一个模型）/ +60（旁边还有别的模型）**—— 这是最硬的证据，一个角色一个文件夹、模型与提示词并排放的摆法名字怎么起都行；文件名与 LoRA 名一致 +100、包含 +70、所在子文件夹名一致 +70、命中几个词按比例 ×60；正文提到 LoRA 名 +30（部分命中 ×12）；标题就是/包含 +35/+25；有「提示词」小标题 +20；内容本身是逗号分隔的 tag 串 +12。
  - 三档结论：**match**（最高分 ≥ 45，直接用）/ **sole**（都不够高、但全目录只有一篇像提示词，用它并说明没明确提到这个 LoRA）/ **none**（都不像，**什么都不并** —— 宁可少喂，也别把说明文字塞进 prompt）。
  - 提示词段：文档里有 `# 提示词` / `## Prompt` / `## 正面提示词` 这类标题就只取它下面那一段（到同级或更高级标题为止），没有标题就取全文；超过 1200 字截断并标记。
  - 只认 `.md` / `.markdown` / `.txt`，子文件夹最多往下走 3 层（**子目录也扫**，按角色/画风分目录放都行，文件夹名同样参与打分；符号链接指回上层时不会原地打转），单篇超过 256 KB 跳过。`.safetensors` / `.ckpt` / `.pt` / `.pth` / `.bin` / `.gguf` / `.sft` 这些模型文件不会被当成文档读，只用来判断「这篇文档和哪个 LoRA 摆在一起」。
  - **目录留空时一个文件都不读**，行为与 1.5.1 完全一致。
- **新工具 `comfy_lora_doc`**：给 `lora` 就返回**打分表**（前 5 名与各自理由）加上挑中那篇的提示词段（`full: true` 给全文）；不给就列出目录里的候选、子文件夹路径，并标出哪几篇像提示词。目录没配、目录不存在、挑不中、读不了都只是说明情况，**任何情况都不抛错**。
- **`GET /api/comfyui/lora-docs`**：只读路由，给设置页报「已识别 N 篇候选（M 篇像提示词）」。没配目录时直接回 `{ok:true, dir:'', count:0, promptish:0, docs:[]}`，不去碰磁盘。
- `comfy_run` / `comfy_review` 新增 `lora_doc` 参数（`auto` / `off`）：`auto`（默认）就是上面那套自动挑，`off` 只对这一次跳过。`comfy_review` 重画时也会把文档里的提示词段带上，否则第二轮就丢了角色设定。

### 变更

- 设置页新增「LoRA 提示词」分区（只读路径 + 「选择」/「清除」+ 「已识别 N 篇候选（M 篇像提示词）」），与「图片输出」那一栏同样的交互：选完只进草稿，仍要点「保存」。
- 系统提示补一行，说明文档目录、按内容挑、`comfy_lora_doc` 与 `lora_doc: "off"` 的用法。
- **设置页 UI 整理**：审图分区标题改成「标题 + 副标题」两行结构；「图生图」和「放大」两个各自带边框的孤儿开关合并进一个「功能开关」分区；保存条改成 sticky 吸附在面板底部，滚动长表单时按钮始终可见。

### 修复

- **挂了 LoRA 却偶尔不去找提示词文档**：之前只在 `comfy_run` / `comfy_review` 的 template/img2img 分支里查文档，且有三种情况**静默跳过、结果里一个字不提** —— 传了 `lora_doc: "off"`、设置里没配目录、`mode: "graph"`（哪怕图里就有 `LoraLoader`）。表现就是「同一套流程，上一张并入了提示词，这一张没并入」。现在：
  - **graph 模式也查**：扫工作流里所有 `LoraLoader` / `LoraLoaderModelOnly` 节点，按 `lora_name` 逐个查文档，命中就把提示词段写进正面 `CLIPTextEncode`（优先 `prompt` 参数写过的那个节点，否则第一个）。不需要另外传 `lora` 参数。
  - **四种结局都留痕**：命中 → 「已并入 prompt，+N 字」；挑不中 → 列出分数最高的几篇；目录没配 → 「没配「LoRA 提示词」目录，这次没查文档」；传了 `off` → 「这次传了 `lora_doc:"off"`，跳过了文档」。

### 测试

- 新增 `test/lora-docs.test.mjs`（18 条）：`normalizeLoraKey` 的各种写法、`nameTokens`、`looksLikePrompt`（tag 串 vs 散文 vs 长句列举）、`docTitle`、`extractPromptSection` 有/无标题与截断、`scoreDocForLora`（名字不对齐靠正文/标题拿高分、文件名一致分最高、散文得 0 分、部分命中词、同目录摆放是最高信号）、`readLoraDocs` 的空目录与不存在的目录与子目录与深度上限与 siblings、`rankLoraDocs` + `chooseLoraDoc` 的 match/sole/none 三档、`resolveConfiguredDir` 的自定义 label、`composeLoraPrompt` 空文档原样返回。
- `test/config.test.mjs` 27 条不变，但覆盖面扩到第六个 volatile 段：默认值、自定义值、`loraDocs` 也在 volatile 列表里。
- `test/registration.test.mjs` 23 → **33** 条（9 个工具、`lora-docs` 路由的四种响应含「真目录报候选数与像提示词数」、`comfy_lora_doc` 的三种说明、`comfy_lora_doc` 给 lora 时的打分表、`lora_doc` 的 enum；外加三条「挂了 LoRA 一定留痕」：没配目录、传 `off`、graph 模式带 `LoraLoader` 时真的把文档并进正面 `CLIPTextEncode` —— 后两条用 `node:http` 起一个假 ComfyUI，从它收到的 `/prompt` 请求体反查）。
- 单测总数 90 → **119**。
- `scripts/probe-client-bundle.mjs` 标记 19 → **25** 项（`loraDocs` / `loraDocsApi` / `loraDocsCount` / `reviewNote` / `features` / `savebar`）；`scripts/probe-http.mjs` 打四条路由（新增 `/api/comfyui/lora-docs` 的 200 与 401，并打印候选数与像提示词数）。

## [1.5.1] - 2026-11-14

### 修复

- **暗色模式下绘图控件的文字看不清（发白、糊在底上）**。两个原因叠在一起：
  - 底色用了一个主题里根本不存在的 token：`--dsw-alias-bg-layer-4`。`@deepseek-ai/dsh-client-ui-theme` 的浅色块与深色块各 119 个 token 里都没有它（整个 `@deepseek-ai` 安装目录也搜不到定义），于是每次取值都落到兜底 `rgba(128,128,128,.12)` —— 12% 灰的半透明层，压在暗色卡片的 `#2c2c2e` 上几乎等于没有底色。现在换成 `--dsw-specific-selector`（浅色 `#f5f6f7`、深色 `#353638`，不透明，出厂输入框按钮用的就是它）。
  - 文字颜色靠 `color:inherit`，而原生 `<select>` 展开的 `<option>` 列表由浏览器自己决定表面色，我们没给任何规则 —— 继承来的近白色（`--dsw-alias-label-primary` 暗色 = `#f9fafb`）落到浅色弹层上就是「发白光」。现在 6 处 `inherit` 全改成显式 `var(--dsw-alias-label-primary, inherit)`，并给 `[data-comfy-mini] option` / `[data-comfy-select] option` 补上显式底色与字色。
- 边框兜底色从 `rgba(255,255,255,.14)` / `.18` 改成中性 `rgba(128,128,128,.28)` / `.35`（真机上 token 有定义，这只影响兜底，浅色下不会再有白边发脏）。

### 测试

- `test/config.test.mjs` 26 → **27** 条：新增守护「不许再出现 `--dsw-alias-bg-layer-4`」「必须用 `--dsw-specific-selector` 与 `--dsw-alias-label-primary`」「`option` 必须有显式规则」。
- 单测总数 89 → **90**。
- `scripts/probe-client-bundle.mjs` 标记 18 → **19** 项（新增 `optionSkin`）。

## [1.5.0] - 2026-11-14

### 新增

- **生图模型下拉认 `checkpoints` 里的整合包**：之前 `draw-models` 路由只发 `diffusion_models`，所以 `models/checkpoints` 里的整包（Illustrious / 光辉 这类 SDXL 检查点）在对话栏里根本选不到，`comfy_run` 也只会走 `UNETLoader + CLIPLoader + VAELoader` 三件套。现在：
  - `GET /api/comfyui/draw-models` 的 `folders` 多一个 `checkpoints` 字段。
  - 下拉分两组显示（「扩散模型（三件套）」与「整合包（光辉 / SDXL 检查点）」），`draw.unet` 存的仍是文件名本身。
  - `resolveModels()` 按名字落在哪个文件夹决定加载方式：`checkpoints` 里 → 返回 `{checkpoint}`，走 `CheckpointLoaderSimple`（一个文件带出 MODEL/CLIP/VAE）；`diffusion_models` 里 → 返回 `{unet, clip, vae}`，走三件套。同名时按整合包算。
  - 不点名时的顺序：`diffusion_models` 第一个 → `checkpoints` 第一个 → 报错。
  - `buildTxt2Img` / `buildImg2Img` 各加一条整合包分支（节点号整体不同：整合包的 txt2img 是 1 `CheckpointLoaderSimple` / 2-3 `CLIPTextEncode` / 4 `EmptyLatentImage` / 5 `KSampler` / 6 `VAEDecode` / 7 `SaveImage` / 8 `LoraLoader`；img2img 是 1 `CheckpointLoaderSimple` / 2-3 提示词 / 4 `LoadImage` / 5 `VAEEncode` / 6 `KSampler` / 7 `VAEDecode` / 8 `SaveImage`）。
  - `comfy_run` 的结果摘要按实际加载器读节点号（整合包报「模型：<文件>（整合包，MODEL/CLIP/VAE 都从它出）」），不再写死 `graph[1].unet_name`。

### 变更

- `comfy_models` 的提示：`checkpoints` 非空时说明「模板优先用 `diffusion_models`，空了才用整合包」；两条都空才提示改用 graph 模式。
- 系统提示与工具参数描述里「扩散模型（unet）」统一改成「生图模型」，并写明模型列表的两组分别对应哪种加载器。
- `draw.unet` 的 schema 描述改成「diffusion_models 或 checkpoints 里的文件名」。

### 测试

- `test/graph.test.mjs` 22 → **27** 条：新增整合包的 `resolveModels`（点名 / 不点名 / 只有 checkpoints 时不再要求 text_encoders 与 vae）、`buildTxt2Img` 整合包分支（7 节点、连线指向 `['1',0]`/`['1',1]`/`['1',2]`）、整合包 + LoRA（节点 8）、`buildImg2Img` 整合包分支（节点号与字符串连线）。
- `test/config.test.mjs` 新增一条：`client.js` 必须有两组分组的文案键（`drawGroupUnet` / `drawGroupCheckpoint`）且读 `folders.checkpoints`，`index.js` 必须把 `checkpoints` 发出去。
- 单测总数 83 → **89**。
- `scripts/probe-client-bundle.mjs` 标记 16 → **18** 项（新增 `drawCheckpoints` / `drawUnets`）。
- `scripts/probe-http.mjs` 的 draw 段多列一行 `checkpoints`。
- 真机验证（512×512 / 12 步）：整合包单独出图成功（`_tmp_ckpt_00001_.png`），整合包 + LoRA（`belle_anima_v1.safetensors`）也成功（`_tmp_ckpt_lora_00001_.png`），两次 `status_str` 都是 `success`。

### 变更（CI）

- **CI 的 Linux 镜像钉成 `ubuntu-24.04`**（原来是 `ubuntu-latest`）。`ubuntu-latest` 会在 2026-10-19 迁到 Ubuntu 26，届时 runner 上的 Node / glibc / 预装工具都可能跟着变，而这条仓库的 Linux 任务只是跑单测与 `npm pack --dry-run`，没有必须追最新的理由。钉住版本让「换镜像」变成我们自己决定的一次提交，而不是某次 push 突然变红；要升级就改 `.github/workflows/ci.yml` 的 `matrix.os` 那一行（那里有注释说明）。Windows 侧仍用 `windows-latest`。

## [1.4.0] - 2026-11-14

### 新增

- **桌面端（DSH Desktop / Electron）适配**：桌面端的页面来源是 `dsh-app://app/`，不是 http origin，所以相对 `/api/...` 的请求在那里解析不到宿主。`client.js` 新增 `hostFetch(route, init)`：有 `globalThis.__DSH_TRANSPORT__.fetch`（preload 注入）就用它，并把路径去掉前导斜杠（出厂 `createWebConnectionRpc` 与 HMR 都是这么传的）；没有就退回页面自己的 `fetch`。三条路由（vision / draw / pick）全部改走它。
- **桌面端优先用原生目录桥**：`desktopPicker()` 探测 `globalThis.__DSH_DIRECTORY_PICKER__.pick()`（`{ pick: () => Promise<string|null> }`，取消返回 `null`）。有它就由 Electron 自己弹系统框，省掉宿主 spawn `powershell.exe` 那一圈；没有才走 `POST /api/comfyui/pick-directory`。两条路对调用方语义一致（取消都归一成 `''`）。
- `test/config.test.mjs` 新增一条守护：`client.js` 必须含 `__DSH_TRANSPORT__` / `hostFetch` / `__DSH_DIRECTORY_PICKER__` / `desktopPicker`，且**不许**出现裸 `fetch(VISION_API|DRAW_API|PICK_API)`。

### 变更

- `dsh.client.platform` 仍是 `web` —— 桌面端加载的就是同一份 Web GUI、同一份 `client.js`，不需要另发声明（`dsh-client-modules` 的 `resolveMeta` 只服务 `platform === "web"`）。
- README「兼容性与已知限制」里「只做 web profile」改成「只做 web 客户端」，并说明桌面端照常可用。

### 注意

- 传输钩子收的是**文档相对**路径。传 `/api/...` 全路径会被解析成 `dsh-app://app/api/...` 之类，永远打不到宿主 —— `hostFetch` 内部统一 `.replace(/^\/+/, '')`。
- 桌面端目前无法在本机验证（这台机器没装 DSH Desktop，`<home>/.dsh/profiles` 下也没有 desktop profile，CLI 明确拒绝操作它）。适配只依赖出厂代码里已有的两个 preload 全局，且是能力探测、缺席即回落，所以浏览器行为零变化。
- `__DSH_TRANSPORT__` / `__DSH_DIRECTORY_PICKER__` 在任何 `.d.ts` 里都没有类型声明，形状是照出厂运行时代码（`dsh-client-connection/lib/client.browser.js`、`dsh-client-ui-directory-picker-native/lib/client.js`）抄的。

### 测试

- 单测总数 82 → **83**（`test/config.test.mjs` 24 → 25）。
- `scripts/probe-client-bundle.mjs` 标记 14 → **16** 项（新增 `hostFetch` / `desktopPicker`）。
- 全套复跑：`npm test` 83/83、`npm run smoke` 8 工具全过（系统提示渲染 818 字符）、`npm run probe:bundle` 16 项全 true、`npm run probe:http` 三条路由全过。

## [1.3.0] - 2026-11-14

### 新增

- **输出目录改为只能「选择」，手填框已删掉**：设置页「输出」分区不再有文本框，只剩一个「选择」按钮（旁边有「清除」，把已选目录清空）和一个显示当前路径的只读行（为空时显示「没选（图留在 ComfyUI 的 output）」）。点「选择」会弹**系统原生的文件夹选择框**。浏览器半端发 `POST /api/comfyui/pick-directory`（同一个 `connection.fetch.register` 通道，只此一条 POST 路由），宿主在本机拉 `powershell.exe -STA` + WinForms `FolderBrowserDialog`，用一个 1×1、TopMost、`Opacity=0` 的隐形 owner 把对话框顶到浏览器前面。挑完的路径只进**草稿**，仍要按「保存」才落盘。
- **`buildPickerScript` / `parsePickedText` / `quotePowerShell` / `powershellPath` / `parsePowerShellError` 五个导出纯函数**：把「生成脚本 / 解析回传 / 单引号转义 / 找 powershell.exe / 从 stderr 挖错误」和「真的去 spawn」拆开，`test/picker.test.mjs` 就能在不弹窗的前提下钉住全部逻辑（含平台分支与去本地化守护）。

### 变更

- **删掉输出目录的手填框**：1.2.0 那栏是「文本框 + 说明」，现在改成「只读路径显示 + 「选择」+「清除」」—— 路径只能从系统对话框里挑。仍保留把 `output.dir` 直接写进 profile 的路子（`cordis.patch.yml` 里改），相对路径语义不变。
- 系统提示多一句：「输出目录」那一栏只有「选择」按钮，点了弹系统文件夹选择框挑目录。
- 没有 `connection.fetch` 时的降级日志补上「输出目录只能在 profile 里配」。

### 注意

- 对话框是**阻塞式**的：请求一直挂着等用户点，插件自己给 180 秒超时；同一个窗口连点两次，第二次被宿主挡回 409「已经有一个选择框开着」。
- 只有 Windows 有原生选择框。其它平台返回 `{ ok: false, reason: 'unsupported' }`，前端提示「这个平台没有系统文件夹选择框，输出目录在这里设不了」，要去 profile 的 `cordis.patch.yml` 里配 `output.dir`。
- 路径**不走子进程 stdout**：控制台代码页会把中文路径写坏，所以结果一律写进 UTF-8（无 BOM）临时文件再读回来；`-Command` / `-File` 也不可用（外层 PowerShell 会把 `$` 变量吃掉），一律 `-EncodedCommand`（UTF-16LE base64）。
- 脚本里加了 `$ProgressPreference = 'SilentlyContinue'`：不关掉进度流的话，powershell 会往 stderr 写一大段 CLIXML 进度噪音，把真正的错误埋掉。`parsePowerShellError` 负责从 CLIXML 的 `<S S="Error">` 里挖正文并还原 `_x000D_` 这类转义 —— 出问题时用户看到的是人话，不是 XML。

### 测试

- 新增 `test/picker.test.mjs`（9 条）：`powershellPath` 平台分支、`quotePowerShell` 三种转义、脚本完整性、带 `initial` 时的 `SelectedPath` 与标题转义、脚本不含本机绝对路径、`parsePickedText` 八种输入、路由 `methods: ['POST']` + `requestBody: 'buffered'` + 只注册一条、坏 JSON → 400 + `reason: 'bad-request'`。
- `test/config.test.mjs` / `test/registration.test.mjs` / `test/graph.test.mjs` / `test/output.test.mjs` 不动；总数 73 → **82**。
- `scripts/probe-client-bundle.mjs` 标记 9 → 11 项（`pick` / `pickApi`）；`scripts/probe-http.mjs` 加第三段：带 cookie 用 GET 打 pick 路由 → 404、带 cookie POST 坏 JSON → 400、不带 cookie POST → 401。

## [1.2.0] - 2026-11-14

### 新增

- **可配置的图片输出目录（`output.dir`）**：`Config` 新增第五个 volatile 段 `output: { dir: string }`，设置页在「放大」下面多一个「输出」分区（一个文本框 + 说明）。三种取值：留空 = 图只留在 ComfyUI 自己的 output 里、不额外复制（与 1.1.0 行为完全一致）；绝对路径 = 原样使用；相对路径 = 相对 ComfyUI 的 output 目录解析（认不出 ComfyUI 装在哪时报错，提示改用绝对路径）。
- **`comfy_review` / `comfy_upscale` 也支持 `save_to`**：之前只有 `comfy_result` 能另存，现在三个取图入口一致 —— `save_to` 传了就用它（逐次覆盖，不看设置页），没传就用 `output.dir`，两边都空就只报 ComfyUI 那边的原有路径。复制失败时只在文本里追加 `! 保存失败：…`，不把工具判失败（图已经出来了，另存只是附带动作）。
- **`comfy_run` 的摘要里报输出目录**：投稿完就告诉模型「图会被存到哪」，省得它再猜一次。只报路径，不做复制（复制发生在真正取图时）。
- 新增四个导出的纯函数，方便脱离宿主单测：`looksAbsolute`（平台无关的绝对路径判定）、`resolveOutputDir`（空/绝对/相对三态解析，相对无基准时抛错）、`uniqueTarget`（同名就加 `-1` / `-2`，不覆盖）、`saveImageCopy`（空目录或没有字节时直接返回 `''`，不建目录）。

### 变更

- `submitAndFetch` 的返回值补 `image` / `bytes` / `mediaType`，让三处取图入口都能拿到原始字节去另存，而不必再回 ComfyUI 取一次。
- 系统提示补一行「图片落在哪」，说明默认位置、设置页那一栏的作用、`save_to` 的覆盖关系。
- 不改 ComfyUI 那边的 `filename_prefix` 来做输出重定向：`SaveImage` 的相对前缀会由 ComfyUI 用 `os.path.join` 拼在它自己的 output 下，碰上绝对路径时的行为是实现的偶然结果（不同版本不一致），跨平台更不可靠。所以在插件侧复制，ComfyUI 侧保持原样。

### 测试

- 新增 `test/output.test.mjs`（4 条）：`looksAbsolute` 覆盖盘符式 / `/` 开头 / UNC 三种绝对写法与相对、空、非字符串，并显式断言「同一输入在 Windows 与 Linux 上结论相同」；`resolveOutputDir` 覆盖留空、绝对、相对有基准、相对无基准抛错；`uniqueTarget` 用临时目录验证 `image.png` → `image-1.png` → `image-2.png` 且原文件不被覆盖；`saveImageCopy` 验证空目录不建、无字节不写、落盘内容一致、重名加后缀。
- `test/config.test.mjs`：默认值断言补 `output: {dir: ''}`；volatile 集合从四段扩到五段（`review` / `img2img` / `upscale` / `draw` / `output`）。
- `test/registration.test.mjs`：新增「三个取图入口都能收 `save_to` 且它不是必填项」。
- `scripts/probe-client-bundle.mjs` 的标记项从 8 项扩到 9 项（加 `outputDirHint`）。
- 总数 68 → **73 条**。

### 文档

- `README.md` / `README.en.md`：「设置页」表格加「输出 / `dir`」行；新增输出目录三种取值对照表、`looksAbsolute` 为什么不用 `path.isAbsolute` 的说明、`save_to` 覆盖规则与「同名不覆盖、自动加后缀」。
- `docs/DESIGN.md` 补输出目录的解析链（配置 → `resolveOutputDir` → ComfyUI output 基准 → `saveImageCopy`）与「为什么不在 ComfyUI 侧改 `filename_prefix`」。
- `docs/DEVELOPMENT.md` 同步测试条数（73）与 `probe:bundle` 的 9 项标记。

## [1.1.0] - 2026-11-14

### 新增

- **第五个模式「绘图模式」**（preset `draw`，次序 5，排在标准 / PTC / 极简 / 创造之后）。它随插件自己的 `cordis.patch.yml` 一起发（`insert` 一条 `@deepseek-ai/dsh-agent-preset`），装包即装模式，不用手改 profile。子插件集是精简版：`persona`（出图助手人格，635 字：整理正面提示词 → `comfy_run` → `comfy_result`，变体走 img2img / upscale / review）、`time-context`、`tool-fs`、`compaction`（含 pruner）、`tool-ask-user`、`tool-todo`、`present`。`name` / `description` 自带中文，不依赖出厂 locale。
- **对话栏绘图控件（`conversation.input.left`）**：输入框左侧两个紧凑控件 —— 生图模型下拉（写 `draw.unet`）与 `LoRA` 胶囊（写 `draw.lora`）。两者都是**即时写入**（`form.mutate` 直落），与设置页的草稿+保存是两套语义。控件只在 `agentPreset === 'draw'` 的会话里渲染：用槽位的标准 props 读 `state.byId[sessionId].projectionValues.agentPreset`（照出厂 `AgentPresetLabel` 的写法），拿不到投影时回退到 `agent-preset-registry` 里用户选的默认预设。
- **`GET /api/comfyui/draw-models`** 只读路由：返回 `{ok, folders:{diffusion_models,text_encoders,vae,loras}}`，给绘图控件的模型下拉取清单；ComfyUI 连不上时 502 + `{ok:false,error,folders:{}}`。
- **`comfy_run` / `comfy_review` 的 `unet` 默认值**：省略时用绘图控件选中的模型（`draw.unet`），再退回 `diffusion_models` 里第一个。`comfy_review` 的重画现在也沿用这个默认模型，不再是「永远用文件夹里第一个」。

### 变更

- **LoRA 从设置页搬到对话栏**：`Config` 里删掉 `lora:{enabled}`，换成 `draw:{unet:string, lora:boolean}`（同样 volatile）。`comfy_run` / `comfy_review` 的 LoRA 闸改读 `draw.lora`，拦截文案改成「LoRA 没开启：在输入框左侧的绘图控件里把 LoRA 打开再来。」，不再指向设置页。
- **设置页「刷新」→「保存」**：删掉模型下拉旁边那颗「刷新」按钮（清单改为页面打开时自动取一次），改成面板底部的 **保存** 按钮 + 一行状态提示（`有未保存的改动` / `保存中…` / `已保存` / `保存失败`）。所有可编辑字段改为**草稿语义**：改动先留在本地，点保存才用一次 `form.mutate(ops)` 批量写入，成功后清空草稿。这样一次保存只产生一次 profile 写入与一次 revision 递增，而不是每敲一个字符写一次。
- **系统提示重写**：新增一段说明「绘图模式的会话里，输入框左侧有绘图控件；别的模式没有这两个控件，要指定模型就显式传 `unet`，LoRA 用不了」；去掉 img2img / upscale 行里「都要先在设置页开开关」「审图模型在设置页下拉里挑」这类已经过时的指引。
- **包名改为 `dsh-comfyui-link`**（原 `dsh-comfyui-bridge`）。原名在 npm 上已被他人占用（同名的 1.1.0 版本属于另一个维护者，本身也是 DSH 的 ComfyUI 桥），`add` 后面直接跟包名会装到别人的包。新名在 npm 与 GitHub 上都未占用。界面显示名不变，仍是「ComfyUI 桥 / ComfyUI Bridge」。
- `package.json` 的 `files` 增加 `!docs/demo.png`：示例图只给 GitHub 看，不进 npm 包（`npm pack` 仍是 14 files）。

### 迁移

- profile 里若还留着旧的 `lora: {enabled: true}`，**不会报错也不会生效**（schemastery 对未声明的键原样透传，插件不再读它）。要用 LoRA 就在 `config` 里改成 `draw: {unet: "", lora: true}`，或者在绘图模式的会话里点一下输入框左侧的 `LoRA` 胶囊。

### 测试

- `test/config.test.mjs`：默认值与 volatile 集合从「四段含 `lora`」改为「四段含 `draw`」；新增「绘图模式 preset 声明」守护（`id: preset-draw` / `name: '@deepseek-ai/dsh-agent-preset'` / `id: draw` / `order: 5` / `name: 绘图模式`，且 `config.plugins` 里不许有相对路径包名、不许 `complete: true`）；新增「profile 里残留的旧 `lora` 段被原样透传但不参与功能」。
- `test/registration.test.mjs`：新增 `/api/comfyui/draw-models` 路由断言（GET / buffered / 连不上时 502 + `folders:{}`）；新增「LoRA 闸指向对话栏而不是设置页」的文案断言；「开关打开后不再被拦」的用例改用 `draw:{unet:'',lora:true}`。
- `scripts/probe-features.mjs` 的 config 同步为 `draw:{unet,lora}`；`scripts/probe-client-bundle.mjs` 的断言从 3 项扩到 8 项（`ModelPicker` / `DrawBar` / `data-comfy-select` / 两条路由 / `conversation.input.left` / `data-comfy-btn` / 设置页 `loraHint` 已消失）。
- 沿用 1.0.0 的两条守护：旧包名不许复活；README 与文档里不许出现「`add` 后面直接跟包名」这种会装到别处的命令。`files` 的负向条目（`!` 开头）校验它指向的文件真实存在。
- 总数 62 → 64 → **68 条**。

### 文档

- `README.md` / `README.en.md` 新增「绘图模式」章节（模式声明、两个控件写哪个字段、为什么只在绘图模式可见、如何覆盖）；「设置页」章节删掉 LoRA 行与「刷新」按钮说明，改为草稿+保存；常见问题补「输入框左侧没有绘图控件」「点了保存没反应」两条；「踩过的坑」补「只有 volatile 字段写得进去」「槽位要靠标准 props 拿会话」。
- `README.md` / `README.en.md` 整体重写：补齐徽章、目录、示例图、特性、兼容性与已知限制、常见问题、贡献指引；安装段按「从 GitHub 装」写，并明确本包暂未发布到 npm。
- `docs/DESIGN.md` 的性能段去掉具体显存数字，`docs/DEVELOPMENT.md` 同步测试条数与新增的包名守护说明。

## [1.0.0] - 2026-11-13

首个公开版本。

### Added

- **8 个工具**，让模型能直接驱动 ComfyUI：
  - `comfy_status` —— 服务是否存活、显存余量、队列内容、最近任务的进度
  - `comfy_models` —— 列出 `diffusion_models` / `text_encoders` / `vae` / `checkpoints` / `loras` 里有哪些文件
  - `comfy_node` —— 查某个节点类接受哪些输入、默认值、取值范围、枚举值
  - `comfy_run` —— 提交任务，三种模式：`template`（文生图，可挂 LoRA）、`img2img`（图生图）、`graph`（自带 API 格式工作流）
  - `comfy_result` —— 等任务跑完、把输出图取回来交给模型看，同时报磁盘路径，可 `save_to` 另存
  - `comfy_control` —— 取消任务 / 打断当前 / 清空队列 / 释放显存
  - `comfy_review` —— 审图重生成：让指定模型看图判断是否满意，不满自动按它给的新提示词重画，循环到满意或达上限
  - `comfy_upscale` —— 用 ImageScale 算法（默认 lanczos）放大已生成的图
- **审图重生成（`comfy_review`）**：支持 `reference_prompt_id` 做**角色参考图比对** —— 把「结果图 + 参考图」两张一起交给模型，让它核对发型 / 发色 / 瞳色 / 服饰 / 配色 / 气质；返回里带每轮的判定 / 评分 / 反馈 / 新提示词。重画默认沿用底图尺寸（按 16 取整），不会把 768 的图悄悄重画成 1024 的比例。
- **设置页**（DSH 设置 → ComfyUI 桥），四组开关，改完即时生效、不用重启：审图（`enabled` / `provider` / `model` / `maxAttempts` 1–5 / `extra`）、图生图、LoRA、放大。关掉后对应工具或参数立即被拦下并提示「请在设置页开启」。
- **审图模型下拉框**：`provider` / `model` 不是手填，设置页会向宿主取一份「能看图的模型」清单（按 provider 分组）直接选，留空 = 跟随当前会话模型，右侧带「刷新」。这个下拉与审图总开关无关，没开审图也能先看清有哪些可选。
- **`GET /api/comfyui/vision-models`** 只读路由：走 `ctx.connection.fetch.register`，注册在 DSH 的信任栅栏**内部**，按 pathname 精确分发、要求 principal 是 owner。自己用 `webServer.register` 挂 `/api/...` 会被外层前缀路由先吃掉（表现是永远 401）。
- **`lib/comfy.mjs`**：纯 HTTP 客户端 + 工作流构造，**零 `@deepseek-ai/*` 依赖**，只用 Node 内置 `fetch`，能脱离 DSH 单独跑。含 `createClient` / `buildTxt2Img` / `buildImg2Img` / `buildUpscale` / `normalizeGraph` / `summarizeGraph` / `injectPrompt` / `collectImages` / `resolveModels` / `ComfyError`。
- **`outputRoot` 留空自动识别**：从 `/system_stats` 的启动参数里反推 ComfyUI 装在哪，一般不用填。
- **测试与探针**（`npm test` 纯单测，不需要 ComfyUI）：
  - `test/graph.test.mjs` —— 22 条：工作流节点数与默认值、连线必须是字符串节点 id、LoRA 插节点、img2img 的 denoise、upscale 参数校验、`normalizeGraph` 的深拷贝与拒收形状、`injectPrompt` 的定位规则、`collectImages` 摊平、`resolveModels` 的报错文案、`humanDuration`、`createClient` 的 18 个方法、`ComfyError` 字段
  - `test/registration.test.mjs` —— 18 条：导出形状（`name` / `inject` / 不能有 `default`）、8 个工具的顺序与注册字段白名单、`output.schema` 恒为宽松对象、`render` 的无图/带图/空值/混垃圾四种输入、系统提示段、路由的方法与 `cache-control`、没有 `connection` 时降级、三个开关的拦截与放行、graph 模式的四种拒收、枚举与 `required`
  - `test/config.test.mjs` —— 配置 schema 的默认值与 `maxAttempts` 边界，外加**去本地化守护**：任何文件不许出现本机 link 安装的包名前缀、作者机器的绝对路径、凭据文件硬编码；`package.json` 的开源元数据必须齐全，`files` / `exports` / `scripts` 指向的东西必须真实存在，README 里不许留显卡型号与显存实况
  - `scripts/offline.mjs`（`npm run smoke`）—— 假 ctx 跑一遍 `apply()`，用宿主的 `assertSupportedJsonSchema` 做真实 schema 校验，再冒烟每个工具的 `render`
  - `scripts/e2e.mjs`（`npm run e2e`）—— 真出图全链路：提交 → 轮询 → 取图 → 校验图片块
  - `scripts/selftest.mjs`（`npm run selftest`）—— 绕开插件直接打 ComfyUI，验 `lib/comfy.mjs`
  - `scripts/probe-route.mjs` / `probe-http.mjs` / `probe-client-bundle.mjs` / `probe-features.mjs` —— 分别验模型筛选逻辑、路由确实在信任栅栏内（带 cookie 200 / 不带 401 / 不存在 404）、浏览器拿到的 bundle 里确有新代码、四个功能开关的实际拦截
  - `scripts/env.mjs` —— 所有探针的环境入口：`COMFY_URL` / `DSH_BASE` / `DSH_CREDENTIALS` / `DSH_AUTH_COOKIE` / `DSH_HOST_MODULES` / `COMFY_LORA`。拿不到凭据就**跳过**（exit 0），不会红一片
- **`scripts/sync-github.ps1`**（`npm run sync`）：补 origin → add → 拒绝暂存区里的 `node_modules` / `.env` / `.comfy-probe` / `comfy_out` → commit → push。origin 丢了会自动从 `package.json` 的 `repository.url` 补回，换机器、换目录之后仍然一条命令能推。
- `docs/DESIGN.md`（实现层完整说明）与 `docs/DEVELOPMENT.md`（开发环境、探针矩阵、常见故障）。

### Notes

- 内置文生图模板走 `UNETLoader + CLIPLoader + VAELoader` 三件套，所以 `models/diffusion_models`、`models/text_encoders`、`models/vae` 三个目录里至少要各有一个文件。用 `checkpoints` 组织方式的，走 `mode="graph"` 传自己的工作流。
- `dependencies` 里只有 `@deepseek-ai/schemastery`（`Config` 要用它定义，设置页据此生成表单），没有别的运行期依赖，也没有 devDependencies（测试只用 `node:test`）。
