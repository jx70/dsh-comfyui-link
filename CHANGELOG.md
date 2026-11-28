# Changelog

All notable changes to this project are documented here.
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.15.0] - 2026-11-28

主题 **Knowledge Reliability**：修复 `comfy_learn` 知识系统在隐私、路径、一致性、恢复与并发上的问题。

### 安全修复（P0）

- **路径安全**：`comfy_learn` 与 `comfy_inspect` 的 `path` 来源改为共用 `lib/safe-json-file.mjs` 的安全读取 —— 只接受 `.json`/`.jsonl` 绝对路径，拒绝 URL、NUL、相对路径、符号链接、非普通文件与超过 16 MiB 的文件；`realpath` 后必须落在 ComfyUI 输出根或工作区 `workflows`/`workflow`/`工作流`/`examples`/`example` 目录内；错误文案稳定、不回显真实路径。
- **隐私清理**：新增 `sanitizeValue()` 递归脱敏，覆盖 Inspector 事实（`keyNodes`/`edges`/`editable_parameters`/`diagnostics`/`warnings`/`subgraphs`/`unresolved`）、feedback 的 `feedback` 文本与 `parameter_changes`、知识字段与 provenance 的 `details`；绝对路径、UNC、token/key/password 赋值、sk-/ghp_/JWT 形态全部处理。`get include_graph=false` 时返回对象 `stripGraphFromRecord()` 去掉 `graph_storage.graph/snapshot` 与顶层 `graph/graphData/workflow`，文本与对象两条路径都不夹带 Graph。

### 数据可靠性（P1/P2）

- **Graph 恢复**：`prompt-index` 与 `history` 来源统一记为 `prompt-index-reference`/`history-reference`，`get include_graph=true` 时两者都先查 prompt-index、再走 ComfyUI `/history` 兜底恢复，恢复不到就明说，不伪造可执行工作流；`graph_available` 统一语义（快照 true / 引用类有 prompt_id 则可能 / 否则 false），recall 摘要同步。
- **provenance 落盘**：`learn` 新增 `provenance` 参数（source 限定 inspector/object_info/agent/user/runtime/comfy_review），落盘 `recorded_at`/`object_info_checked`/`details`，默认 `agent`，不把推测标记为 inspector/runtime；旧档案读取时补 `provenance(legacy:true)`/`graph_available`/`created_at`，不改动磁盘原文。
- **feedback 原子事务**：新增 `recordFeedback()`，在同一 workflow 锁内完成「状态/统计更新 + 事件追加 + index 摘要同步」，替代此前调用方的「get → apply → upsert → appendExperience」四步分离写法，消除中途失败留下的半成品；不同 workflow 的记录写并行、共享 index 在全局锁内读最新再改，不丢更新。
- **跨来源去重**：指纹分离 `source_hash`（来源工件）与 `structure_hash`（结构身份），`workflow_id` 改由 `structure_hash` 生成；`graph`/`path`/`prompt_id` 同一结构归一到同一档案，优先按 `structure_hash` 命中，未命中再按 `source_hash` 兼容旧档案，更新时保留 experiences。
- **索引一致性**：`list()` 逐条比对 index 与 records，`workflow_id`/摘要不一致时从 records 修复并标 `source:'repaired'`；`atomicWrite()` 改为同目录 `.tmp` 子目录内 `wx` 独占写 + `fsync` + rename，目标占用时有限重试，不再先删目标文件。
- **并发声明**：`comfy_learn` 的 `isConcurrencySafe()` 从 `true` 改为 `false`，保守声明避免两个 feedback 并发时宿主缓存层覆盖；`comfy_inspect` 保持只读安全。

### 测试

- 新增 `test/security.test.mjs`（15 项）：路径安全（单元 + 两个工具集成、符号链接环境受限时显式跳过）、递归脱敏、Graph 不泄露、provenance、旧记录兼容、并发 feedback、跨来源去重、index 修复、history-reference 恢复；`package.json` 的 test 脚本纳入该文件。
- 全量测试：基线 267 项 → 修改后 282 项（281 通过 / 0 失败 / 1 跳过），旧测试全部保持通过。

## [1.14.0] - 2026-11-28

### 新增

