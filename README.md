# dsh-comfyui-link

[![CI](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml/badge.svg)](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）直接驱动你自己的 ComfyUI：写提示词、提交任务、把出图取回来给模型看；还能指定一个审图模型在生图后把关，不满意就按它的意见自动重画。

> English: [README.en.md](./README.en.md)

## 特性

- **12 个工具**覆盖探活 → 能力发现 → 出图 → 取图 → 审图 → 放大 → 工作流分析 → 工作流知识学习，模型不用懂 ComfyUI 的 HTTP API。
- **能力发现**：`comfy_capabilities` 按任务用途（去遮挡 / 抠图 / 换背景 / 局部改）反查本机真实存在的模型与节点，避免 agent 凭世界知识滑向 Python/rembg 硬做。
- **审图闭环**：出图交给指定视觉模型判定，不满意按它给的新提示词重画，循环到满意或达上限；给参考图还能比对角色还原度。
- **绘图模式**：多一个 `draw` 预设，输入框左侧带生图模型与 LoRA 开关。
- **LoRA 提示词文档**：指定一个目录，挂 LoRA 出图时自动挑中对应那篇，把 tag 段并进 `prompt`、负面段并进 `negative`。
- **会话视图「ComfyUI」页**：节点图可视化、图上改参重提交、浏览产出图、看队列，还能拿本机生成的图反查当时的工作流。
- **零宿主内部依赖**：`lib/comfy.mjs` 只用 Node 自带 `fetch`，可脱离 DSH 单独跑。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `comfy_status` | 服务活着没、显存、队列、最近任务 |
| `comfy_models` | 可用的模型文件清单（带能力标签与本机能力线索）；开头报当前绘图配置，loras 附角色别名 |
| `comfy_capabilities` | 按任务用途反查本机能力与配套节点；遇陌生图任务先查它 |
| `comfy_node` | 查节点类的输入、默认值、取值范围；也可传关键词列候选 |
| `comfy_run` | 提交任务：`template` 文生图（可挂 LoRA）/ `img2img` 图生图 / `graph` 传自己的 API 工作流 |
| `comfy_result` | 等任务跑完取回图（真的交给模型看），报磁盘路径，可 `save_to` |
| `comfy_control` | 取消 / 打断 / 清空队列 / 释放显存 |
| `comfy_review` | 审图重生成，可传 `reference_prompt_id` 比对角色还原度 |
| `comfy_upscale` | 算法放大（默认 lanczos） |
| `comfy_lora_doc` | 查提示词文档：打分表、挑中的 tag 段与负面段 |
| `comfy_inspect` | 工作流分析：识别关键节点、连线、可改参数、诊断（重复 ID / 断链 / 槽位越界 / 类型不匹配 / 缺输入） |
| `comfy_learn` | 持久化工作流知识库：`learn` / `recall` / `list` / `get` / `feedback`，积累并复用工作流经验 |

## 前置条件

- 一个跑得起来的 ComfyUI（默认 `http://127.0.0.1:8188`）
- DSH `>= 0.2.0-rc.1`，Node `>= 22`
- 内置模板两种加载方式：`diffusion_models` 里的模型走三件套（`UNETLoader + CLIPLoader + VAELoader`，需 `text_encoders` / `vae` 各一个）；`checkpoints` 里的整合包走 `CheckpointLoaderSimple`，一个文件就够

## 安装

```bash
dsh plugin --profile web add dsh-comfyui-link          # npm（推荐）
dsh plugin --profile web add github:jx70/dsh-comfyui-link   # 跟最新代码
dsh plugin --profile web add link:/path/to/dsh-comfyui-link             # 本地开发
```

装完重启 DSH：新会话的模式菜单里能看见「绘图模式」，设置 → ComfyUI 桥里审图模型下拉能列出模型就通了。卸载用 `remove`。

## 快速上手

在**绘图模式**的会话里说这些最省事（生图模型与 LoRA 开关就在输入框左侧）；别的模式也能用，只是要显式传 `unet`、LoRA 用不了。

| 想要 | 说什么 | 走哪条 |
| --- | --- | --- |
| 出图 | 「画一张雨夜窗边的小机器人，暖色台灯，832×832，24 步」 | `comfy_run` → `comfy_result` |
| 审图 | 「画蝴蝶忍，画完让审图模型检查角色还原度，不满意就重画」 | `comfy_review`（先在设置页开审图） |
| 图生图 | 「用刚才那张重绘，背景换海边，denoise 0.5」 | `comfy_run` `mode="img2img"`（先开开关） |
| 挂 LoRA | 「用 my_style 画一张人像，强度 0.8」 | `comfy_run` + `lora`（先在绘图控件里打开 LoRA） |
| 放大 | 「把那张放大到 2048×2048」 | `comfy_upscale`（先开开关） |
| 跑自己的工作流 | 导出 API 格式 JSON 贴给模型 | `comfy_run` `mode="graph"`，不受开关限制 |

## 设置页

DSH 设置 → ComfyUI 桥。改动先攒成草稿，点**保存**才写进 profile，不用重启即生效。

| 分组 | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| 审图 | `enabled` | 关 | 审图重生成总开关 |
| | `provider` / `model` | 空 | 审图模型（下拉只列能收图的）；留空跟随当前会话模型 |
| | `maxAttempts` | 1 | 最多重画几次（1–5） |
| 功能开关 | `img2img.enabled` | 关 | 关掉时 `mode="img2img"` 被拦 |
| | `upscale.enabled` | 关 | 关掉时 `comfy_upscale` 被拦 |
| 输出 | `dir` | 空 | 图片另存目录，留空只留在 ComfyUI 自己的 output；只能点「选择」挑，没有输入框 |
| LoRA 提示词 | `dir` | 空 | 提示词文档目录，留空一个文件都不读 |
| | `maxChars` | 4000 | 一篇文档最多并入多少字（200–20000） |

开关默认全关是故意的：装上就能出一张图，其余按需开。`save_to` 是逐次覆盖，同名文件自动加 `-1` / `-2` 后缀。

## LoRA 提示词文档

把角色说明写成一堆 `.md` / `.txt` 放进一个目录，在设置页选中。挂 LoRA 出图时插件按内容给每篇打分，挑最像的一篇，**只把 tag 段并进 `prompt`、「负面：」那段并进 `negative`** —— 说明文字（模型信息、作者原话、踩坑清单）不会进提示词。

- **多套服装按「套」挑**：说「穿女仆装」就只并女仆那套 + 角色本体锚点，不会把校服、旗袍一起塞进去互相打架。
- **`lora: "auto"`**：按 `prompt` 里的角色名对 LoRA 名单（中文 / 日文 / 罗马音都认），只认唯一命中；认出多个或认不出就不挂，结果里说明原因。
- **没传 `lora` 就不读文档**，结果里会明说。
- 想先看认到了什么，用 `comfy_lora_doc`（不给参数列候选，给了给打分表，`rest: true` / `full: true` 看更多）。

## 工作流知识库（comfy_learn）

分析过的工作流可以长期积累，下次有类似需求时让模型先检索、再复用，并根据真实运行结果不断完善。知识库落在 `<ComfyUI output>/_dsh_meta/workflow-knowledge/`（`index.json` + `records/wf_*.json`），重启后仍在；与 `prompt-index.jsonl` 完全分开。

一个工具、五种 `action`：

| action | 干什么 |
| --- | --- |
| `learn` | 学习新工作流：`graph` / `path` / `prompt_id` 三选一，附 `knowledge` 语义总结，返回 `workflow_id` |
| `recall` | 按自然语言需求检索（`query`），返回候选 + 匹配原因；推荐 ≠ 可直接执行 |
| `list` | 列出已学档案，可按 `keyword` / `tag` / `status` 过滤 |
| `get` | 按 `workflow_id` 读完整档案；`include_graph: true` 取原始 Graph（不可恢复时明确说明） |
| `feedback` | 把一次真实运行/审图/用户评价作为独立事件追加，不覆盖历史 |

实际可跑的示例（模型侧调用）：

```text
# 学一份工作流
comfy_learn { "action": "learn", "graph": <工作流JSON>, "name": "保结构放大",
  "knowledge": { "purpose": ["保留原图结构的图像放大"], "use_cases": ["图像修复"] } }
# → 记下返回的 workflow_id，如 wf_2f673adb85a453a9

# 查询已学工作流
comfy_learn { "action": "recall", "query": "保留原图结构的放大工作流", "limit": 5 }

# 读取完整知识档案
comfy_learn { "action": "get", "workflow_id": "wf_2f673adb85a453a9" }

# 把一次实际运行结果记为反馈
comfy_learn { "action": "feedback", "workflow_id": "wf_2f673adb85a453a9",
  "prompt_id": "<comfy_run 返回的 id>", "execution_outcome": "completed",
  "quality_assessment": "approved", "assessment_source": "user", "feedback": "效果很好" }
```

说明：Inspector 产生的事实（节点/连线/诊断）由插件生成，模型只补语义解释；`store_graph` 默认 false，不把提示词全文/图片路径写进知识库；执行状态与质量评价分开记（`completed` 不会自动变成 `approved`）。检索命中后仍需重新检查本机节点/模型依赖，确认适用才调用 `comfy_run`。

## 配置

静态值由插件自带的 `cordis.patch.yml` 提供。改地址就在 profile 的 `cordis.patch.yml` 里覆盖同一段：

```yaml
- id: comfyui
  config:
    baseUrl: 'http://192.168.1.9:8188'
```

其它可选：`timeoutMs`（20000）、`pollMs`（2500）、`maxWaitSeconds`（900）、`outputRoot`（留空自动从 `/system_stats` 认出 ComfyUI 装在哪，一般不用填）。

## 已知限制

- 验证过的 ComfyUI 版本 0.30.2；更老版本上 `comfy_control` 的 `cancel` 可能 404，`interrupt` 仍可用。
- 放大是算法放大（`ImageScale`），不加载 ESRGAN 之类的放大模型；要 AI 放大就走 graph 模式。
- 出图同步等待，`comfy_result` 在 `maxWaitSeconds` 内轮询；超时不会丢任务，再调一次即可。
- 设置页与输入框左侧控件是 Web UI，纯 CLI 下工具可用但改不了开关（配置写 `cordis.patch.yml`）。

## 开发

```bash
npm test              # 纯单测，不需要 ComfyUI
npm run smoke         # 假 ctx 冒烟
npm run smoke:live    # 再真调一遍只读工具
npm run e2e           # 端到端：提交 → 取图 → 校验图片块
npm run selftest      # 直接对着 ComfyUI 走一遍 lib/comfy.mjs
npm run probe:route   # 假 ctx 抓路由，验模型筛选
npm run probe:http    # 真打 HTTP，验路由在信任栅栏内
npm run probe:features # 真出图：template / img2img / LoRA / upscale
npm run probe:bundle  # 确认浏览器拿到的 client.js 里有新代码
```

提 PR 前跑 `npm test` 和 `npm run smoke`。设计取舍见 [docs/DESIGN.md](./docs/DESIGN.md)，改代码的坑与环境变量见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)。

## 许可

[MIT](./LICENSE) · 变更见 [CHANGELOG.md](./CHANGELOG.md)
