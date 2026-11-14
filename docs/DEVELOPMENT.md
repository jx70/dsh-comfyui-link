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
├── index.js                Host 插件：8 个工具 + 系统提示 + 三条路由（两条 GET + 一条 POST）+ Config
├── client.js               浏览器半端：设置页（settings.section）+ 绘图控件（conversation.input.left）+ 桌面端两条 preload 桥
├── lib/comfy.mjs           纯 HTTP 客户端 + 工作流构造（零宿主依赖）
├── cordis.patch.yml        静态默认配置（baseUrl）+ 「绘图模式」preset 声明
├── locale/{zh,en}.json     插件名与描述的本地化
├── icon.svg                设置页图标
├── test/
│   ├── helpers/fake-ctx.mjs  假 ctx（tools / systemPrompt / connection / llm / attachments）
│   ├── graph.test.mjs        工作流构造与 HTTP 客户端（22 条）
│   ├── registration.test.mjs 注册形状、开关拦截、三条路由、save_to（23 条）
│   ├── config.test.mjs       配置 schema + preset 声明 + 去本地化守护 + 包名守护 + 桌面桥（25 条）
│   ├── output.test.mjs       输出目录解析、重名不覆盖、复制落盘（4 条）
│   └── picker.test.mjs       原生文件夹选择框的纯函数与 POST 路由（9 条）
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
npm test          # 83 条纯单测，约 1 秒
npm run smoke     # 假 ctx 跑一遍 apply()，用宿主真 schema 校验器检查
```

单跑某一组：

```bash
node --test test/graph.test.mjs
node --test test/registration.test.mjs
node --test test/config.test.mjs
node --test test/output.test.mjs
node --test test/picker.test.mjs
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
| `npm run probe:bundle` | | ✓ | ✓ | 浏览器拿到的 client.js 里确有新代码（16 项标记） |
| `npm run probe:features` | ✓ | | | template / img2img / LoRA / upscale + 开关拦截 |

「需要凭据」的两个探针拿不到凭据时会**跳过并 exit 0**，所以别人的机器上跑它们不会红一片。

### 探针各自钉的是什么

- **`probe-route`**：给假 `llm` 三个 provider（两个能看图、一个纯文本），断言路由只留下能看图的模型、纯文本的被剔掉；再让 `llm` 抛异常，断言返回 500。它不碰网络，纯逻辑。
- **`probe-http`**：真起一个 `Request` 打 `DSH_BASE` 上的路由。这条探针的价值在于**证明路由真的在信任栅栏内部** —— 如果哪天误改成 `webServer.register`，带 cookie 也不会是 200，这条会立刻红。它还顺带用「GET 打 pick-directory 得 404、POST 坏 JSON 得 400、POST 不带 cookie 得 401」钉住 POST 路由的方法匹配与鉴权，全程不弹窗。
- **`probe:bundle`**：抓 DSH 首页 HTML，从里面找出 comfyui 的 client bundle URL，下载回来断言 16 项标记：`ModelPicker`、`DrawBar`、`data-comfy-select`、`/api/comfyui/vision-models`、`/api/comfyui/draw-models`、`/api/comfyui/pick-directory`、`conversation.input.left`、`data-comfy-btn`、`outputDirHint`、`data-comfy-path`、`data-comfy-clear`、`data-comfy-pick`，以及两件**必须已经消失**的东西 —— 设置页的 `loraHint`、输出目录手填框的 `data-comfy-inline`。它防的是「源码改了但浏览器加载的还是旧的」——客户端 bundle 有构建缓存，这条能立刻发现。
- **`probe-features`**：真出图。它会把 `index.js` import 两次（第二次带 `?off=<时间戳>` 绕开 ESM 缓存），一次全开关关着验拦截、一次开着验真跑（开的是 `draw:{unet:'',lora:true}`，即对话栏那颗胶囊的等价配置）。LoRA 段需要 `COMFY_LORA` 指定一个真实文件名，没设就跳过 —— 不能硬编码某个 LoRA 名，别人的机器上没有。

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