- **产出图片 / 队列可删图**：会话视图的「产出图片」「队列」两个标签，以及放大弹窗，每张图下方新增红色「删除图片」按钮。点击后确认 → 删磁盘文件 → 从 `prompt-index.jsonl` 摘掉这条 files 项 → 记入 `_dsh_meta/deleted-images.json`，刷新后不再出现。
  - Host 侧新增 `POST /api/comfyui/workspace/delete`；`workspaceStore.removeImage()` 做三重防线：`safeFilename` 拒纯文件名以外的输入、`subfolder` 拒绝 `..`/`\`/前导 `/`、`resolve()` 后必须仍落在 ComfyUI output 根（或 temp 兄弟目录）内。删不存在的文件视为成功（幂等）。
  - 已删名单参与快照过滤：索引记录、history 补全、**history 合成记录**、jobs 缩略图四处都过滤，避免 ComfyUI 原生 `/history` 有这条记录时删完刷新又冒出来。
- **指定模型失败即停，不自动换模型**：`comfy_run` / `comfy_review` 在用户点名 `unet`（或绘图控件已选模型）时以 `strict` 模式解析模型 —— 模型不存在、认不出系列、配套编码器/VAE 匹配不到都直接报错返回，不再静默用文件夹里第一个模型兜底；错误文案附带「没有换模型，请把错误直接告诉用户」的提示。选「自动」时行为不变。

### 修复

- **产出图片里老图会消失**：快照此前用 `workspaceStore.recent(20)` 只取最近 20 条索引记录，老图被挤掉、只能靠 `/history` 兜底，history 被清就彻底不见。改为取全部索引记录（`recent` 上限 100 → 2000）。
- **索引并发写丢记录**：`prompt-index.jsonl` 的 read-modify-write 无锁，`append` / `updateFiles` / `removeImage` 并发时后写会用旧快照覆盖先写，导致记录和图片间歇性丢失。新增进程内写队列 `withWriteLock`，把三个入口的读改写串行化。
- **只存在于 `/history` 的图删不掉**：`historyToRecord` 合成的展示记录没经过删除过滤，删掉后下次刷新又被合成回来。现在合成记录同样过滤已删名单，过滤后无图则不合成。

### 测试

- 新增删除路由与 `removeImage` 用例（删文件/摘索引/记名单/子目录/幂等/拒绝路径穿越/非法文件名 400）、history 合成记录删除不复活回归、并发 append 20 条不丢记录、并发 append+updateFiles 混跑不丢图、strict 模式 6 项用例。全套 268 条测试通过。

## [1.13.0] - 2026-11-28

### 新增

- **持久化工作流学习系统 `comfy_learn`（第 12 个工具）**：让 DSH Agent 能长期积累、检索、复用工作流知识，并按真实运行证据不断完善。一个工具五种 action：
  - `learn`：从 `graph` / `path` / `prompt_id` 三选一学习工作流，复用 `parseWorkflow` + `inspectWorkflow` 生成事实，Agent 只补语义知识；`prompt_id` 先查 prompt-index、未命中走 `/history` 兜底并标注来源；稳定 `workflow_id` + SHA-256 指纹去重（同名不同结构不覆盖，相同内容更新档案并保留历史反馈）。
  - `recall`：本地确定性检索（无向量库），按名称/用途/标签/节点类型/步骤/参数指导/经验综合加权排序，返回匹配原因；推荐 ≠ 可直接执行。
  - `list` / `get`：列出/读取知识档案，`get` 的 `include_graph` 默认关闭，按「快照→prompt-index 引用→明确提示不可用」三级返回，不伪造可执行工作流。
  - `feedback`：每次评价作为独立事件追加，不覆盖历史；执行状态与质量评价分开（`completed` 不自动 `approved`），区分评价来源（user / comfy_review / agent_observation），关联 prompt_id。
- **独立持久化存储 `lib/workflow-knowledge-store.mjs`**：落在 `<ComfyUI output>/_dsh_meta/workflow-knowledge/`（`index.json` + `records/wf_*.json`），与 `prompt-index.jsonl` 完全分开；原子写、index 损坏从 records 重建、单档案损坏隔离、进程内写队列防并发丢更新、单档案大小与经验条数上限；输出根无法确定时明确报错，不伪造保存成功。新增 `lib/learning.mjs`（指纹/校验/脱敏/排序/状态机纯函数）。
- **隐私与安全**：`store_graph` 默认 false，不保存完整正/负提示词、图片路径与令牌；知识内容一律视为数据非指令，不执行工作流代码、不自动跑未知工作流、不自动装节点/下模型、不未经确认删记录。
- **系统提示词**：新增「新工作流学习 / 旧工作流复用 / 运行后反馈」三段规则，强调知识检索与实际执行是两步、无 `comfy_run` 的 profile 不宣称可执行。

### 测试

- 新增 `test/learning.test.mjs`（三来源互斥、API/UI 学习、去重、脱敏、store_graph 开关、recall 排序、get 恢复、feedback 全枚举与不覆盖）与 `test/workflow-knowledge-store.test.mjs`（初始化、持久化、index 损坏恢复、单档案隔离、原子写、并发、上限、root 缺失）；扩展 `test/registration.test.mjs`（工具数 11→12）。全套 255 条测试通过。

## [1.12.0] - 2026-11-28

### 新增

- **能力发现层，防止 agent 遇陌生模型误判**：新增 `lib/capabilities.mjs`（能力词典 + `slimObjectInfo` / `findCapabilities` / `labelModel` / `searchNodes` 纯函数），object_info 裁剪后进程内缓存 5 分钟，避免反复拉 2.3MB 全量。
  - 新增第 11 个工具 `comfy_capabilities`：按任务用途（去遮挡 / 抠图 / 换背景 / 局部重绘 / 文生图 / 放大 / controlnet）反查本机真实存在的模型文件与节点类名、一句用途提示与关键输入；object_info 拿不到时降级为「内置词典 + 文件名」经验候选并标注未连本机验证；多候选全列不替用户选。
  - `comfy_models` 每个模型按文件名模式附能力标签，并从 object_info 生成「本机能力线索」段，末尾提示遇陌生图任务先查能力、别直接上 Python/rembg/GrabCut。
  - `comfy_node` 完整类名查不到时按关键词（如 qwen / inpaint / rmbg）从 object_info 列候选节点，打破「不知道类名就无从下手」的鸡生蛋。
  - 系统提示固化「先查本机能力再动手」纪律和参考图指令编辑引导（qwen_image + TextEncodeQwenImage21 graph 直出，不必先算蒙版）。

### 文档

- **README 精简**：`README.md` 从 497 行 / 46.7 KB 压到 128 行 / 5.6 KB，`README.en.md` 从 487 行 / 48.2 KB 压到 118 行 / 7.8 KB。只留必要内容：特性、工具表、前置条件、安装、快速上手（改成「想要 / 说什么 / 走哪条」一张表）、设置页、LoRA 提示词文档、配置、已知限制、开发、许可。
- 删掉的是实现细节（`comfy_inspect` 三层架构与六类诊断码、会话视图三块标签逐条说明、文档打分表、tag 判定与服装切套算法、设置页视觉 token、文件夹选择框的四个细节、桌面端两条 preload 桥对照、常见问题 7 条、踩坑 12 条），这些在 `docs/DESIGN.md` 与 `docs/DEVELOPMENT.md` 里都有，README 末尾各留了一个链接指过去。
- 顺手修一处笔误：英文版把 `ESRGAN` 写成了 `ESRM`。

## [1.11.2] - 2026-11-27

### 修复

- **三件套模型错配**：`diffusion_models` 里的单模型走 `UNETLoader + CLIPLoader + VAELoader` 时，CLIP 固定取 `text_encoders[0]`、VAE 固定取 `vae[0]`，且 `CLIPLoader.type` 写死 `stable_diffusion`。本机混装 SDXL / SD3 / Flux 时会用错文本编码器或编码类型。现在按模型文件名推断系列（flux / sd3 / sdxl / sd15 / hunyuan / cascade），据此匹配对应的 CLIP 与 VAE、设置正确的 `CLIPLoader.type`；优先级为**显式指定 > 系列推断 > 文件夹第一个兜底**。整合包（`checkpoints`）走 `CheckpointLoaderSimple` 不受影响。
- **搭配提醒**：选不出的系列、Flux / SD3 需要多个文本编码器的情况，会在 `comfy_run` / `comfy_review` 结果里输出一行「搭配提醒」，不再静默错配。
- **新参数 `clipType`**：`comfy_run` 可显式指定 `CLIPLoader.type`（合法值从 ComfyUI `/object_info/CLIPLoader` 动态读取）；绘图模式的 `draw` 配置也支持 `clipType` / `clip` / `vae` 覆盖。`mode="graph"` 传自定义工作流时不受影响。
- 新增回归用例（Flux 自动搭配、非法 type 报错、显式覆盖、无匹配兜底），全量 215/215 测试通过。

## [1.11.1] - 2026-11-22

### 修复

- **没有旁侧索引的机器（换了电脑）产出图片页 / 工作流选择列表空白**：此前这两处只读旁侧索引 `generated`，索引文件不存在时列表为空；队列因走 `jobs[].images` 正常有图。现在快照时用 ComfyUI 原生 `/history` 把有产出图的任务合成成生成记录补进 `generated`（带 `graph` / `params` / `files`、不落盘），三处共用同一份数据：产出图片页能出缩略图、工作流选择列表能出缩略图并可直接点选（带 graph 免反查）、队列保持正常。合成记录按 `createdAt` 排在索引记录之后，索引里已有的按 prompt_id 去重补全逻辑不变。
- 新增回归用例：`snapshot` 路由在无索引时把 `/history` 里有图的任务合成进 `generated`（209/209 测试通过）。

## [1.11.0] - 2026-11-22

### 新增

- **会话视图「ComfyUI」页**：会话顶部视图切换多一个 ComfyUI 选项，把生图工作流搬到界面上，不用再靠对话调工具看。
  - **工作流节点图**：分层 DAG 布局（无入边排最左，依赖依次往右），自绘 SVG 贝塞尔连线 + 箭头，节点按 7 类配色（LoRA / 模型加载 / 文本编码 / 潜变量 / 采样器 / VAE / 输出）。每个节点带一句用途说明（14 种具体节点各有文案，未命中按类别兜底），参数键值直接显示在节点体上。
  - **颜色图例可点**：点某个类别高亮该类节点、其余变暗，再点取消；切换工作流自动清空高亮。
  - **图上改参重提交**：提示词 / 负面提示词 / 宽 / 高 / 步数 / CFG / 种子 / 采样器 / 调度器 / LoRA 都能改。采样器与调度器是从 `object_info` 取的枚举下拉，不用手打；宽高为 0 时按 1024 兜底，`EmptySD3LatentImage` / `EmptyFluxLatentImage` 等 latent 节点也能正确读出尺寸。
  - **LoRA 增删改**：LoRA 从「一个逗号文本框」换成列表编辑器 —— 每行一个 LoRA（下拉选文件 + 模型强度 + 文本强度 + 删除按钮），底部「+ 添加 LoRA」。增删会重建 model/clip 链：只改名字强度时原地改；增删重排时删掉旧节点、按新顺序串链、把 KSampler 的 model 与 CLIPTextEncode 的 clip 改指向新链尾；全删退回基座 checkpoint。
  - **浏览产出图片**：缩略图网格 + 点开放大（Lightbox），放大层里能直接跳该图的工作流。
  - **队列视图**：在跑 / 排队 / 最近完成三段。每行带缩略图、短 id、`#序号`、节点数、状态、尺寸、步数、提示词摘要；点缩略图放大看图，右侧按钮才跳工作流。
