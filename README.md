# dsh-comfyui-link

[![CI](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml/badge.svg)](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）直接驱动你自己的 ComfyUI：写提示词、调参数、搭工作流、提交任务、把出图取回来给模型看；还能指定一个「审图模型」在生图后把关，不满意就按它的意见自动重画。

> English: [README.en.md](./README.en.md)

**目录** · [它解决什么问题](#它解决什么问题) · [特性](#特性) · [工具](#工具) · [前置条件](#前置条件) · [安装](#安装) · [快速上手](#快速上手) · [设置页](#设置页) · [配置](#配置) · [工作原理](#工作原理) · [兼容性与已知限制](#兼容性与已知限制) · [常见问题](#常见问题) · [开发](#开发) · [踩过的坑](#踩过的坑)

## 它解决什么问题

模型本来就能写提示词，但它看不见出图。于是每次都要人来做这三件事：把提示词抄进 ComfyUI、等出图、把图拖回来给模型看。不满意还得从头再来一遍。

这个插件把这条链路做成工具：模型自己提交任务、自己等结果、自己看图，图不满意还能按审图模型的反馈重画——中间不需要人。

![用 template 模式生成的一张示例图](./docs/demo.png)

*上图由本插件以 `mode="template"` 在 ComfyUI 上生成（832×832 / 30 步）。*

## 特性

- **8 个工具**覆盖从探活到出图的全链路，模型不需要你会 ComfyUI 的 HTTP API。
- **审图闭环**：出图后交给指定的视觉模型判定，不满意就按它给的新提示词重画，循环到满意或达上限；给一张参考图还能比对角色还原度。
- **设置页热生效**：地址、审图模型、img2img / LoRA / 放大三个开关都在设置页里改，改完立刻生效，不用重启 DSH。
- **零宿主内部依赖**：`lib/comfy.mjs` 只用 Node 自带的 `fetch`，不 import 任何 `@deepseek-ai/*`，可以脱离 DSH 单独跑（`npm run selftest` 就是干这个）。
- **graph 模式接管任意工作流**：在 ComfyUI 里导出 API 格式的 JSON，直接交给模型跑，提示词和种子都能改。
- **可验证**：62 条纯单测 + 7 个探针脚本，全都不需要你手点。

## 工具

装上之后，模型手里会多出 8 个工具：

| 工具 | 干什么 |
| --- | --- |
| `comfy_status` | 服务活着没、显存还剩多少、队列里有什么、最近几个任务跑到哪了 |
| `comfy_models` | 有哪些模型文件可用（diffusion_models / text_encoders / vae / checkpoints / loras） |
| `comfy_node` | 查某个节点类接受哪些输入、默认值、取值范围、枚举值 |
| `comfy_run` | 提交任务：`mode="template"` 文生图（可挂 LoRA）、`mode="img2img"` 图生图、`mode="graph"` 传自己的 API 格式工作流 |
| `comfy_result` | 等任务跑完并取回输出图，图会真的交给模型看，同时报磁盘路径，也能 `save_to` 另存 |
| `comfy_control` | 取消任务 / 打断当前 / 清空队列 / 释放显存 |
| `comfy_review` | **审图重生成**：让指定模型看图判断是否满意，不满自动按它的意见重画，循环到满意或达上限；给 `reference_prompt_id` 还能比对角色还原度 |
| `comfy_upscale` | 用算法（ImageScale，默认 lanczos）放大一张已生成的图 |

## 前置条件

- 一个跑得起来的 ComfyUI（默认按 `http://127.0.0.1:8188` 找）
- DSH `>= 0.2.0-rc.1`，Node `>= 22`
- 内置文生图模板走 `UNETLoader + CLIPLoader + VAELoader` 三件套，所以 ComfyUI 的 `models/diffusion_models`、`models/text_encoders`、`models/vae` 三个目录里至少要各有**一个**文件。用 `checkpoints` 的组织方式也能用 —— 那种情况请走 `mode="graph"` 传自己的工作流。

## 安装

从 GitHub 装：

```bash
dsh plugin --profile web add github:jx70/dsh-comfyui-link
```

本地开发（改了代码要立刻看到效果）用 clone 下来的目录：

```bash
git clone https://github.com/jx70/dsh-comfyui-link.git
dsh plugin --profile web add link:/path/to/dsh-comfyui-link
```

装完重启 DSH，打开 **设置 → ComfyUI 桥**，点一下「刷新」——能列出模型就说明通了。

装的时候 DSH 会自动把包名写进 profile 的 `dsh.profile.bundles`，**不用手改任何 yml**。

卸载：

```bash
dsh plugin --profile web remove dsh-comfyui-link
```

> 暂未发布到 npm。别用 `add` 后面直接跟包名那种写法——registry 上没有这个包，装不到东西。

## 快速上手

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

模型走 `comfy_run` 的 template 模式 + `lora` / `lora_strength`。手上有哪些 LoRA 用 `comfy_models` 查。需要先打开 LoRA 开关。

**放大**

> 把 prompt_id xxx 那张图放大到 2048×2048

模型调 `comfy_upscale`。需要先打开放大开关。

**把自己的工作流交给它跑**

在 ComfyUI 界面上把工作流 **导出（API 格式）**，得到 `{ "节点id": { "class_type": ..., "inputs": ... } }` 这样一份 JSON，直接贴给模型：

> 用这张工作流跑一下，提示词改成「海边灯塔」，种子换 777

模型会走 `comfy_run` 的 graph 模式，提示词自动写进 `CLIPTextEncode` 节点（也可以用 `prompt_node` 指定写哪个）。graph 模式不受上面三个开关限制——它不依赖内置模板。

## 设置页

DSH 设置 → ComfyUI 桥。改完即时生效，不用重启。

| 分组 | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| 审图 | `enabled` | 关 | 审图重生成总开关 |
| | `provider` | 空 | 审图模型 provider；留空回退当前会话模型 |
| | `model` | 空 | 审图模型 id；留空回退当前会话模型 |
| | `maxAttempts` | 1 | 最多重生成几次（1–5） |
| | `extra` | 空 | 额外审图要求（如「角色必须还原银色长发」） |
| 图生图 | `enabled` | 关 | 关掉时 `mode="img2img"` 会被拦下 |
| LoRA | `enabled` | 关 | 关掉时 `comfy_run` 的 `lora` 参数会被拦下 |
| 放大 | `enabled` | 关 | 关掉时 `comfy_upscale` 会被拦下 |

`provider` / `model` 在设置页里是**一个下拉框**，不是手填：设置页打开时浏览器会向宿主取一份「能看图的模型」清单（`GET /api/comfyui/vision-models`，按 provider 分组），直接选一项即可；留空 = 跟随当前会话模型。清单右侧有「刷新」按钮，新装了 provider 或换了账号可以点一下重取。这个下拉与审图总开关无关，没开审图也能先看清有哪些模型可选。

开关是**故意默认全关**的：这三个功能会各自往 ComfyUI 上多挂节点、多花时间，默认关着能保证「装上就能出一张图」，其余按需开。

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
| `outputRoot` | `''` | 输出图在磁盘上的目录。**留空会自动从 `/system_stats` 的启动参数里认出 ComfyUI 装在哪**，一般不用填 |

`comfy_review` 的几个细节参数：

| 参数 | 作用 |
| --- | --- |
| `reference_prompt_id` | **角色参考图**。给一个之前出过的图的 `prompt_id`，审图时会把「结果图 + 参考图」两张一起交给模型，让它比对角色还原度（发型 / 发色 / 瞳色 / 服饰 / 配色 / 气质），参考图里的多余元素不算进要求 |
| `max_attempts` | 覆盖设置页里的 `maxAttempts`（0–5） |
| `lora` / `lora_strength` | 重画时挂 LoRA（需先打开 LoRA 开关），强度和 `comfy_run` 一致 |

重画默认**沿用底图的尺寸**（按 16 取整），不会把 768 的图悄悄重画成 1024 的比例。

## 工作原理

三层，彼此的边界很清楚：

- `lib/comfy.mjs` —— 纯 HTTP 客户端 + 工作流构造（`buildTxt2Img` / `buildImg2Img` / `buildUpscale` / `normalizeGraph` 等），**不 import 任何 `@deepseek-ai/*`**，能脱离 DSH 单独跑
- `index.js` —— Host 插件，注册 8 个工具 + 一段系统提示 + 导出 schemastery `Config`（设置页据此生成表单），并注册 `GET /api/comfyui/vision-models` 只读路由给设置页取模型清单
- `client.js` —— 浏览器半端，往 `settings.section` 槽位注册「ComfyUI 桥」这一页，用 `configForms` 读写 volatile 字段

`index.js` 里除了工具，还 `import z from '@deepseek-ai/schemastery'` 用来定义 `export const Config`。所以 `dependencies` 里只有它，没有别的运行期依赖。

为什么要分成三层：工作流构造的 bug 不该需要启动整个宿主才能定位。`npm run selftest` 直接打 ComfyUI，几秒钟就能验证 `lib/` 有没有问题。设计取舍的完整说明在 [docs/DESIGN.md](./docs/DESIGN.md)。

## 兼容性与已知限制

- **验证过的 ComfyUI 版本**：0.30.2。更老的版本大概率也能跑，但 `POST /api/jobs/{id}/cancel` 这类较新的端点可能不存在——`comfy_control` 的 `cancel` 在那种版本上会报 404，`interrupt` 仍然可用。
- **只做 web profile**：`dsh.client.platform` 是 `web`，设置页要有浏览器才看得见。纯 CLI 场景下工具仍然可用，只是改不了开关（开关可以写在 `cordis.patch.yml` 里）。
- **内置模板只走三件套加载器**：`UNETLoader + CLIPLoader + VAELoader`。如果你的模型是整包 `checkpoints`，用 `mode="graph"` 传自己的 `CheckpointLoaderSimple` 工作流。
- **放大是算法放大**：`ImageScale` 的 lanczos / bicubic 等，不加载放大模型（ESRGAN 之类）。要 AI 放大就自己搭工作流走 graph 模式。
- **审图模型必须能收图**：设置页下拉里只列 `inputModalities` 含 `image` 的模型。纯文本模型选了也没用，请求会被下游拒。
- **出图是同步等待**：`comfy_result` 会在 `maxWaitSeconds` 内轮询。超时不会丢任务，再调一次就行。

## 常见问题

**装好了但工具没出现？**
重启 DSH。ESM 模块和 profile 的 bundle 列表都在启动时读，`link:` 装完不重启不生效。`dsh plugin --profile web list` 能看到包名、但模型手里没工具，多半就是没重启。

**设置页里「刷新」点了没反应，或者模型清单是空的？**
说明 `GET /api/comfyui/vision-models` 没通。先确认设置页里显示的地址能连上（那是 ComfyUI 地址，不是 DSH 地址）；再确认当前会话用的 provider 有能看图的模型。清单为空但插件本身正常时，把审图的 `provider` / `model` 留空，它会回退到当前会话模型。

**`comfy_status` 报连不上？**
插件默认找 `http://127.0.0.1:8188`。ComfyUI 装在别的机器或换了端口，就在 profile 的 `cordis.patch.yml` 里覆盖 `baseUrl`（见[配置](#配置)）。

**`comfy_models` 说某个文件夹是空的？**
内置模板要 `diffusion_models` / `text_encoders` / `vae` 三样都有货。缺哪个就补哪个，或者改用 `mode="graph"` 用自己的工作流。

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
npm run probe:bundle          # 确认浏览器拿到的 client.js 里确有新代码
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

提 PR 之前跑一遍 `npm test` 和 `npm run smoke`——CI 就是这两条加上 `probe:route` 与 `npm pack --dry-run`，在 ubuntu / windows × node 22 / 24 上各跑一次。测试里有一组「去本地化守护」断言（不许出现作者机器的绝对路径、不许留硬件实况、不许写会装到别人包的命令），照着它的报错改就行。

改代码容易踩的坑另见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) 的「改代码的常见坑」。

## 踩过的坑

下面这些是真正花过时间的，写下来省你一次调试：

- **连线必须写字符串节点 id**：`["2", 0]` 可以，`[2, 0]` 会让 ComfyUI 在 `execution.py:933` 抛 `KeyError`。
- **不要写 `export default apply`**：`cordis-plugin-loader` 的 `unwrapExports` 会因此拿到裸函数，`inject` 等命名导出全丢，启动时报 `cannot get property "tools" without inject`。
- **改源码后要重载插件**：ESM 模块有缓存，改完 `lib/*.mjs` 需要把插件 disable 再 enable 一次才生效。
- **别用 PowerShell 管道改含中文的源码**：`Set-Content` 会把 UTF-8 写坏，直接 SyntaxError。
- **volatile 字段是引用对象**：schemastery `.volatile()` 的字段在 `apply()` 里是 cosmokit 引用对象，要用 `.get()` 解包才能拿到当前值（这样设置页热编辑才即时生效）。
- **img2img 要先上传底图**：`LoadImage` 只能读 ComfyUI input 目录的文件，所以 `buildImg2Img` 前要 `client.uploadImage()`（POST `/upload/image`）把底图字节传上去拿文件名。
- **设置页的模型清单必须走 `connection.fetch`**：不能用 `webServer.register` 自己挂 `/api/...`。DSH 把整个 `/api` 前缀挂在 connection 的信任栅栏后面，自己挂会被外层前缀路由先吃掉，表现就是永远 401。

## 许可

[MIT](./LICENSE) · 变更见 [CHANGELOG.md](./CHANGELOG.md)
