# dsh-comfyui-link

[![CI](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml/badge.svg)](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）直接驱动你自己的 ComfyUI：写提示词、调参数、搭工作流、提交任务、把出图取回来给模型看；还能指定一个「审图模型」在生图后把关，不满意就按它的意见自动重画。

> English: [README.en.md](./README.en.md)

**目录** · [它解决什么问题](#它解决什么问题) · [特性](#特性) · [工具](#工具) · [会话视图「ComfyUI」页](#会话视图comfyui页) · [绘图模式](#绘图模式) · [前置条件](#前置条件) · [安装](#安装) · [快速上手](#快速上手) · [设置页](#设置页) · [LoRA 提示词文档](#lora-提示词文档) · [配置](#配置) · [工作原理](#工作原理) · [桌面端](#桌面端) · [兼容性与已知限制](#兼容性与已知限制) · [常见问题](#常见问题) · [开发](#开发) · [踩过的坑](#踩过的坑)

## 它解决什么问题

模型本来就能写提示词，但它看不见出图。于是每次都要人来做这三件事：把提示词抄进 ComfyUI、等出图、把图拖回来给模型看。不满意还得从头再来一遍。

这个插件把这条链路做成工具：模型自己提交任务、自己等结果、自己看图，图不满意还能按审图模型的反馈重画——中间不需要人。

## 特性

- **10 个工具**覆盖从探活到出图的全链路，模型不需要你会 ComfyUI 的 HTTP API。
- **审图闭环**：出图后交给指定的视觉模型判定，不满意就按它给的新提示词重画，循环到满意或达上限；给一张参考图还能比对角色还原度。
- **自带「绘图模式」**：在标准 / 极简 / PTC / 创造之外多一个 `draw` 预设，会话一进去就是出图助手的人设，输入框左侧还有生图模型与 LoRA 开关（其余模式看不到这两个控件）。
- **设置页草稿 + 保存**：地址、审图模型、img2img / 放大开关、图片输出目录在设置页里改，本地先攒成草稿，点「保存」才写进 profile；写的是配置层，不重启 DSH 也即时生效。
- **图片输出目录可指定**：留空就只留在 ComfyUI 自己的 `output/`；选了一个目录则每次取图额外复制一份过去（同名不覆盖，自动加后缀），单次调用还能用 `save_to` 覆盖。目录不用手打 —— 设置页里只有一个「选择」按钮，点了直接弹系统文件夹选择框。
- **零宿主内部依赖**：`lib/comfy.mjs` 只用 Node 自带的 `fetch`，不 import 任何 `@deepseek-ai/*`，可以脱离 DSH 单独跑（`npm run selftest` 就是干这个）。
- **graph 模式接管任意工作流**：在 ComfyUI 里导出 API 格式的 JSON，直接交给模型跑，提示词和种子都能改。
- **Web 与 Desktop 同一个包**：桌面端（Electron）页面是 `dsh-app://app/`，插件靠能力探测切到 preload 的 `__DSH_TRANSPORT__` 与 `__DSH_DIRECTORY_PICKER__`，浏览器里仍走原来的路。
- **LoRA 提示词文档**：设置页里挑一个目录，一篇文档对应一个 LoRA；挂 LoRA 出图时会自动读对应那篇，把提示词段并进 `prompt`，并在结果里说明命中了哪篇。不选目录就一个文件都不读。
- **会话视图「ComfyUI」页**：会话顶部视图切换多一个入口，把生图工作流搬到界面上 —— 节点图可视化、图上改参重提交、浏览产出图、看队列，还能拿本机 ComfyUI 生成的任一图反查它当时的工作流。
- **可验证**：208 条纯单测 + 7 个探针脚本，全都不需要你手点。

## 工具

装上之后，模型手里会多出 10 个工具：

| 工具 | 干什么 |
| --- | --- |
| `comfy_status` | 服务活着没、显存还剩多少、队列里有什么、最近几个任务跑到哪了 |
| `comfy_models` | 有哪些模型文件可用（diffusion_models / text_encoders / vae / checkpoints / loras）。开头先报**当前绘图配置**（现在用的是哪个生图模型、LoRA 允不允许挂、提示词目录配了没有），loras 每行还会附上从同目录文档认出来的**角色别名** |
| `comfy_node` | 查某个节点类接受哪些输入、默认值、取值范围、枚举值 |
| `comfy_run` | 提交任务：`mode="template"` 文生图（可挂 LoRA）、`mode="img2img"` 图生图、`mode="graph"` 传自己的 API 格式工作流。`lora: "auto"` 会按 `prompt` 里的角色名挑一个 |
| `comfy_result` | 等任务跑完并取回输出图，图会真的交给模型看，同时报磁盘路径，也能 `save_to` 另存 |
| `comfy_control` | 取消任务 / 打断当前 / 清空队列 / 释放显存 |
| `comfy_review` | **审图重生成**：让指定模型看图判断是否满意，不满自动按它的意见重画，循环到满意或达上限；给 `reference_prompt_id` 还能比对角色还原度，也能 `save_to` 另存 |
| `comfy_upscale` | 用算法（ImageScale，默认 lanczos）放大一张已生成的图，也能 `save_to` 另存 |
| `comfy_lora_doc` | 查「LoRA 提示词」目录里的文档：给 `lora` 返回对得上那篇的 tag 段与负面段（再给 `prompt` 就按你点名的服装预演；`rest: true` 看没挑中的那几套，`full: true` 看全文），不给就列出全部。不抛错，只说明情况 |
| `comfy_inspect` | **工作流分析器**：读一份工作流 JSON（`graph` 对象或 `path` 文件路径，API / UI 格式都行），识别 Checkpoint / 三件套 / LoRA / 采样器 / 提示词 / 尺寸 / ControlNet / 输出等关键节点、建立连线关系、列出 Agent 可改参数，并诊断重复 ID / 断链 / 槽位越界 / 类型不匹配 / 缺关键输入。UI 格式的 Widget 值按位置保存、不可靠，只给参数名不绑定值；要精确改参数请用 Save (API Format) 导出。子图只报边界与节点数，不解析内部 |

### 工作流分析器 `comfy_inspect`

拿到一份 workflow JSON，先 `comfy_inspect` 看清结构再动手。它分三层：

- **格式适配**（`lib/format-adapter.mjs`）：认 API 格式 `{ "1": { class_type, inputs } }` 与 UI 格式 `{ nodes, links }`。UI 是编辑器状态，连线信息（顶层 links 表 + 节点 inputs/outputs）可靠、会转成 API 结构；Widget 值只按位置保存，**绝不**按位置绑到参数名 —— 只显示参数名与原始 `widgets_values`，并提示用 Save (API Format) 导出才能精确改值。
- **语义核心**（`lib/inspector.mjs`）：纯函数、只吃 API 图，零网络、零 UI 知识。给节点打语义标签、建边、列可改参数（全标 `confidence: exact`）、出诊断。架构断言钉死核心里不出现 `widgets_values`。
- **诊断**：六类码 —— `DUPLICATE_NODE_ID` / `DUPLICATE_LINK_ID` / `OUTPUT_SLOT_OUT_OF_RANGE` / `LINK_TABLE_MISMATCH`（输入侧与 links 表三向对账）/ `TYPE_MISMATCH` / `MISSING_REQUIRED_INPUT`。UI 连线三处（links 表、`inputs[].link`、`outputs[].links`）交叉对账，缺一处就报。top 与每个子图各算一个作用域，跨作用域同号 ID 不误报。

输出五栏：关键节点 / 连接关系 / 可改参数 / 诊断 / 子图（另有 UI 未解析参数栏）。子图只显示 id、名称、节点数、连线数、输入输出端口、边界盒与实例节点，不解析子图内部逻辑。

## 会话视图「ComfyUI」页

会话顶部视图切换里多一个 **ComfyUI**（在 对话 / 轨迹 / 上下文 / 编辑 之后）。它把生图工作流搬到界面上，三块标签：

| 标签 | 干什么 |
| --- | --- |
| 工作流 | 节点图 + 参数编辑器。节点按类别配色（LoRA / 模型加载 / 文本编码 / 潜变量 / 采样器 / VAE / 输出），每个节点带一句用途说明；点下方图例能高亮该类节点。右侧改提示词 / 宽高 / 步数 / CFG / 种子 / 采样器 / 调度器 / LoRA，点「改参重提交」直接排队重画 |
| 产出图片 | 缩略图网格，点开放大；放大层里能一键跳该图的工作流 |
| 队列 | 在跑 / 排队 / 最近完成。每行带缩略图、短 id、`#序号`、节点数、状态、尺寸、步数、提示词摘要 |

**本机图 → 工作流反查**：看本机 ComfyUI（`127.0.0.1:8188`）生成的任一图，能取回它当时用的完整工作流 —— 节点图、参数、种子、采样器全都在，并且可以直接在这个页面上改参重生成。

数据来源有两条，按顺序试：

1. **旁侧索引** `<输出根>/_dsh_meta/prompt-index.jsonl` —— 出图时把 `promptId` + `graph` + `params` + `files` 写进去，不依赖 ComfyUI 的历史是否被清掉。
2. **ComfyUI 原生历史** `GET /history/{prompt_id}` —— 索引没命中时兜底，扫 outputs 按文件名匹配。

索引里 `files` 为空的记录（只用过 `comfy_run` 提交、没调过 `comfy_result` 的任务）会在打开页面时用 `/history` 自动补全并回写；索引里压根没有的 job（比如从 ComfyUI 网页端提交的）也会从历史带上产出图。查不到就给一句可读提示，ComfyUI 没启动就给空态。

**LoRA 增删改**：LoRA 不是一个逗号文本框，而是列表 —— 每行一个 LoRA（下拉选文件 + 模型强度 + 文本强度 + 删除按钮），底部「+ 添加 LoRA」。增删会重建 model/clip 链：只改名字强度时原地改；增删重排时删掉旧节点、按新顺序串链、把 `KSampler` 的 model 与 `CLIPTextEncode` 的 clip 改指向新链尾；全删退回基座 checkpoint。

这一页与对话工具共用同一份数据源（同一个 `lib/comfy.mjs` 客户端、同一个索引文件），所以界面上看到的队列就是 `comfy_status` 看到的队列。

## 绘图模式

装好之后，新会话的模式菜单里会多一个 **绘图模式**（次序在标准 / PTC / 极简 / 创造之后）。它是一份独立的 Agent 预设，挂的是精简插件集（人格、时间、文件、压缩、提问、待办、present），人格换成「出图助手」：把需求整理成正面提示词 → `comfy_run` → `comfy_result` 取图；变体走 img2img / upscale / review。

进到这个模式的会话，**输入框左侧多两个控件**：

| 控件 | 写进哪 | 干什么 |
| --- | --- | --- |
| 生图模型下拉 | `draw.unet` | `comfy_run` / `comfy_review` 省略 `unet` 时就用它；选「自动」则用 `diffusion_models` 里第一个，没有就用 `checkpoints` 里第一个 |
| `LoRA` 胶囊 | `draw.lora` | 打开后才允许给 `comfy_run` / `comfy_review` 传 `lora`；关着时传会被拦下 |

下拉分两组，选哪一组决定用哪种加载器：

| 分组 | 来自 | 工作流 | 说明 |
| --- | --- | --- | --- |
| 扩散模型 | `models/diffusion_models` | `UNETLoader + CLIPLoader + VAELoader` | 单扩散模型，要另外有文本编码器和 VAE |
| 整合包 | `models/checkpoints` | `CheckpointLoaderSimple` | 一个文件带 MODEL/CLIP/VAE，Illustrious / 光辉 这类 SDXL 检查点属于这组 |

这两个控件是**即时写入**的（点完就生效，跟设置页的草稿+保存是两套语义）。它们只在这个模式的会话里渲染 —— 判断依据是会话的 `agentPreset` 投影等于 `draw`，别的模式完全看不到，模型也会被告知「别的模式没有这两个控件，要指定模型就显式传 `unet`，LoRA 用不了」。

**模型看不到这两个控件选了什么。** 想让它知道，就调 `comfy_models` —— 它的第一段就是「当前绘图配置」：

```
当前绘图配置
  生图模型：<你的模型>.safetensors（固定，comfy_run 传 unet 不会覆盖）
  LoRA：允许挂
  提示词文档：<你的提示词目录>（字数预算 4000；挂了 LoRA 会自动把里面挑中的 tag 段并进 prompt）
```

这三行是有用的：没有它，模型只能凭世界知识猜「该用哪个 checkpoint」「LoRA 能不能挂」，于是会出现「你明明选了 anima，它却在思考里比较 Illustrious / 光辉」这种跑偏。

### 画具体角色：`lora: "auto"`

`comfy_run` / `comfy_review` 的 `lora` 除了直接给文件名，还能传 `"auto"` —— 按 `prompt`（`comfy_review` 用 `requirement`）里出现的**角色名**去对 LoRA 名单。

对得上的依据是**别名**：文件名、文档标题，以及标题括号里的其他写法 —— 中文、日文、罗马音三种写法都算。

三条规矩：

- **只认唯一命中**。一个都没认出 → 照常出图，结果里写「没认出能对上 loras 名单的角色名」，并提示可以用 `comfy_models` 看别名。
- **认出多个就不挂**。一次说出两个角色名时会列出候选（各自命中哪个别名），让你自己挑 —— 猜错比不挂更糟。
- **认不出的写法就是认不出**。文档里没写过的假名写法（比如 `カナヲ`）、或者纯罗马音缩写，对不上。遇到这种情况把 LoRA 文件名直接传给 `lora` 就行。

顺带一提：**传了 `lora` 才会去读提示词文档**。没传 `lora` 时插件一个文件都不读 —— 结果里会明说「这次没传 lora，没读文档」，不会让你以为读了。


预设声明随插件自己的 `cordis.patch.yml` 一起发，装包即装模式，不用手改 profile：

```yaml
- insert:
    - id: preset-draw
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: draw
        name: 绘图模式
        description: 专注出图：直接描述画面，用本机 ComfyUI 生成并取回图片。
        order: 5
        plugins: [ ... ]
```

想改这个人格或换插件集，在 profile 的 `cordis.patch.yml` 里按 `preset-draw` 覆盖 `config.plugins` 即可（覆盖是**整体替换**，不会与这份默认列表合并）。

## 前置条件

- 一个跑得起来的 ComfyUI（默认按 `http://127.0.0.1:8188` 找）
- DSH `>= 0.2.0-rc.1`，Node `>= 22`
- 内置文生图模板有两种加载方式：`diffusion_models` 里有点名的模型就走 `UNETLoader + CLIPLoader + VAELoader` 三件套（那时 `models/text_encoders`、`models/vae` 至少各要有一个文件）；名字落在 `checkpoints` 里就走 `CheckpointLoaderSimple`，一个整合包文件就够（Illustrious / 光辉 这类 SDXL 检查点）。`diffusion_models` 空着也能只靠 `checkpoints` 跑。

## 安装

从 npm 装（推荐）：

```bash
dsh plugin --profile web add dsh-comfyui-link
```

想跟最新代码，从 GitHub 装：

```bash
dsh plugin --profile web add github:jx70/dsh-comfyui-link
```

本地开发（改了代码要立刻看到效果）用 clone 下来的目录：

```bash
git clone https://github.com/jx70/dsh-comfyui-link.git
dsh plugin --profile web add link:/path/to/dsh-comfyui-link
```

装完重启 DSH，打开 **新会话的模式菜单**，能看见「绘图模式」；再进 **设置 → ComfyUI 桥**，审图模型下拉能列出模型就说明通了。

装的时候 DSH 会自动把包名写进 profile 的 `dsh.profile.bundles`，**不用手改任何 yml**。

卸载：

```bash
dsh plugin --profile web remove dsh-comfyui-link
```

## 快速上手

> 在**绘图模式**的会话里说这些最省事：生图模型与 LoRA 开关就在输入框左侧。别的模式也能用，只是要显式传 `unet`、LoRA 用不了。

**一句话出图**

> 帮我画一张「雨夜窗边的小机器人，暖色台灯」，832×832，24 步

模型会调 `comfy_run`（template 模式）然后 `comfy_result` 把图拿回来。

**生图后让审图模型把关**

先在设置页把「审图」开关打开、在「选择审图模型」下拉里挑一个能看图的模型，然后：

> 画一张「蝴蝶忍」的同人图，画完让审图模型检查角色还原度，不满意就重画

模型先 `comfy_run` 出图，再调 `comfy_review`（给 `prompt_id` + 原始要求），审图模型看图判定，不满意就按它给的新 prompt 重生成，循环到满意或达到 `maxAttempts`。返回里带每轮的判定 / 评分 / 反馈 / 新 prompt。

想让它比「角色还原度」这种笼统说法更准，把参考图的 `prompt_id` 一起传进 `reference_prompt_id`：审图时会把「结果图 + 参考图」两张一起交给模型，逐项比对发型 / 发色 / 瞳色 / 服饰 / 配色 / 气质。

**图生图**

> 用刚才那张图（prompt_id xxx）重绘，把背景换成海边，denoise 0.5

模型走 `comfy_run` 的 `mode="img2img"`，`image_prompt_id` 指底图，`denoise` 控制改动幅度（越小越贴近原图）。记得先在设置页把「图生图」开关打开。

**挂 LoRA**

> 用 my_style 这个 LoRA 画一张人像，强度 0.8

模型走 `comfy_run` 的 template 模式 + `lora` / `lora_strength`。手上有哪些 LoRA 用 `comfy_models` 查。**要先在输入框左侧的绘图控件里把 `LoRA` 打开**（只在绘图模式有）。

**放大**

> 把 prompt_id xxx 那张图放大到 2048×2048

模型调 `comfy_upscale`。需要先打开放大开关。

**把自己的工作流交给它跑**

在 ComfyUI 界面上把工作流 **导出（API 格式）**，得到 `{ "节点id": { "class_type": ..., "inputs": ... } }` 这样一份 JSON，直接贴给模型：

> 用这张工作流跑一下，提示词改成「海边灯塔」，种子换 777

模型会走 `comfy_run` 的 graph 模式，提示词自动写进 `CLIPTextEncode` 节点（也可以用 `prompt_node` 指定写哪个）。graph 模式不受功能开关限制——它不依赖内置模板。

## 设置页

DSH 设置 → ComfyUI 桥。改动先在本地攒成草稿（顶部会提示「有未保存的改动」），点底部的 **保存** 才写进 profile；写完不用重启 DSH 就生效。

页面视觉与出厂设置页一致：每个分组是一张卡片（`settings-card-fill` 底 + `settings-card-stroke` 描边 + 16px 圆角），字段名与说明用主题的 `label-secondary` / `label-tertiary`，按钮和开关走 `button-primary-fill` / `brand-primary` / `switch-thumb`。**整页没有任何硬编码颜色**，亮色暗色都跟着主题变 —— 换皮肤不用改这里。

| 分组 | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| 审图 | `enabled` | 关 | 审图重生成总开关（分区标题下有一行副标题「生图后自动把关，不满意就重画」） |
| | `provider` | 空 | 审图模型 provider；留空回退当前会话模型 |
| | `model` | 空 | 审图模型 id；留空回退当前会话模型 |
| | `maxAttempts` | 1 | 最多重生成几次（1–5） |
| 功能开关 | `img2img.enabled` | 关 | 关掉时 `mode="img2img"` 会被拦下 |
| | `upscale.enabled` | 关 | 关掉时 `comfy_upscale` 会被拦下 |
| 输出 | `dir` | 空 | 图片另存目录；留空＝图只留在 ComfyUI 自己的 output 里。这里**没有输入框**，只有「选择」按钮（弹系统文件夹选择框）和一个「清除」按钮 |
| LoRA 提示词 | `dir` | 空 | 提示词文档目录；留空＝一个文件都不读。同样是「选择」/「清除」，选完下面会显示「已识别 N 篇」 |
| | `maxChars` | 4000 | 一篇文档最多并入 `prompt` 多少字（200–20000）；超了不硬切，优先在空行 / 换行 / 逗号处收口 |

`provider` / `model` 在设置页里是**一个下拉框**，不是手填：设置页打开时浏览器会向宿主取一份「能看图的模型」清单（`GET /api/comfyui/vision-models`，按 provider 分组），直接选一项即可；留空 = 跟随当前会话模型。清单在打开设置页时自动取一次，没有「刷新」按钮。这个下拉与审图总开关无关，没开审图也能先看清有哪些模型可选。

开关是**故意默认全关**的：这两个功能会各自往 ComfyUI 上多挂节点、多花时间，默认关着能保证「装上就能出一张图」，其余按需开。图生图和放大已经并进一个「功能开关」分区，不再各占一个带边框的孤块；「保存」按钮固定在面板底部（sticky），表单滚到下面也不会找不到它。

> LoRA 不在这里：它是逐次出图的选择，放在会话输入框左侧的绘图控件里（只在绘图模式可见），写 `draw.lora`。

输出目录（`output.dir`）三种取值：

| 写什么 | 图落在哪 |
| --- | --- |
| 留空 | 只留在 ComfyUI 自己的 output 目录，不额外复制 |
| 绝对路径（如 `<你的图库>/comfy`） | 原样使用，每次取图都复制一份过去 |
| 相对路径（如 `dsh/copies`） | 相对 **ComfyUI 的 output 目录**解析；认不出 ComfyUI 装在哪时会报错，让你改成绝对路径 |

判定「绝对」不走 `path.isAbsolute` —— 它在 Windows 和 Linux 上对 `X:/…` 的结论相反，所以插件用自己的 `looksAbsolute`（盘符式、`/` 开头、UNC `\\\\` 开头都算绝对），同一份配置在两个平台上结论一致。

**「选择」按钮**：设置页里这一栏**只有按钮、没有输入框**，路径只能从系统文件夹选择框里挑。点一下会向宿主发一次 `POST /api/comfyui/pick-directory`，宿主在本机拉起一个 Windows 文件夹选择框（`powershell.exe -STA` + WinForms `FolderBrowserDialog`，挂在浏览器前面弹出），挑完把路径回传给页面；旁边「清除」把已选目录清空（等于回到「图只留在 ComfyUI 的 output」）。四个细节值得知道：

- 选中的路径**只进草稿**，仍要点「保存」才落盘 —— 免得误点一下就把配置改了。
- 对话框是**阻塞式**的：请求会一直挂着等你点，插件自己给 180 秒超时。同一个窗口里连点两次，第二次会被宿主挡回（409「已经有一个选择框开着」）。
- 只在 Windows 上有。别的平台点按钮会提示「这个平台没有系统文件夹选择框，输出目录在这里设不了」，这一栏就只能靠改 profile 的 `cordis.patch.yml`（`output.dir`）来配 —— 相对路径在那里仍然按 ComfyUI 的 output 解析。
- 中文路径不走子进程 stdout（控制台代码页会写坏），而是写一个临时 UTF-8 文件再读回来。

`save_to` 是**逐次覆盖**：任何一次 `comfy_result` / `comfy_review` / `comfy_upscale` 传了 `save_to`，就按它走、不看设置页那一栏。同名文件不会被覆盖，会自动加 `-1` / `-2` 后缀。

## LoRA 提示词文档

很多角色 LoRA 自带一套「该怎么写提示词」的说明（触发词、服装、配色）。把它们写成一堆文档放进一个目录，在设置页「LoRA 提示词 → 提示词目录」里选中，**挂 LoRA 出图时插件会自己去读对应那篇，把里面的 tag 段并进 `prompt`、把「负面：」那段并进 `negative`**。

文档里的说明文字（模型信息、作者原话、踩坑清单、参数建议）**不会被并进去** —— 它们对编码器是噪声，会把角色画歪。插件逐行判定哪些是 tag，只挑那些。

**多套服装按「套」挑，绝不混套。** 很多角色文档一次列好几套衣服（`── ① 常服 / ② 女仆 / ③ 服务员 / ④ 旗袍`，或者一章挂五套），原来按「哪些段像 tag」挑会把五套的服装词**同时**并进 `prompt` —— `white shirt` + `maid` + `waitress` + `china dress` 互相打架，画出来就锁死在默认装束上，想换场景只能整个关文档。现在插件先把文档切成一「套」一「套」的互斥单元，再按你说的服装挑：说「穿女仆装」就只并女仆那一套 + 角色本体锚点；没点名服装就并锚点 + 第一套；文档里没有你说的那套（同义词桶也找不到）就只并角色本体，并在结果里明说「服装段自己写」。**换衣服场景不用再传 `lora_doc:"off"`。**

| 你会做的事 | 实际发生什么 |
| --- | --- |
| `comfy_run` 传了 `lora` | 读目录里所有文档 → 逐篇打分 → 挑最像的一篇 → 按你说的服装挑**一套** tag 段（+ 角色本体锚点）拼到 `prompt` 后面、「负面：」那段并进 `negative` → 结果文本里写明「提示词文档：xxx.md（按内容挑中…；已并入 prompt，并的是「女仆」这一套 + 锚点 42 字、共 291 字，另有 4 套没并…）」 |
| `comfy_run` 传了 `lora: "auto"` | 先按 `prompt` 里的角色名挑一个 LoRA（中文 / 日文 / 罗马音都认，见上一节），挑中后就按「传了 `lora`」那样走；认不出或认出多个就不挂，结果里说明原因 |
| `comfy_run` 用 `mode="graph"`，图里有 `LoraLoader` | 同上 —— 扫工作流里的 `LoraLoader` / `LoraLoaderModelOnly` 节点，按 `lora_name` 查文档，命中就写进正面 `CLIPTextEncode`；负面 tag 顺着 `KSampler` 的 `negative` 那一支找到对应的 `CLIPTextEncode` 写进去。不需要另外传 `lora` 参数 |
| `comfy_review` 传了 `lora` | 同上；重画时也带着这段（正面 + 负面都带），不会第二轮就丢角色设定 |
| 传 `lora_doc: "off"` | 只对这一次跳过，结果里会写一句「这次传了 `lora_doc:"off"`，跳过了文档」 |
| 没传 `lora`（但配了目录） | **一个文件都不读**，结果里补一行「这次没传 lora，没读文档。画具体角色就传 `lora:"auto"`，或直接把 LoRA 文件名给 `lora`」 |
| 设置页那一栏留空 | **一个文件都不读**，行为与没有这个功能时完全一致；但挂了 LoRA 时结果里会写「没配「LoRA 提示词」目录，这次没查文档」 |

**挂了 LoRA 就一定会有交代**：命中、没命中、目录没配、被 `off` 跳过，四种情况都会在结果文本里留一行，不会出现「不知道这次到底查没查」。

**怎么挑**：目录里可以混放各种东西（角色说明、画风笔记、随手记的 tag 清单、甚至模型文件本身），文件名也不必与 LoRA 名对齐 —— 插件把认得的文档读进来打分，按下面几项加起来排序：

| 信号 | 加分 |
| --- | --- |
| 文档和这个 LoRA 的模型文件**在同一个文件夹**里（该文件夹只有这一个模型） | +120 |
| 同一个文件夹里，但里面还并排放着别的模型 | +60 |
| 文件名与 LoRA 名一致 | +100 |
| 文件名包含 LoRA 名 | +70 |
| 所在子文件夹名与 LoRA 名一致 | +70 |
| 文件名命中 LoRA 名里的几个词 | 命中比例 × 60 |
| 正文里提到 LoRA 名（空格、下划线、连字符都抹平后比较） | +30（只命中部分词按比例 × 12） |
| 标题就是 / 包含 LoRA 名 | +35 / +25 |
| 有 `提示词` / `Prompt` 这类小标题 | +20 |
| 内容本身就是逗号分隔的 tag 串 | +12 |

判定分三档：

- **match**：最高分 ≥ 45 —— 摆放、名字或正文确实指向这个 LoRA，直接用。
- **sole**：没有够高的，但全目录只有**一篇**像提示词文档 —— 就用它，并在结果里说明「没明确提到这个 LoRA」。
- **none**：都不像 —— **什么都不并**。宁可少喂，也别把说明文字塞进 `prompt`。

只认 `.md` / `.markdown` / `.txt`，子文件夹最多往下走 3 层（按角色/画风分目录放都行，文件夹名也参与打分），单篇超过 256 KB 跳过。模型文件本身（`.safetensors` / `.ckpt` / `.pt` / `.pth` / `.bin` / `.gguf` / `.sft`）不会被当成文档读，只用来判断「这篇文档和哪个 LoRA 摆在一起」。

打分本身也有预算：**每个目录最多给前 120 篇文档打分、累计读取上限 4 MB**（都是为了不把一次出图变成扫盘）。触到上限时插件**不再往下读**，并把这个事实明说出来 —— 结果文本里会补一句「另有 N 篇没参与打分（超过 120 篇的上限：xxx、yyy、zzz …）」，`comfy_lora_doc` 也会列。日志里的「跳过的：」列的是另一回事：读失败或者超过 256 KB 的篇目。

一篇文档里写什么：

```markdown
# 银发角色

这套 LoRA 是 Belle Anima v1 训的，用在 SDXL 上。

## 提示词

masterpiece, 1girl, silver long hair, red eyes, black dress
```

有 `# 提示词` / `## Prompt` / `## 正面提示词` 这类小标题就**只看它下面那一段**（到同级或更高级标题为止），没有小标题就看全文 —— 但**看**和**并**是两件事：

**并进 prompt 的只有 tag 段，而且一次只并一套服装。** 插件把正文按空行切块、再逐行判定：一行是不是「逗号/顿号/分号分隔、段够多、几乎全是英文短串、不以句号收尾、不是中文叙述、不是表格、不带全角括号」的 tag 串。命中的行才进 `prompt`；其余（`【一】模型信息`、作者原话、拆解、踩坑清单、参数建议、`作者备注：…`）全部跳过。这样「文档写得越啰嗦，喂进去的东西越脏」这个坑就不存在了 —— 一篇一万多字的角色清单，并进去的是纯 tag，**0 个汉字**。

**挑「套」**：文档里如果是一套衣服一节（`── ① 常服` / `② 女仆` / `③ 服务员` / `④ 旗袍`，或 `① 魔女服 / ② 校服 / …`），或者是一章里靠行首中文标签挂多套（`军装 peaked cap, …` / `校服 school uniform, …`），插件会先把它们切成互斥的「套」。你 prompt 里点名的服装（中文 / 英文 tag 都认，`穿便服` → `私服` 这种同义词也认）命中哪套就只并哪套；命中组内行标签时报告会说清是哪一套（矢来美羽那种「一章挂五套」的文档）。没点名就并第一套，文档里没有就说「服装段自己写」。

**正面 / 负面自动分流。** `负面：`、`负面额外加：`、`负面（这一套要额外压短发回流）：`、`—— 可用负面词 ——`、`negative prompt:` 这几种写法都认，它下面的 tag 段并进 `negative`（与你原来的负面词合并去重，用户写的在前）；`正面：` / `positive:` 会切回正面。章节分隔（`========`、`【五】`、`▍① …`、`## …`）会把状态复位回正面，所以「负面小节夹在正面小节中间」也不会串味。

几个会顺手洗掉的杂质：段首的中文标签（`军装 peaked cap, …` → `peaked cap, …`）、方括号占位符（`[在这里写你要的服装标签]`）。

**字数预算**（设置页 `loraDocs.maxChars`，默认 4000，可调 200–20000）管的是**并进去的 tag 一共多少字**：先按套挑（命中的那套 + 角色本体锚点），装不下时不再追加别的套。如果文档只有一段 tag 而没有「套」的结构（比如就是一篇 tag 清单），就退回「按边界收口」：按**最后一个空行 → 换行 → 逗号/顿号/分号 → 空格**收口，候选位置至少占预算 60%，都不满足才硬切兜底 —— 这样不会出现 `long_hair, blue` 这种半个 tag。结果文本里会写明并的是哪一套服装、锚点多少字、共多少字、负面多少字、哪几套没并。

真实场景里很多角色文档（尤其中文的「提示词清单」）没有 `#` 小标题，只有 `【一】`/`【三】` 这种分节标记 —— 那属于「没有小标题」，照常逐行挑 tag，不受影响。

想先看一眼插件认到了什么，用 `comfy_lora_doc`：不给参数就列出目录里的候选（含子文件夹路径，并标出哪几篇像提示词），给 `lora` 就返回**打分表**与挑中那篇的 tag 段 + 负面段，并报出「并的是哪一套服装 / 共多少字 / 跳过几块说明 / 负面多少字」；再给 `prompt`（你打算用的那段）会按你点名的服装预演一遍，跟出图时实际并进去的一致；`rest: true` 看没挑中的那几套（或 plain 模式下被截掉的后半段），`full: true` 看整篇原文。这个工具**不抛错** —— 目录没配、路径写错、挑不中，都只是回一句话。

## 配置

服务地址这类静态值由插件自带的 `cordis.patch.yml` 提供，装好后就能用：

```yaml
- insert:
    - id: comfyui
      name: dsh-comfyui-link
      config:
        baseUrl: 'http://127.0.0.1:8188'   # 你的 ComfyUI 地址
```

要改地址，最省事的做法是在 profile 的 `cordis.patch.yml` 里覆盖同一段：

```yaml
- id: comfyui
  config:
    baseUrl: 'http://192.168.1.9:8188'
```

其它可选项（都可在同一处覆盖）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `timeoutMs` | `20000` | 单次 HTTP 请求超时 |
| `pollMs` | `2500` | `comfy_result` 轮询间隔 |
| `maxWaitSeconds` | `900` | 单个任务最多等多久 |
| `outputRoot` | `''` | 输出图在磁盘上的目录。**留空会自动从 `/system_stats` 的启动参数里认出 ComfyUI 装在哪**，一般不用填。这是「读」用的路径（插件据此拼原图路径、解析相对输出目录）；「另存一份」用的是设置页里的 `output.dir`。会话视图的图 → 工作流反查索引也落在这个目录下的 `_dsh_meta/prompt-index.jsonl` |

`comfy_review` 的几个细节参数：

| 参数 | 作用 |
| --- | --- |
| `reference_prompt_id` | **角色参考图**。给一个之前出过的图的 `prompt_id`，审图时会把「结果图 + 参考图」两张一起交给模型，让它比对角色还原度（发型 / 发色 / 瞳色 / 服饰 / 配色 / 气质），参考图里的多余元素不算进要求 |
| `max_attempts` | 覆盖设置页里的 `maxAttempts`（0–5） |
| `lora` / `lora_strength` | 重画时挂 LoRA（要先在输入框左侧的绘图控件里打开 LoRA），强度和 `comfy_run` 一致 |

重画默认**沿用底图的尺寸**（按 16 取整），不会把 768 的图悄悄重画成 1024 的比例。

## 工作原理

三层，彼此的边界很清楚：

- `lib/comfy.mjs` —— 纯 HTTP 客户端 + 工作流构造（`buildTxt2Img` / `buildImg2Img` / `buildUpscale` / `normalizeGraph` 等），**不 import 任何 `@deepseek-ai/*`**，能脱离 DSH 单独跑
- `index.js` —— Host 插件，注册 10 个工具 + 一段系统提示 + 导出 schemastery `Config`（设置页据此生成表单），并注册路由：`GET /api/comfyui/vision-models`（审图模型清单）、`GET /api/comfyui/draw-models`（生图模型与 LoRA 清单）、`GET /api/comfyui/lora-docs`（提示词文档清单）、`POST /api/comfyui/pick-directory`（弹系统文件夹选择框），以及会话视图用的四条 —— `GET /api/comfyui/workspace/snapshot`（在线状态 / 队列 / jobs / 最近生成 / 采样器与 LoRA 枚举）、`GET /api/comfyui/workspace/workflow`（按 `promptId` 或 `filename` 反查工作流）、`GET /api/comfyui/workspace/image`（代理产出图）、`POST /api/comfyui/workspace/submit`（改参后写回工作流再提交）
- `lib/format-adapter.mjs` —— 工作流格式适配层（UI ↔ API），含 UI 连线三向对账与子图边界识别
- `lib/inspector.mjs` —— 工作流语义分析核心（纯函数，只吃 API 图）
- `lib/workspace-store.mjs` —— 会话视图的数据层：旁侧索引读写（`prompt-index.jsonl`，原子写、坏行跳过）、参数抽取 `extractWorkflowParams`、参数写回 `applyWorkflowParams`（含 LoRA 链重建）、图 → 工作流反查 `resolveWorkflow`（索引优先 + history 兜底）
- `client.js` —— 浏览器半端，三处 UI：`settings.section` 槽位里的「ComfyUI 桥」设置页（草稿 + 保存）、`conversation.input.left` 槽位里的绘图控件（只在绘图模式渲染），以及 `conversation.view` 槽位里的 **ComfyUI 会话视图页**（节点图 / 参数编辑器 / 产出图 / 队列）

`index.js` 里除了工具，还 `import z from '@deepseek-ai/schemastery'` 用来定义 `export const Config`。所以 `dependencies` 里只有它，没有别的运行期依赖。

为什么要分成三层：工作流构造的 bug 不该需要启动整个宿主才能定位。`npm run selftest` 直接打 ComfyUI，几秒钟就能验证 `lib/` 有没有问题。设计取舍的完整说明在 [docs/DESIGN.md](./docs/DESIGN.md)。

## 桌面端

DSH Desktop（Electron）加载的是同一份 Web GUI、同一份 `client.js` —— `dsh.client.platform` 写 `web` 就够，不需要另发一套声明。差别只在**页面来源**：桌面端的页面是 `dsh-app://app/`，不是 http origin，所以相对 `/api/...` 的请求在那里解析不到宿主。插件为此做了两处适配：

| 场景 | 浏览器 | 桌面端 |
| --- | --- | --- |
| 读模型清单、调路由 | 页面自己的 `fetch` | `globalThis.__DSH_TRANSPORT__.fetch`（preload 注入，收「文档相对」路径、自己解析到宿主） |
| 「选择」目录 | 向宿主发 `POST /api/comfyui/pick-directory`，宿主 spawn `powershell.exe -STA` 弹框 | `globalThis.__DSH_DIRECTORY_PICKER__.pick()`，Electron 自己弹系统框（取消返回 `null`） |

两处都是**能力探测**：有钩子就用钩子，没有就退回浏览器那条路。所以同一个 bundle 在 Web 与 Desktop 上都能跑，插件也不需要知道自己跑在哪儿。

`hostFetch()` 会去掉前导斜杠再交给传输钩子 —— 出厂代码里 `createWebConnectionRpc` 拼的就是「channel/endpoint 去掉首斜杠」，HMR 的 `/plugins/events` 也是先 `.slice(1)` 再 fetch。别传 `/api/...` 全路径，那会被拼成 `dsh-app://app/api/...` 之类解析不到的东西。

## 兼容性与已知限制

- **验证过的 ComfyUI 版本**：0.30.2。更老的版本大概率也能跑，但 `POST /api/jobs/{id}/cancel` 这类较新的端点可能不存在——`comfy_control` 的 `cancel` 在那种版本上会报 404，`interrupt` 仍然可用。
- **只做 web 客户端**：`dsh.client.platform` 是 `web`，设置页与输入框左侧的绘图控件都要有图形界面才看得见。桌面端（Electron）加载的是同一份 Web GUI，所以照常可用；纯 CLI 场景下工具仍然可用，只是改不了开关（配置可以写在 `cordis.patch.yml` 里）。
- **内置模板认两种模型组织方式**：`diffusion_models` 里的单模型走三件套加载器，`checkpoints` 里的整合包走 `CheckpointLoaderSimple`。名字落在哪个文件夹就用哪种加载器，同名时按整合包算。`checkpoints` 里的整合包名可以直接传给 `comfy_run` 的 `unet`。
- **放大是算法放大**：`ImageScale` 的 lanczos / bicubic 等，不加载放大模型（ESRGAN 之类）。要 AI 放大就自己搭工作流走 graph 模式。
- **审图模型必须能收图**：设置页下拉里只列 `inputModalities` 含 `image` 的模型。纯文本模型选了也没用，请求会被下游拒。
- **出图是同步等待**：`comfy_result` 会在 `maxWaitSeconds` 内轮询。超时不会丢任务，再调一次就行。

## 常见问题

**装好了但工具没出现？**
重启 DSH。ESM 模块和 profile 的 bundle 列表都在启动时读，`link:` 装完不重启不生效。`dsh plugin --profile web list` 能看到包名、但模型手里没工具，多半就是没重启。

**设置页的模型清单是空的？**
说明 `GET /api/comfyui/vision-models` 没通。先确认设置页里显示的地址能连上（那是 ComfyUI 地址，不是 DSH 地址）；再确认当前会话用的 provider 有能看图的模型。清单为空但插件本身正常时，把审图的 `provider` / `model` 留空，它会回退到当前会话模型。

**输入框左侧没有绘图控件？**
那说明当前会话不是绘图模式 —— 这两个控件只挂给 `agentPreset === 'draw'` 的会话。新建会话时选「绘图模式」就有了；已有的标准 / PTC / 极简 / 创造会话不会中途冒出来（预设一旦开始对话就固定）。

**点了「保存」没反应？**
看保存行右边的提示：`保存失败` 会跟一条具体原因（多半是 `Config field "..." is not volatile`，说明那个字段没声明成 volatile，设置页写不进去）。`有未保存的改动` 说明草稿还没提交，按钮此时应该是可点的。

**`comfy_status` 报连不上？**
插件默认找 `http://127.0.0.1:8188`。ComfyUI 装在别的机器或换了端口，就在 profile 的 `cordis.patch.yml` 里覆盖 `baseUrl`（见[配置](#配置)）。

**`comfy_models` 说某个文件夹是空的？**
内置模板要的是一份能用的模型：`diffusion_models` 里有一个（那还需要 `text_encoders` / `vae` 各一个），或者 `checkpoints` 里有一个整合包。两条都空就只能用 `mode="graph"` 传自己的工作流。

**改了代码但行为没变？**
ESM 有模块缓存——改完 `lib/*.mjs` 或 `index.js` 要把插件 disable 再 enable，或者重启 DSH。改完 `client.js` 还要重启后端，客户端 bundle 有构建缓存。

## 开发

```bash
npm test                      # 纯单测：工作流构造 / 注册形状 / 配置与开源守护，不需要 ComfyUI
npm run smoke                 # 假 ctx 冒烟：注册、schema 校验、render
npm run smoke:live            # 再真调一遍只读工具（需要 ComfyUI 在跑）
npm run e2e                   # 端到端：提交 → 取图 → 校验图片块（会真出一张 512×512）
npm run selftest              # 直接对着 ComfyUI 把 lib/comfy.mjs 走一遍（只读）
npm run probe:route           # 假 ctx 抓 connection.fetch 路由，验模型筛选逻辑
npm run probe:http            # 真打 HTTP，验路由确实在信任栅栏内部
npm run probe:features        # 真出图：template / img2img / LoRA / upscale + 开关拦截
npm run probe:bundle          # 确认浏览器拿到的 client.js 里确有新代码（DrawBar / 保存按钮 / 四条路由 / 桌面端两条桥）
```

需要「真打 DSH」的探针（`probe:http` / `probe:bundle`）用环境变量找环境，取不到就跳过（exit 0），不会红一片：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `DSH_BASE` | `http://127.0.0.1:3080` | 正在跑的 DSH Web 地址 |
| `DSH_CREDENTIALS` | `<home>/.dsh/` 下的凭据文件 | DSH 凭据文件路径 |
| `DSH_AUTH_COOKIE` | 空 | 直接给一个现成 cookie，给了就不读凭据文件 |
| `DSH_HOST_MODULES` | 自动解析 | `@deepseek-ai/*` 宿主包目录（`smoke` 用它做真实 schema 校验） |
| `COMFY_LORA` | 空 | `probe:features` 要挂的 LoRA 文件名；不设就跳过 LoRA 段 |

更多细节见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)。

### 贡献

提 PR 之前跑一遍 `npm test` 和 `npm run smoke`——CI 就是这两条加上 `probe:route` 与 `npm pack --dry-run`，在 ubuntu-24.04 / windows-latest × node 22 / 24 上各跑一次（Linux 侧钉死版本号，见 [.github/workflows/ci.yml](./.github/workflows/ci.yml) 里的注释）。测试里有一组「去本地化守护」断言（不许出现作者机器的绝对路径、不许留硬件实况、不许写会装到别人包的命令），照着它的报错改就行。

改代码容易踩的坑另见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) 的「改代码的常见坑」。

## 踩过的坑

下面这些是真正花过时间的，写下来省你一次调试：

- **连线必须写字符串节点 id**：`["2", 0]` 可以，`[2, 0]` 会让 ComfyUI 在 `execution.py:933` 抛 `KeyError`。
- **不要写 `export default apply`**：`cordis-plugin-loader` 的 `unwrapExports` 会因此拿到裸函数，`inject` 等命名导出全丢，启动时报 `cannot get property "tools" without inject`。
- **改源码后要重载插件**：ESM 模块有缓存，改完 `lib/*.mjs` 需要把插件 disable 再 enable 一次才生效。
- **别用 PowerShell 管道改含中文的源码**：`Set-Content` 会把 UTF-8 写坏，直接 SyntaxError。
- **volatile 字段是引用对象**：schemastery `.volatile()` 的字段在 `apply()` 里是 cosmokit 引用对象，要用 `.get()` 解包才能拿到当前值（这样设置页与对话栏的改动才即时生效）。反过来说，**只有 volatile 字段写得进去** —— 宿主对非 volatile 路径直接抛 `Config field "..." is not volatile`。
- **img2img 要先上传底图**：`LoadImage` 只能读 ComfyUI input 目录的文件，所以 `buildImg2Img` 前要 `client.uploadImage()`（POST `/upload/image`）把底图字节传上去拿文件名。
- **模型清单路由必须走 `connection.fetch`**：不能用 `webServer.register` 自己挂 `/api/...`。DSH 把整个 `/api` 前缀挂在 connection 的信任栅栏后面，自己挂会被外层前缀路由先吃掉，表现就是永远 401。
- **前端槽位要靠标准 props 拿会话**：`conversation.input.left` 的组件能直接拿到 `sessionId` / `useSessions`，判断 preset 就照出厂 `AgentPresetLabel` 的写法读 `state.byId[sessionId].projectionValues.agentPreset`；自己的 form 句柄用注册处的 `inject: (sessionId) => ({...})` 透传。
- **别用 `path.isAbsolute` 判平台路径**：它对 `X:/…` 在 Windows 上是真、在 Linux 上是假，同一份配置两个平台结论相反。插件用自己的 `looksAbsolute`（盘符式 / `/` 开头 / UNC），`output.dir` 的解析走它。
- **改 `package.json` 别用 `Set-Content -Encoding UTF8`**：会给文件加 BOM，`npm test` 直接报 `SyntaxError: Unexpected token '﻿'`。用 node 的 `fs.writeFileSync(path, text, 'utf8')`。
- **桌面端不能裸调 `fetch('/api/…')`**：桌面页面是 `dsh-app://app/`，相对路径会解析到那个自定义协议上，请求永远打不到宿主。要么走 `globalThis.__DSH_TRANSPORT__.fetch`（路径不带前导斜杠），要么先做能力探测再退回页面自己的 `fetch`。插件里统一走 `hostFetch()`。

## 许可

[MIT](./LICENSE) · 变更见 [CHANGELOG.md](./CHANGELOG.md)