- **本机图 → 工作流反查**：看本机 ComfyUI 生成的任一图，能取回它当时用的完整工作流（节点图 + 参数 + 种子/采样器）并基于它改参重生成。
  - 旁侧索引 `<输出根>/_dsh_meta/prompt-index.jsonl`：出图时把 `promptId + graph + params + files` 写进去，不依赖 ComfyUI 历史是否被清。
  - 索引没命中时走 ComfyUI 原生 `GET /history/{prompt_id}` 兜底，扫 outputs 按文件名匹配。
  - 索引里 `files` 为空的记录（只用过 `comfy_run` 提交、没调过 `comfy_result` 的任务）会在快照时用 `/history` 自动补全并回写；索引里没有的 job（例如从 ComfyUI 网页端提交的）也会从历史带上产出图。
  - 查不到给可读提示（不抛错），无历史 / ComfyUI 未启动时给空态。
- **四条工作区路由**：`GET /api/comfyui/workspace/snapshot`（在线状态 + 队列 + jobs + 最近生成 + 采样器/调度器/LoRA 枚举）、`GET /api/comfyui/workspace/workflow`（按 `promptId` 或 `filename` 反查）、`GET /api/comfyui/workspace/image`（代理产出图，校验文件名防路径穿越）、`POST /api/comfyui/workspace/submit`（改参后写回工作流再提交）。全部走 `connection.fetch.register`，与对话工具共用同一份数据源。

