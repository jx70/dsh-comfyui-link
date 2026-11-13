# 开发说明

改这个插件之前先看一遍这份，能省掉大部分「改了没反应」「测试红了但不知道为啥」的时间。实现层的设计取舍看 [DESIGN.md](./DESIGN.md)，怎么用看 [README](../README.md)。

- [环境](#环境)
- [目录](#目录)
- [跑测试](#跑测试)
- [探针矩阵](#探针矩阵)
- [环境变量](#环境变量)
- [改代码的常见坑](#改代码的常见坑)
- [发版流程](#发版流程)

## 环境

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| Node | `>=22` | 只用内置 `fetch` / `node:test`，没有构建步骤 |
| DSH | `>=0.2.0-rc.1` | `connection.fetch` 从这一代开始有 |
| ComfyUI | 能跑就行 | 默认 `http://127.0.0.1:8188` |

`npm test` **不需要** ComfyUI，也不需要 DSH 在跑 —— 它只 import `lib/` 与 `index.js` 的纯逻辑，宿主服务全部用假 ctx 顶替。要跑真出图的 `e2e` / `probe:features` 才需要 ComfyUI 在跑。

安装依赖（只有一个运行期依赖）：

```bash
npm install
```

## 目录

```
.
├── index.js                Host 插件：8 个工具 + 系统提示 + vision 路由 + Config
├── client.js               浏览器半端：设置页那一页（settings.section 槽位）
├── lib/comfy.mjs           纯 HTTP 客户端 + 工作流构造（零宿主依赖）
├── cordis.patch.yml        静态默认配置（baseUrl）
├── locale/{zh,en}.json     插件名与描述的本地化
├── icon.svg                设置页图标
├── test/
│   ├── helpers/fake-ctx.mjs  假 ctx（tools / systemPrompt / connection / llm / attachments）
│   ├── graph.test.mjs        工作流构造与 HTTP 客户端（22 条）
│   ├── registration.test.mjs 注册形状与开关拦截（20 条）
│   └── config.test.mjs       配置 schema + 去本地化守护 + 包名守护
├── scripts/
│   ├── env.mjs               所有脚本的环境入口（唯一允许读环境变量的地方）
│   ├── offline.mjs           假 ctx 冒烟
│   ├── e2e.mjs               真出图全链路
│   ├── selftest.mjs          绕开插件直接打 ComfyUI
│   ├── probe-route.mjs       假 ctx 验模型筛选
│   ├── probe-http.mjs        真打 HTTP 验路由在栅栏内
│   ├── probe-client-bundle.mjs 验浏览器拿到的 bundle
│   ├── probe-features.mjs    四个功能开关的实际拦截
│   └── sync-github.ps1       推 GitHub 的一条命令
└── docs/
    ├── DESIGN.md
    └── DEVELOPMENT.md
```

**`scripts/` 与 `test/` 不进 npm 包**（`files` 里没列），但它们必须在仓库里 —— 别人 clone 下来要能跑测试。这是刻意的：发布体积小，同时源码可验证。

## 跑测试

```bash
npm test          # 64 条纯单测，约 1 秒
npm run smoke     # 假 ctx 跑一遍 apply()，用宿主真 schema 校验器检查
```

单跑某一组：

```bash
node --test test/graph.test.mjs
node --test test/registration.test.mjs
node --test test/config.test.mjs
```

### config.test.mjs 里的「去本地化守护」

这个文件后半段是给这个仓库自己用的守卫，不是给使用者的：

- 任何文件不许出现本机 link 安装的包名前缀（`@` + `local` + `/`）
- 任何文件不许出现作者机器的绝对路径、npx 缓存里的哈希目录、凭据文件的硬编码读法
- 7 个脚本都必须 `from './env.mjs'`，不许自己写死地址
- `package.json` 的开源元数据必须齐全（license / repository / homepage / bugs / author / keywords）
- `files` / `exports` / `scripts` 里提到的每个路径都必须真实存在
- README 里不许留显卡型号、显存实况、作者机器上的模型文件名
- 旧包名不许复活；README 里不许写「add 后面直接跟包名」那种会装到别处的命令

**加新文件时如果踩到这些规则，说明该改代码而不是改测试。** 例外是 `test/` 自己（它当然要提到这些模式）。

## 探针矩阵

| 命令 | 需要 ComfyUI | 需要 DSH 在跑 | 需要凭据 | 干什么 |
| --- | --- | --- | --- | --- |
| `npm test` | | | | 纯逻辑单测 |
| `npm run smoke` | | | | 假 ctx 冒烟 + 真实 schema 校验 |
| `npm run smoke:live` | ✓ | | | 再真调一遍只读工具 |
| `npm run selftest` | ✓ | | | 绕开插件直接打 ComfyUI |
| `npm run e2e` | ✓ | | | 真出图全链路（512×512 / 4 步） |
| `npm run probe:route` | | | | 假 ctx 验「能看图的模型」筛选 |
| `npm run probe:http` | | ✓ | ✓ | 真打路由：带 cookie 200 / 不带 401 / 不存在 404 |
| `npm run probe:bundle` | | ✓ | ✓ | 浏览器拿到的 client.js 里确有新代码 |
| `npm run probe:features` | ✓ | | | template / img2img / LoRA / upscale + 开关拦截 |

「需要凭据」的两个探针拿不到凭据时会**跳过并 exit 0**，所以别人的机器上跑它们不会红一片。

### 探针各自钉的是什么

- **`probe-route`**：给假 `llm` 三个 provider（两个能看图、一个纯文本），断言路由只留下能看图的模型、纯文本的被剔掉；再让 `llm` 抛异常，断言返回 500。它不碰网络，纯逻辑。
- **`probe-http`**：真起一个 `Request` 打 `DSH_BASE` 上的路由。这条探针的价值在于**证明路由真的在信任栅栏内部** —— 如果哪天误改成 `webServer.register`，带 cookie 也不会是 200，这条会立刻红。
- **`probe:bundle`**：抓 DSH 首页 HTML，从里面找出 comfyui 的 client bundle URL，下载回来断言含 `ModelPicker` 与 `/api/comfyui/vision-models`。它防的是「源码改了但浏览器加载的还是旧的」——客户端 bundle 有构建缓存，这条能立刻发现。
- **`probe-features`**：真出图。它会把 `index.js` import 两次（第二次带 `?off=<时间戳>` 绕开 ESM 缓存），一次全开关关着验拦截、一次开着验真跑。LoRA 段需要 `COMFY_LORA` 指定一个真实文件名，没设就跳过 —— 不能硬编码某个 LoRA 名，别人的机器上没有。

## 环境变量

所有脚本都从 `scripts/env.mjs` 取，别在脚本里自己写 `process.env`：

| 变量 | 默认 | 谁用 |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | 所有需要 ComfyUI 的 |
| `DSH_BASE` | `http://127.0.0.1:3080` | `probe:http` / `probe:bundle` |
| `DSH_CREDENTIALS` | `<home>/.dsh/.credentials.yaml` | 同上 |
| `DSH_AUTH_COOKIE` | 空 | 同上；给了就不读凭据文件 |
| `DSH_HOST_MODULES` | 自动解析 | `smoke`（找宿主的 schema 校验器） |
| `COMFY_LORA` | 空 | `probe:features`；不设就跳过 LoRA 段 |

`env.mjs` 找宿主包目录的顺序：`DSH_HOST_MODULES` → `require.resolve('@deepseek-ai/dsh-tools/package.json')` → `./node_modules/@deepseek-ai` → `../node_modules/@deepseek-ai` → `null`。拿不到就跳过真实 schema 校验，其余检查照跑。

## 改代码的常见坑

### 改了没反应

ESM 模块有缓存。改完 `lib/comfy.mjs` 或 `index.js`，要**把插件 disable 再 enable 一次**（或重启 DSH）。客户端 bundle 有构建缓存，改完 `client.js` 要重启后端，然后用 `npm run probe:bundle` 确认浏览器真的拿到了新代码。

### 别用 PowerShell 管道改含中文的源码

`Set-Content` / `>` 会把 UTF-8 写坏（默认按 ANSI 或加 BOM），改完直接 SyntaxError。要批量替换用编辑器或 Node 脚本，并显式 `utf8`。

### 连线必须是字符串节点 id

```js
inputs: { model: ['1', 0] }   // ✅
inputs: { model: [1, 0] }     // ❌ KeyError: 1
```

`test/graph.test.mjs` 里有专门的断言扫所有连线，改工作流构造时别把它删了。

### 不要写 `export default apply`

`cordis-plugin-loader` 的 `unwrapExports` 会因此拿到裸函数，`inject` 等命名导出全丢，启动时报 `cannot get property "tools" without inject`。`test/registration.test.mjs` 有一条 `plugin.default === undefined` 钉着这个。

### volatile 字段是引用对象

`.volatile()` 的字段在 `apply()` 里是 cosmokit 引用对象，必须 `.get()` 解包。忘了解包的表现是「设置页改了不生效」，而不是报错 —— 很难查，所以统一走 `unwrapVolatile()`。

### 工具注册字段是白名单

`ctx.tools.register()` 只认这几个键，多一个就报错：

```
name  description  parameters  output  execute  isConcurrencySafe  timeoutMs
presentCall  presentResult  projectContent  finalizeContent  deferLoading
```

`scripts/offline.mjs` 会逐个工具检查这个白名单。

### 设置页的模型清单不能用 webServer.register

DSH 把整个 `/api` 前缀挂在 connection 的信任栅栏后面，自己挂会被外层前缀路由先吃掉，表现是永远 401。必须走 `ctx.connection.fetch.register`。详见 [DESIGN.md](./DESIGN.md#为什么审图模型必须由宿主开路由)。

### img2img 的底图要先上传

`LoadImage` 只能读 ComfyUI `input/` 目录。`buildImg2Img` 之前必须 `client.uploadImage()`，否则节点图合法但执行时报文件不存在。

## 发版流程

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 顶部加一节（格式按 Keep a Changelog）
2. `npm test` 全绿，`npm run smoke` 全绿
3. 有 ComfyUI 在跑的话，`npm run e2e` 与 `npm run probe:features` 也过一遍
4. `npm pack --dry-run` 看一眼包内容（`scripts/` 与 `test/` 不该出现）
5. 提交、打 tag、推 GitHub
6. `npm publish`（`publishConfig` 已指定 `access: public` 与官方源）

`npm run sync` 是日常同步用的一条命令：补 origin → add → 拒绝 `node_modules` / `.env` / `.comfy-probe` / `comfy_out` 进暂存 → commit → push。origin 丢了会自动从 `package.json` 的 `repository.url` 补回。
