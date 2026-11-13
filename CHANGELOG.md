# Changelog

All notable changes to this project are documented here.
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- **包名改为 `dsh-comfyui-link`**（原 `dsh-comfyui-bridge`）。原名在 npm 上已被他人占用（同名的 1.1.0 版本属于另一个维护者，本身也是 DSH 的 ComfyUI 桥），`add` 后面直接跟包名会装到别人的包。新名在 npm 与 GitHub 上都未占用。界面显示名不变，仍是「ComfyUI 桥 / ComfyUI Bridge」。
- `package.json` 的 `files` 增加 `!docs/demo.png`：示例图只给 GitHub 看，不进 npm 包（`npm pack` 仍是 14 files）。

### 文档

- `README.md` / `README.en.md` 整体重写：补齐徽章、目录、示例图、特性、兼容性与已知限制、常见问题、贡献指引；安装段按「从 GitHub 装」写，并明确本包暂未发布到 npm。
- `docs/DESIGN.md` 的性能段去掉具体显存数字，`docs/DEVELOPMENT.md` 同步测试条数与新增的包名守护说明。

### 测试

- `test/config.test.mjs` 新增两条守护：旧包名不许复活；README 与文档里不许出现「`add` 后面直接跟包名」这种会装到别处的命令。`files` 的负向条目（`!` 开头）现在会校验它指向的文件真实存在。（62 → 64 条）

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