### 变更

- `client.js` 新增第三处槽位注入：`conversation.view`（`id: comfyui-workspace`，`order: 60`）。
- `comfy_run` / `comfy_review` / `comfy_upscale` 的提交点统一走 `submitAndIndex()`，提交成功即写索引；`comfy_result` 取到图后回填文件名。
- `comfy_run` 的 `title` 参数会记进索引，作为工作流选择列表里的名字。

### 测试

- 新增 `test/workspace-view.test.mjs`（15 条）：参数抽取 / 写回 / LoRA 链重建 / 文件名校验、索引 append / 查询 / 坏行跳过 / 去重合并、反查三分支（索引命中 / history 兜底 / 查不到）、4 条路由注册与行为。
- 全套 **208** 条通过。

## [1.10.1] - 2026-11-21

### 变更

- **设置页精简**：删掉「额外审图要求」（`review.extra`）字段及其对应功能（schema / 配置读取 / 审图提示词拼接 / 设置页控件 / 文档全链路清除）。
- **保存按钮固定在页首、颜色恒定**：保存栏从页尾移到页首且不再随滚动移动；按钮颜色固定为蓝色（与 dsh-bili-scroll 的 `#3b82f6` 对齐），有无未保存改动都不变色。
- **统一蓝色**：开关选中态、LoRA chip、focus 边框统一走 `--comfy-accent`（`#3b82f6`）。
- **删掉选项卡片边框**：审图 / 功能开关 / 图片输出 / LoRA 提示词四个分区只留底色 + 圆角，无描边。
- **精简提示小字**：所有 note / hint 压到一行内（中英文 32 条），去掉冗余修饰、保留关键约束。

### 测试

- 同步更新配色 / 卡片 / 配置守护断言；全套 **193** 条通过。

## [1.10.0] - 2026-11-21

### 新增

- **工作流分析器 `comfy_inspect`**：读一份工作流 JSON（`graph` 对象或 `path` 文件路径，API / UI 格式都认），自动识别 Checkpoint / 三件套 / LoRA / 采样器 / 提示词 / 尺寸 / ControlNet / 输出等关键节点，建立连线关系，列出 Agent 可改参数，并对结构做诊断。输出五栏：关键节点 / 连接关系 / 可改参数 / 诊断 / 子图（另有 UI 未解析参数栏）。
- **三层架构**：`lib/format-adapter.mjs` 负责格式适配（UI ↔ API），`lib/inspector.mjs` 是纯函数语义核心（只吃 API 图，零网络、零 UI 知识），`index.js` 的 `comfy_inspect` 负责编排渲染。核心里的架构断言钉死 `widgets_values` 等 UI 概念不得渗透。
- **UI Widget 不做位置映射**：UI 格式的 Widget 值只按位置保存，按位置绑到参数名必然错位、会给 Agent 错误信息。分析器只给参数名与原始 `widgets_values`，不绑定值，并提示用 Save (API Format) 导出才能精确改值；被连线覆盖的 widget 不进可改参数。
- **六类结构诊断**：`DUPLICATE_NODE_ID` / `DUPLICATE_LINK_ID` / `OUTPUT_SLOT_OUT_OF_RANGE` / `LINK_TABLE_MISMATCH` / `TYPE_MISMATCH` / `MISSING_REQUIRED_INPUT`。UI 连线对 links 表、`inputs[].link`、`outputs[].links` 三处交叉对账，缺一处就报；top 与每个子图各算一个作用域，跨作用域同号 ID 不误报。
- **子图基本识别**：只报 id、名称、节点数、连线数、输入输出端口、边界盒与实例节点，不解析子图内部逻辑、不并入顶层参数。

### 测试

- 新增 `test/inspector.test.mjs`（7 条：节点分类 / API 图校验 / 连线 / 四类诊断 / 可改参数 / 汇总与文本 / 架构断言）与 `test/format-adapter.test.mjs`（12 条：双格式识别 / UI 结构提取 / 误映射回归 / 重复 ID / 槽位越界 / 三向对账 / 类型不匹配 / 缺输入 / 跨作用域隔离 / 子图识别 / 不改原图 / 坏结构报错）。`test/registration.test.mjs` 加 `comfy_inspect` 注册与冒烟断言，工具数 9 → 10。

## [1.9.1] - 2026-11-20

### 修复

- **首发 npm**：README / README.en / cordis.patch.yml 的安装命令改为 `dsh plugin --profile web add dsh-comfyui-link`，保留 GitHub / link 两种；测试里的「禁止写 npm 安装命令」守护改为「必须有 npm 安装命令且不再说未发布」。
- **轮询卡住不再空转到 deadline：`client.job` 返回 null 时改用三级兜底**：排队任务被取消（dequeue）或历史被挤出后，`/api/jobs/{id}` 变 404，旧逻辑用 `?? job` 保留旧状态一直空等。现在 `/api/jobs` 查不到就先看 `history`（有记录视为完成），再看 `/queue` 是否还在跑/排队，三处都没有才判「状态丢失」并给可读文案。
- **`submitAndFetch` 超时不再抛误导性的「历史里没有输出」**：到 deadline 还在跑时改为抛明确超时错误，带已等时长、最后状态、队列快照，并指路 `comfy_status` 查 prompt_id 和加大 `comfy_result` 的 `wait_seconds`；状态丢失也单独报错，只有真正 finished 才去取图。
- **`comfy_result` 超时文案补全信息**：从「再调一次、wait_seconds 给大一点」升级为带已等时长、最后状态、队列正在跑/排队条数、`comfy_status` 查 prompt_id 的可读提示；状态丢失走单独文案。
- **状态字段归一，堵住「状态异常但任务已完」的死等**：把 `error`/`execution_error`→failed、`interrupted`/`execution_interrupted`→cancelled、`running`→in_progress 等各版本写法归一；遇到没见过的非空状态，只要 history 有记录就当完成，不再抱着看不懂的状态空等。
- `submitAndFetch` 与 `comfy_result` 的轮询收敛到共享的 `waitForJob`（`createJobWaiter`），两处判断一致；`AbortSignal` 触发时 `sleep` 与 `client.job` 都带 signal，取消立即生效、不留悬挂 await。