`.volatile()` 的字段在 `apply()` 里是 cosmokit 引用对象，必须 `.get()` 解包。忘了解包的表现是「设置页/对话栏改了不生效」，而不是报错 —— 很难查，所以统一走 `unwrapVolatile()`。

反过来也要记住：**只有 volatile 字段写得进去**。宿主对非 volatile 路径直接抛 `Config field "..." is not volatile`，所以页面上新增一项控件时，`Config` 里那一段必须先加 `.volatile()`。

### 工具注册字段是白名单

`ctx.tools.register()` 只认这几个键，多一个就报错：

```
name  description  parameters  output  execute  isConcurrencySafe  timeoutMs
presentCall  presentResult  projectContent  finalizeContent  deferLoading
```

`scripts/offline.mjs` 会逐个工具检查这个白名单。

### 模型清单路由不能用 webServer.register

DSH 把整个 `/api` 前缀挂在 connection 的信任栅栏后面，自己挂会被外层前缀路由先吃掉，表现是永远 401。必须走 `ctx.connection.fetch.register`（本插件有三条：`GET /api/comfyui/vision-models`、`GET /api/comfyui/draw-models`、`POST /api/comfyui/pick-directory`）。详见 [DESIGN.md](./DESIGN.md#为什么模型清单必须由宿主开路由)。

### 桌面端：两条 preload 桥 + 一个路径约定

DSH Desktop 的页面来自 `dsh-app://app/`，**相对 `/api/...` 的请求在那里打不到宿主**。`client.js` 里所有宿主请求都走 `hostFetch(route, init)`：

```js
function hostFetch(route, init) {
  const transport = globalThis.__DSH_TRANSPORT__
  if (typeof transport?.fetch === 'function') {
    const send = transport.fetch            // 出厂也是取出来裸调，不绑 this
    return send(route.replace(/^\/+/, ''), init)
  }
  return globalThis.fetch(route, init)
}
```

- **路径要去掉前导斜杠**。传输钩子收的是「文档相对」路径：出厂 `createWebConnectionRpc` 把请求发成去掉首字符的 `channel/endpoint`，HMR 也先对 `/plugins/events` 做 `.slice(1)`。写成 `/api/...` 会被解析到 `dsh-app://app/api/...` 上，永远 404。
- **别裸调 `fetch(VISION_API)`**。`test/config.test.mjs` 有一条断言专门抓这个（`doesNotMatch(/\bfetch\((VISION_API|DRAW_API|PICK_API)\b/)`）。
- **选目录优先走 `__DSH_DIRECTORY_PICKER__.pick()`**（`() => Promise<string | null>`，取消是 `null`）。桌面端由 Electron 自己弹框，比「HTTP 打宿主 → 宿主 spawn PowerShell」少两个进程；宿主那条 POST 路由留给浏览器。
- **这两条桥没有类型声明**。全仓 `.d.ts` 里 grep 不到 `__DSH_TRANSPORT__` / `__DSH_DIRECTORY_PICKER__`，形状只能照 `dsh-client-connection/lib/client.browser.js` 与 `dsh-client-ui-directory-picker-native/lib/client.js` 抄。

本机没装 DSH Desktop（`<home>/.dsh/profiles` 下也没有 desktop profile，`dsh\lib\bin.js` 直接拒绝 `--profile desktop`），所以这条路径只能靠「能力探测 + 回落」保证浏览器侧零变化，改完务必跑 `npm run probe:bundle` 确认 bundle 里两个全局都在。

### 对话栏控件的两个前提

`conversation.input.left` 的组件能直接拿到标准 props `sessionId` / `useSessions`，所以判断「当前会话是不是绘图模式」照出厂 `AgentPresetLabel` 的写法读 `state.byId[sessionId].projectionValues.agentPreset` 即可，不用自己 inject 会话服务；自己的 `configForms` 句柄则靠注册处的 `inject: (sessionId) => ({...})` 透传（`InjectParams` 对 `scope: 'session'` 就是 `[sessionId]`）。

另一个坑：`useSessions` 在会话摘要还没到达时会给 `undefined` 的 preset，这时别急着「不是绘图模式」直接 return —— 组件里做了一次向 `agent-preset-registry` 的默认预设回退，否则新建会话的头几帧控件会闪一下再出现。

### preset 声明跟着包一起发

「绘图模式」是 `cordis.patch.yml` 里的一条 `@deepseek-ai/dsh-agent-preset` insert。注意 **`config.plugins` 里的 `name` 必须写裸包名**（`@deepseek-ai/dsh-persona` 这类）：解析层的 `anchorInsertedPluginNames` 只改写顶层 insert 条目与 group 的 `config`，不会进 `config.plugins` 里重写相对路径。写裸包名时它们由 dsh 安装目录解析，插件自己的 `node_modules` 里不需要装这些包。

### 原生文件夹选择框：三个坑

「选择」按钮走 `POST /api/comfyui/pick-directory`，宿主 spawn 一个 `powershell.exe -STA` 弹 WinForms `FolderBrowserDialog`。这块的坑都是**踩出来的**，改之前先读一遍：

- **不能用 `-Command` / `-File`**。外层 PowerShell 的引号处理会把脚本里的 `$` 变量吃掉，报 `ParserError: TerminatorExpectedAtEndOfString` / `ExpectedValueExpression`。一律 `-EncodedCommand`：`Buffer.from(script,'utf16le').toString('base64')`。
- **`-STA` 是硬要求**。文件夹对话框是 COM + 模态循环，MTA 线程里直接异常。同时要用一个 1×1、`TopMost=$true`、`Opacity=0`、`ShowInTaskbar=$false` 的隐形 owner 调 `$dlg.ShowDialog($owner)`，否则对话框可能开在浏览器后面。
- **路径不能走 stdout**。控制台代码页会把 `D:\图片\输出` 写坏；结果写进 `mkdtemp` 里的 UTF-8 无 BOM 文件（`UTF8Encoding($false)`）再 `readFile`，`finally` 删临时目录。同理也别在断言里比较 stdout 文本 —— 只看那个临时文件。
- **stderr 默认是 CLIXML**。不关进度流，powershell 先往 stderr 吐一段 `<Objs>` 进度噪音（中文还是乱码），真正的错误被埋在后面的 `<S S="Error">boom_x000D__x000A_</S>` 里。所以脚本第一行就 `$ProgressPreference = 'SilentlyContinue'`，失败路径统一走 `parsePowerShellError()`（还原 `_x000D_` 转义、取第一条非续行）—— 别自己 `stderr.split('\n').slice(-1)`，那样拿到的是一条 XML 残片。

另外两条契约：这条路由是**阻塞**的（`PICK_TIMEOUT_MS = 180_000` 自己兜，宿主 webserver 没配 `requestTimeout`），并且必须有 `picking` 布尔挡连点（第二个请求 409）。这些都由 `test/picker.test.mjs` 钉住；那个文件**不弹窗**，跑测试不会突然冒出对话框。

还有一条**界面约定**：输出目录那一栏**没有输入框**，路径只能从对话框里挑（挑错了点「清除」）。所以别顺手把 `TextRow` 的 `action` 分支加回来 —— `probe:bundle` 里 `noInline: !includes('data-comfy-inline')` 会立刻红。非 Windows 上这一项只能在 profile 的 `cordis.patch.yml` 里写 `output.dir`。

### 输出目录：三个纯函数 + 一条优先级

`index.js` 导出了 `looksAbsolute` / `resolveOutputDir` / `uniqueTarget` / `saveImageCopy`，`test/output.test.mjs` 直接调它们，不需要 ComfyUI 也不需要临时宿主。改这块时守住两条：

- **`output.dir` 留空必须完全不动作**（不建目录、不复制）。这是「没配过这一栏的用户行为与旧版本一致」的边界，`test/output.test.mjs` 有断言钉着。
- **别换成 `path.isAbsolute`**。它在 Windows / Linux 上对 `X:/…` 结论相反，CI 两个平台都跑，会一边绿一边红。

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