### 测试

- 新增 `test/polling-k37.test.mjs`（7 条）：正常状态推进、job 变 null 但 history 有记录、三处找不到判丢失、`wait_seconds` 到期超时文案、`AbortSignal` 快速取消、`normalizeStatus` 归一、源码快照断言超时分支先于取图。全套 164 → **171** 条全绿。

## [1.9.0] - 2026-11-15

### 修复

- **多套服装按「套」挑，不再把五套衣服同时并进 prompt**：上一版「只有 tag 段会并进」解决了散文污染，但挑段是「块级」的 —— 一篇列了 `── ① 常服 / ② 女仆 / ③ 服务员 / ④ 旗袍 / ⑤ 外套` 的文档，会把这五套的服装词**同时**并进 prompt（`white shirt` + `maid` + `waitress` + `china dress` + `fur-trimmed coat` 互相打架），画出来就锁死在默认装束上；这是用户报「这次生图为什么跳提示词了」的深层原因 —— 绘图 agent 为了换场景只能传 `lora_doc:"off"` 把文档整个关掉。
  - 现在先把文档切成互斥的「套」（一套衣服一节，或一章挂五套靠行首中文标签切 units），再按你说的服装挑**一套** + 角色本体锚点。说「穿女仆装」只并女仆那一套，说「穿便服」走同义词桶命中「常服/私服」，文档里没有的（连同义词也找不到）就只并角色本体并明说「服装段自己写」。没点名就并锚点 + 第一套。
  - 实测并进字数大幅下降，五套不再混；「穿女仆装 / 穿便服 / 穿和服」正确区分。**换衣服场景不用再传 `lora_doc:"off"`。**
  - 结果文本与 `comfy_lora_doc` 都改成「并的是「女仆」这一套 + 角色本体锚点，另有几套没并」的口径；`rest: true` 在 tags 模式下列「没挑中的那几套」。
- **只有真正的 tag 段会并进 `prompt`，说明文字不再混进去**：这是「画出来不像、好像没看提示词」的病根。之前取段是「按文档顺序截前 N 字」，一篇冗长的角色清单里，开头恰好是 `【一】模型信息` / `【二】作者原话` / `拆解` / `作者备注` / `⚠️ 唯一例外` —— 真正的 tag 段（`【六】可直接复制的完整 prompt`、五套服装）反被挤到门外。实测那次提交的正面提示词里混进了大量汉字，服装、发型全被散文带偏。
  - 现在按空行切块、再逐行判定：一行要同时满足「逗号/顿号/分号分隔、段数 ≥3、几乎全是短 ASCII 片段、不以句号收尾、汉字占比 ≤20%、不是表格、不带全角括号」才算 tag 行。命中的行进 `prompt`，其余（模型信息、作者原话、踩坑清单、参数建议、`作者备注：…`）全部跳过。
  - 多份真实文档回归：不同长度、不同写法的清单都能正确切出 tag 段，**汉字占比全部归零**；全部走 tags 模式。
- **文档里的「负面：」并进 `negative`，不再当正面词喂**：认 `负面：`、`负面额外加：`、`负面（这一套要额外压短发回流）：`、`—— 可用负面词 ——`、`negative prompt:` 几种写法（前置装饰 `—`/`-`/`═`/`=`/`#`/`*`/`▍` 都吃掉），其下的 tag 段并进 `negative prompt`，与你原有的负面词合并去重（用户写的在前，不换行追加 —— 负面词重复会互相抵消）。`正面：` / `positive:` 切回正面。
- **章节分隔复位正负态**：`========`、`【五】`、`▍① …`、`## …`、`方案 A` 这类行把状态复位回正面。没有这一步，某份文档里一处 `负面：` 会把后面好几处 `正面：` 的服装段全算成负面（实测负面词暴涨、正向段所剩无几）。
- **顺手洗掉两类杂质**：段首中文标签（`军装 peaked cap, …` → `peaked cap, …`）与方括号占位符（`[在这里写你要的服装标签]`）—— 前者曾是 6 个汉字混进 `prompt` 的来源，后者是模板文档里的待填坑。
- **`tagOverlap` 去重从 `min` 归一改成 `max` 归一**：3 个词的短段原本会把整段长 tag 判成「重复」（短段与长段有大量共同 tag，min 归一接近 1.00），因此只挑出少数几段；改成 max 归一后段数恢复正常，且不再误杀。
- **一段就超预算时不再整篇白读**：`pickPromptBlocks` 原来「一段装不下就全丢」，正文只有一行超长 tag 的文档会返回空串，上层显示「整篇都是空白」。现在兜底取分最高的那段、按边界切到预算内，`partial: true` 标出来，剩下的进 `rest`。

### 新增

- **按「套」挑段**：`comfy_run` / `comfy_review` 会把这次的 `prompt`（`comfy_review` 用 `requirement`）传进文档解析，先把文档切成互斥的「套」（`parseOutfitGroups`：L1 章节标题开新组、L2 子块、`── ①/②/③` 软标题、行首中文标签切 units），再用 `chooseOutfitGroups` 按你点名的服装挑一套 + 角色本体锚点。服装同义词桶（`常服≈私服≈便服≈日常服≈casual`、`校服≈制服` 等 8 个桶）让「穿便服」也能命中「常服/私服」。命中组内行标签时报告会说清是哪一套。
- **`comfy_lora_doc` 报的是「按套挑」口径**：`并的是「女仆」这一套 + 锚点 42 字、共 291 字（另有 4 套没并）` + `负面：305 字（挂 LoRA 出图时会并进 negative prompt）`，正文之后单列一段 `── 负面（negative prompt）──`。`rest: true` 在 tags 模式下列「没挑中的那几套」（不再有「后半段」这个概念），plain 模式仍是「被截掉的后半段」。
- **`comfy_lora_doc` 多一个 `prompt` 参数**：传了就按你点名的服装预演一遍挑套结果，跟 `comfy_run` 实际并进去的一致 —— 不然默认视图按原文顺序挑第一套，看到一个和出图时不一样的组合会以为是 bug。

### 新增（`lora: "auto"`：按角色名自动挂 LoRA）

- **`comfy_run` / `comfy_review` 的 `lora` 支持 `"auto"`**：按 `prompt`（`comfy_review` 用 `requirement`）里出现的角色名去对 LoRA 名单，唯一命中才挂，挂上之后照常读那篇文档、把 tag 段并进 `prompt`、负面段并进 `negative`。
- **别名覆盖中文 / 日文 / 罗马音**：`星野梦梦（星野 ゆめ / Hoshino Yume）` 这样一行标题会同时产出 `星野梦梦` / `星野 ゆめ` / `星野` / `ゆめ` / `Hoshino Yume` / `Hoshino` / `Yume` 七个别名；文件名（`yume-anima` → `yume`）、同目录文档的标题、标题括号里的其他写法都算来源。实测 `画个星野梦梦`、`星野 ゆめ を描いて`、`hoshino yume` 三种写法都指向 `yume-anima.safetensors`。繁简不用转 —— 文档标题里两种写法通常并排出现。
- **认不出就不挂，认出多个也不挂**：一个都没认出 → 照常出图，结果里写「没认出能对上 loras 名单的角色名（看了 N 个 lora）」并指路 `comfy_models`；认出 ≥2 个 → 列候选（各自命中哪个别名）让你自己挑。**猜错比不挂更糟**，所以不替你选。
- **`comfy_models` 开头报「当前绘图配置」**：用的是哪个生图模型（固定 / 自动 + 实际取哪个）、LoRA 允不允许挂、提示词目录配了没有、字数预算多少。loras 每行还会附上从同目录文档认出来的角色别名。

### 修复（模型为什么会「瞎猜」）

- **系统提示与人格里不再点名某个 checkpoint**：原来那句「`checkpoints`（像 Illustrious / 光辉 这类 SDXL 检查点）」会被模型当成推荐项 —— 实测用户明明选了 `anima-base-v1.0`，模型在思考里却在比较「Illustrious 类对 danbooru tag 认知更好」。现在改成「你**看不到**那边选了什么，想知道就调 `comfy_models`，别凭世界知识猜」。
- **`preset-draw` 人格里那句「LoRA 没开就不要给 `comfy_run` 传 lora，也不要承诺能挂 LoRA」删掉了**：这是绘图模式 agent 不敢传 `lora` 的直接来源 —— 它看不到开关状态，于是一律不传，结果既不挂 LoRA 也不读文档（`comfy_run` 查文档整块被 `if (args.lora)` 短路），而结果文本里连一句提示都没有。现在改成「画具体角色就传 `lora:"auto"`」。
- **没传 `lora` 时结果里补一行交代**：`提示词文档：这次没传 lora，没读文档。画具体角色就传 lora:"auto"…`。之前这种情况静默 —— 用户看到图不对，完全不知道插件根本没读文档。
- **`lora: "auto"` 认不出时不会把字符串 `"auto"` 当文件名用**：清成 `undefined`，否则既会去查一篇「叫 auto 的 LoRA」的文档，又会在工作流里插一个 `lora_name="auto"` 的 `LoraLoader` 节点（这条被测试抓到）。


### 变更

- **字数预算的含义收窄了**：`loraDocs.maxChars` 现在管「并进去的 tag 一共多少字」，不再是「原文从头切到多少字」。默认仍是 4000、范围仍是 200–20000；只是这份预算现在全花在 tag 上，散文本来就不占。多套服装的文档里，预算用来装「命中的那套 + 角色本体」，不再追加别的套。
- **`extractPromptSection` 仍在，但降级为兜底**：文档里一个 tag 行都没有时（纯散文的说明、或结构完全认不出的写法）才走「整篇按边界收口」，行为与 1.8.0 一致。新增的 `tagishLine` / `parsePromptBlocks` / `parseOutfitGroups` / `chooseOutfitGroups` / `promptWords` / `pickPromptBlocks` / `composeDocSection` / `composeNegative` / `findNegativeNode` 都导出，纯函数、可单测。

### 测试

- 单测 130 → **153** 条：
  - `test/lora-docs.test.mjs` 22 → **39**：新增 `tagishLine`（真 tag 串 / 中文叙述 / 表格 / 全角括号 / 中文标签混排 五种判据）、`parsePromptBlocks`（正负分流、跨块延续、章节标题复位、行内 tag、占位符清洗、`对策：负面里写死 …` 不被当小标题）、`promptWords`（停用词与权重数字不算）、`pickPromptBlocks`（贴题优先 / 装不下进 `unpicked` / 仍按原文顺序拼 / 单段超预算兜底 / 短段不误杀长段）、`composeDocSection`（tags 与 plain 两种模式）、`composeNegative`（合并去重、用户词在前、不换行）、`findNegativeNode`（顺 `KSampler.negative` 找、不靠节点序号猜、坏 link 返回 `null`）；别名匹配 6 条 —— `docAliases`（中文 / 日文 / 罗马音三写法齐全）、`docAliases` 不把 `Base outfit` 这类小节名当角色、`normalizeAlias` 归一等价、`loraAliases` + `matchLoraForPrompt` 三种语言写法挑中同一个 LoRA、认不出与多命中都不返回 `pick`、`describeDrawConfig` 的「固定 / 自动 / 已关 / 没配目录」四种措辞。
  - `test/registration.test.mjs` 36 → **42**：`comfy_lora_doc` 的长文档用例拆成「多段 tag 装不下时 `rest` 给出没并进去的那几段」与「整篇只有一段超长 tag 时按边界切到预算内（不整篇白读）」两条，前者断言散文绝不出现、后者断言不再回「整篇都是空白」；另加「传 `prompt` 就按贴题程度预演」—— 同一个目录、同一份预算，`prompt` 说 `school uniform` 就挑校服那套、说 `battle uniform` 就挑战斗服那套，跟 `comfy_run` 实际并进去的一致；graph 模式用例的断言从「并进的是原文前缀」改成「每一个并进去的 tag 都必须是原文里的完整 tag」—— tags 模式会按贴题重排，不再是前缀，但「不切半个 tag」这条底线不变。`lora:"auto"` 四条：`comfy_models` 报当前绘图配置、且 description 里不再出现 `光辉` / `Illustrious`；没传 `lora` 时有「这次没读文档」的交代；中文角色名 auto 到罗马音文件名并真的读了那篇文档（断言提交的正面节点含文档 tag、图里有 `LoraLoader`）；认不出与认出多个都不挂（断言两次提交的图里都没有 `LoraLoader`）。

## [1.8.0] - 2026-11-15

### 新增

- **LoRA 提示词文档的字数上限可调**：设置页「LoRA 提示词」多一栏 **字数预算**（`loraDocs.maxChars`，默认 **4000**，可调 **200–20000**）。原来写死的 1200 字对中文角色卡太紧 —— 一篇「模型信息 + 通用 prompt + 一两套服装」的清单轻松超过 1200，后半段被直接砍掉，而用户几乎发现不了。4000 覆盖「通用 prompt + 一套服装」，20000 留「整篇塞进去」的余地。
- **`comfy_lora_doc` 新增 `rest: true`**：看「超过上限、没并进 prompt」的那部分原文。`full: true`（整篇）照旧；两者同时为真时 `full` 优先。默认视图仍只给收口后的那一段 —— 一万字的清单整篇塞回上下文代价太大。

### 修复

- **超长文档不再从字符中间硬切**：改成按边界收口，依次找 **最后一个空行 → 换行 → 逗号/顿号/分号 → 空格**；候选位置必须至少占到预算的 **60%**（`LORA_DOC_BOUNDARY_MIN_RATIO`，否则宁可往下一档接着找，免得为了「一个逗号」白扔一半预算），四档都不满足才硬切兜底。之前 `long_hair, blue` 这种半个 tag 会原样进 prompt，把编码器往别处带。
- **结果里说清并了多少**：`comfy_run` / `comfy_review` 的文档说明行从「+123 字」升级成「并进 X / 原文 Y 字，上限 Z，切在空行边界，余下 W 字没并 —— 想看整篇传 `full:true`，只看后段传 `rest:true`」；全篇都在预算内时则明说「全篇并进去了」。原文长度、并进长度、切在哪种边界、剩多少，四项都摆出来，不用猜。
- **打分被静默截断这件事也有交代**：`rankLoraDocs` 触到「前 120 篇 / 累计 4 MB」两道闸时记下 `stoppedBy`，结果文本与 `comfy_lora_doc` 都会补一句「另有 N 篇没参与打分（超过 120 篇的上限 / 4 MB 的读取预算：前三个名字…）」。之前触到闸就是安静地少看几篇，用户完全不知道。
- `comfy_lora_doc` 默认视图的字数行改成「并进 prompt X / 原文 Y 字（上限 Z，切在…；余下 W 字没并）」，并在截断时提示 `rest:true` / `full:true` 两个出口。

### 变更

- **README 里不再放示例图**：删掉 `docs/demo.png` 与中英 README 里的那张 `template` 模式示例图（连图注一起），`package.json` 的 `files` 里对应的 `!docs/demo.png` 排除项也一并去掉 —— 文件都没了，不必再排除。
- 设置页「字数预算」输入框自己夹取 200–20000（宿主对越界的 volatile 值直接硬拒绝，把整个插件配置卡住），数字被清空时回退到 4000 而不是 1。

### 测试

- 单测 121 → **130** 条：
  - `test/lora-docs.test.mjs` 18 → **22** 条：`extractPromptSection` 的返回形状从三键扩到六键（`text` / `truncated` / `heading` / `totalChars` / `keptChars` / `cut`）；新增「边界太靠前就换下一档」（上限 20 时逗号位置不达标，退到空格收口）、「`keptChars ≤ maxChars` 且 `truncated ⟺ cut !== ''`」的不变量（上限 200/201/250/400 四档）、`promptBody` 的独立用例，以及「触到扫描上限时记 `stoppedBy` 并列出没打分的篇目」（5 篇 + `limit: 2` → 剩 3 篇被点名，且点名的确实没读过；没触上限时两个字段都是空）。
  - `test/config.test.mjs` 29 → **31**：默认值断言带上 `maxChars: 4000`；自定义值用例加 `maxChars: 6000`；新增「Config 拒绝越界的 `loraDocs.maxChars`（200–20000）」—— 100 / 99999 / 3000.5 / `'3000'` 全部抛 `maxChars`，200 / 8000 / 20000 通过；另加「设置页真的能改字数预算」，把「控件在不在、进没进 `EDITABLE`、夹取范围是不是 200–20000、清空回退是不是 4000」四件事一起钉住 —— 只在 schema 里加字段而忘了设置页，用户永远改不到。
  - `test/registration.test.mjs` 33 → **36**：原「graph 模式查文档」拆成两条（长文档按边界收口并写明字数 / 短文档全篇并入），长文档那条断言「并进 prompt 的这段是原文前缀，且原文紧随字符是分隔符」—— 直接验证「没切半个 tag」；另加 `comfy_lora_doc` 的 `rest: true` 两条（长文档给后半段、短文档回「没有剩余内容」）；两条路由用例补断言 `body.maxChars`（没配目录时是 4000，配了 6000 时回 6000）。
- `scripts/probe-client-bundle.mjs` 25 → **26** 项：新增 `loraDocsBudget = data-comfy-budget`，确认设置页的字数预算控件真的上线了。

## [1.7.0] - 2026-11-14

### 变更

- **设置页视觉对齐出厂设置页**：原来是一串「分段线 + 硬编码蓝色」的朴素表单，现在改用出厂设置页（模型 / 账号 / 插件清单）的同一套语言：
  - **卡片分块**：每个分区从 `border-bottom` 分隔线改成独立卡片 —— `.5px solid var(--dsw-alias-settings-card-stroke)` + `background: var(--dsw-alias-settings-card-fill)` + `border-radius: var(--dsw-radius-xl)`（16px）+ `padding: 12px 14px`，面板宽度 640 → 720px（对齐出厂 `.section`）。
  - **字号层级**：分区标题 14px/500/22px、字段名 12px/500/18px + `label-secondary`、说明与状态 12px/18px + `label-tertiary`；新增面板总标题（16px/500）与一行说明 —— 之前一进设置就直接是「审图」卡片，没有抬头。
  - **输入框与选择器**：`.5px solid var(--dsw-alias-border-l4)` + `border-radius: var(--dsw-radius-md)` + `height: 32px` + `background: var(--dsw-alias-bg-layer-1)`；两个下拉框（审图模型、生图模型）加 `appearance: none` 与内联 SVG 箭头，不再依赖浏览器默认外观。
  - **按钮**：「保存」改成出厂主按钮规格（`height: 36px` / `padding: 0 14px` / `button-primary-fill` / `label-primary-foreground` / hover `button-primary-hover`）；「选择」是次按钮（`border-l3` 描边、透明底、hover `interactive-bg-hover`）；「清除」是危险文字按钮（hover `interactive-bg-hover-danger` + `state-error-primary`）。三者 focus-visible 统一 `box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`。
  - **开关**：开启态用 `var(--dsw-alias-brand-primary)`、滑块用 `var(--dsw-alias-switch-thumb)`，跟随主题反色。
  - **「功能开关」分区**：两个开关从上下堆叠改成 `grid` 自适应并排的小卡片（`auto-fit / minmax(220px, 1fr)`）。
  - **对话栏绘图控件**：生图模型下拉 26px 高、`border-l3` 描边、`bg-layer-1` 底色、自带 12px 箭头；LoRA 芯片改成圆角小按钮（开 = 品牌色实心，关 = 描边）。
  - **保存条**：加 `border-top` 与 `bg-base` 底色 —— 卡片化之后若还是透明底，滚动时会透出卡片内容。
  - 保存成功的状态文字改用 `state-success-primary` 上色（`data-comfy-status[data-ok]`）。

### 修复

- **设置页里所有硬编码颜色都清掉了**：`#3b82f6`（品牌蓝，12 处）、`#ef4444`（错误红，4 处）、`#93c5fd`（focus 蓝，1 处）、`#fff`（按钮前景与滑块）一律换成主题 token —— 换主题（含暗色）时整页会跟着变，不再出现局部不跟随的情况。
- 输入框、路径框、下拉框的底色从 `var(--dsw-specific-selector, rgba(128,128,128,.14))` 换成 `var(--dsw-alias-bg-layer-1)`：前者在暗色下是不透明的 `#353638`，压在卡片底上有明显的「贴片感」；后者本来就是主题的抬升层。

### 测试

- `test/config.test.mjs` 27 → **29** 条：
  - 「绘图控件的底色与字色都用主题里真实存在的 token」跟着换掉 `--dsw-specific-selector` 的断言，改认 `--dsw-alias-bg-layer-1`。
  - 新增「设置页的配色一律走主题 token，不硬编码品牌色与错误色」：禁 `#3b82f6` / `#ef4444` / `#93c5fd` / `#fff`，并要求 8 个出厂 token（卡片底、卡片描边、品牌色、主按钮、反色前景、开关滑块、错误色、成功色）都出现；另加一条正则禁止任何 `background|color|border-color|box-shadow` 直接写十六进制。
  - 新增「设置页用卡片分块，不再用分隔线」：`[data-comfy-sec]` 规则里不许有 `border-bottom`，必须有 `radius-xl` 与两个 `settings-card-*` token。
- 单测总数 119 → **121**。
- `scripts/probe-client-bundle.mjs` 仍是 **25** 项（标记名没变：`data-comfy-sec-head` / `data-comfy-sub` / `data-comfy-savebar` / `data-comfy-lora-docs` / `data-comfy-doc-count` 全部保留），成功文案补一句「设置页卡片化与主题 token 上色」。

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
- 真机验证（512×512 / 12 步）：整合包单独出图成功（`_tmp_ckpt_00001_.png`），整合包 + LoRA（`luna_anima_v1.safetensors`）也成功（`_tmp_ckpt_lora_00001_.png`），两次 `status_str` 都是 `success`。

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
