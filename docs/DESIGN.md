# dsh-comfyui-link 设计说明

这份文档讲实现：**为什么是这么写的**，以及改代码前必须知道的边界。上手怎么用看 [README](../README.md)。

- [三层结构](#三层结构)
- [为什么模型清单必须由宿主开路由](#为什么模型清单必须由宿主开路由)
- [为什么「选择目录」要开一条 POST 路由，而且它会阻塞](#为什么选择目录要开一条-post-路由而且它会阻塞)
- [桌面端：两条 preload 桥](#桌面端两条-preload-桥)
- [工作流构造](#工作流构造)
- [两种模型组织方式，两条加载路径](#两种模型组织方式两条加载路径)
- [审图重生成的状态机](#审图重生成的状态机)
- [volatile 字段与热生效](#volatile-字段与热生效)
- [开关拦截](#开关拦截)
- [输出图怎么交回模型](#输出图怎么交回模型)
- [LoRA 提示词文档：为什么按内容打分、为什么自动并入](#lora-提示词文档为什么按内容打分为什么自动并入)
- [失败模式与报错约定](#失败模式与报错约定)
- [性能数字](#性能数字)

## 三层结构

```
┌───────────────────────────────────────────────┐
│ client.js   浏览器半端（两处 UI）                │
│   ctx.slots.register('settings.section')       │
│   ctx.slots.register('conversation.input.left')│
│   ctx.configForms.get('comfyui')               │
│   hostFetch('/api/comfyui/vision-models')      │
│   hostFetch('/api/comfyui/draw-models')        │
│   POST('/api/comfyui/pick-directory')          │
│   ── 桌面端：__DSH_TRANSPORT__ / __DSH_DIRECTORY_PICKER__│
└───────────────────────┬───────────────────────┘
                        │ HTTP（带浏览器 cookie）
┌───────────────────────▼───────────────────────┐
│ index.js    Host 插件                          │
│   export const name / inject / Config          │
│   ctx.tools.register(...) × 8                  │
│   ctx.systemPrompt.section(...)                │
│   ctx.connection.fetch.register(vision+draw+pick)│
└───────────────────────┬───────────────────────┘
                        │ fetch
┌───────────────────────▼───────────────────────┐
│ lib/comfy.mjs   纯 HTTP 客户端 + 工作流构造    │
│   零 @deepseek-ai/* 依赖，可脱离 DSH 单跑      │
└───────────────────────┬───────────────────────┘
                        │ HTTP
                  ComfyUI :8188
```

分三层的实际收益：

- `lib/comfy.mjs` 可以脱离 DSH 单独跑（`npm run selftest` 就是干这个），工作流构造的 bug 不用起整个宿主就能定位。
- `index.js` 只负责「翻译成工具」，所有 HTTP 细节都下沉到 lib，工具函数体基本是线性的。
- `client.js` 拿不到宿主服务（client 侧没有 `llm` / `tools`），所以它需要的一切数据都得由 host 侧开路由送过去；桌面端还得借 preload 的传输桥才够得着那些路由。

## 为什么模型清单必须由宿主开路由

设置页要列「能看图的模型」，这份清单在宿主里（`llm.listProviders()` / `listModels()` / `resolveModelInfo()`）。但浏览器半端拿不到 `llm` 服务，只能让 host 侧开一条只读路由。

输入框左侧的绘图控件要的是另一份清单：ComfyUI 的 `diffusion_models` / `checkpoints` / `text_encoders` / `vae` / `loras` 文件名。那份东西在 `client.modelIndex()` 里，浏览器同样拿不到（还要防 CORS），所以再开一条 `/api/comfyui/draw-models`。

设置页里「LoRA 提示词」那一栏还要第三份：目录里认到了哪几篇候选、其中几篇像提示词（按内容打分，不看文件名对齐）。那是一次磁盘遍历 + 逐篇读文本，同样只能在宿主侧做，于是有 `/api/comfyui/lora-docs`。四条路由（含后面那节讲的 `POST /api/comfyui/pick-directory`）都由 `mountDataRoutes` 里各自的 `scope.effect` 注册。

**这条路由不能用 `webServer.register`。** DSH 把整个 `/api` 前缀挂在 connection 的信任栅栏后面：

```
浏览器请求 /api/comfyui/vision-models
   ↓
外层前缀路由（connection 的 /api 栅栏）
   ├─ admit()：要求浏览器 cookie 或 API token
   ├─ createSharedFetchHandler()：按 pathname 精确分发
   └─ 要求 principal 是 owner
   ↓
自己注册的 handler
```

自己用 `webServer.register` 挂 `/api/comfyui/vision-models`，请求会被外层的 `/api` 前缀先吃掉，永远走不到自己的 handler —— 表现就是**永远 401**，而且很难看出原因（handler 里的日志一条都不会打）。

正确写法：

```js
const connection = scope.connection ?? scope.get('connection')
if (!connection || typeof connection.fetch?.register !== 'function') {
  log('没有 connection.fetch，模型清单路由挂不上（审图模型改成跟随当前会话）')
  return
}
scope.effect(() => connection.fetch.register({
  path: '/api/comfyui/vision-models',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: visionHandler,
}))
scope.effect(() => connection.fetch.register({
  path: '/api/comfyui/draw-models',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: drawHandler,
}))
scope.effect(() => connection.fetch.register({
  path: '/api/comfyui/lora-docs',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: docsHandler,
}))
scope.effect(() => connection.fetch.register({
  path: '/api/comfyui/pick-directory',
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: pickHandler,
}))
```

注册在栅栏**内部**，鉴权由栅栏自己做完，handler 只管数据。所以 handler 里不要再自己判 cookie。

`/api/comfyui/draw-models` 与审图那条的区别：它读的是 ComfyUI 的模型列表，所以会真的打一次 `client.modelIndex()`。ComfyUI 没跑时返回 502 + `{ok:false,error,folders:{}}`，前端据此显示「读不到 ComfyUI 模型清单」，下拉退化成只剩「自动」一项 —— 不会因为 ComfyUI 掉线把整个输入框卡住。

**降级路径**：没有 `connection`（旧版宿主、或者极简 ctx）时只记一行日志就返回，9 个工具照常注册。设置页的下拉框会取不到清单，退化成「跟随当前会话模型」，绘图控件的下拉也只剩「自动」，输出目录只能在 profile 的 `cordis.patch.yml` 里配。这条路径由 `test/registration.test.mjs` 里的「删掉 ctx.connection 后 routes 为空但 tools.size 仍 9」钉住。

## 为什么「选择目录」要开一条 POST 路由，而且它会阻塞

浏览器没有「弹系统文件夹选择框」的能力（`<input type="file" webkitdirectory>` 只能选**已有**文件、拿不到空目录，也拿不到绝对路径），所以这个动作只能由宿主代劳：页面发 `POST /api/comfyui/pick-directory` → 宿主 spawn 一个 `powershell.exe -STA` 弹 WinForms `FolderBrowserDialog` → 用户点完 → 子进程把路径写进临时文件 → 宿主读回来作为响应体返回。

三个约束直接决定了实现形状：

1. **路由必须是 POST**：`assertFetchRoute` 只检查「路径能被 `endpointFromPath('/api', …)` 解析」「methods 非空且不重复」，所以 `methods: ['POST']` 完全合法，不需要绕道 GET + 查询串。`connection` 只把方法匹配上的请求交给 handler，其余落到 404 —— 所以同一条路径用 GET 打是 404，这一点由 `probe:http` 钉住。
2. **它会一直挂着**：`ShowDialog` 是模态循环，请求会开到用户点「确定」为止。宿主 webserver 没配 `requestTimeout` / `headersTimeout`（`dsh-host-webserver/lib/index.js` 里这三个词出现 0 次），所以不会被服务端掐断 —— 超时得插件自己兜（`PICK_TIMEOUT_MS = 180_000`，到点 `child.kill()` 并回 `{ok:false, reason:'timeout'}`）。同时用一个 `picking` 布尔挡连点：第二个请求立刻回 409，否则用户会被两个叠在一起的模态框困住。
3. **路径不能走 stdout**：控制台代码页会把中文路径写坏（`D:\图片\输出` 直接变乱码），所以结果写进 `mkdtemp` 里一个 UTF-8 无 BOM 的临时文件再 `readFile`；临时目录在 `finally` 里删掉。同理，`-Command` / `-File` 都不能用 —— 外层 shell 会把 `$` 变量吃掉 —— 一律 `-EncodedCommand`（UTF-16LE → base64）。另外 powershell 的 stderr 默认是 CLIXML：脚本里先 `$ProgressPreference = 'SilentlyContinue'` 掐掉进度噪音，失败时再用 `parsePowerShellError()` 从 `<S S="Error">` 里还原正文（`_x000D_` 这类转义要手工解），否则用户看到的会是一段 XML。

**选中的路径只进草稿。** 路由本身不写配置：它只回 `{ok:true, path}`，前端把它塞进 `draft`，跟改别的字段走完全同一条保存路径。这样「选择」不会产生一条绕过 `form.mutate` 的写入口，也就不会有人以为点一下按钮就改好了。

**这一栏没有输入框。** 路径只能从系统对话框里挑（挑错了点「清除」，等于回到「图只留在 ComfyUI 的 output」）。所以 `output.dir` 的入口只有两个：原生对话框，或者直接改 profile 的 `cordis.patch.yml`。

**非 Windows**：`powershellPath()` 返回 `''`，路由立刻回 `{ok:false, reason:'unsupported'}`，前端提示「这个平台没有系统文件夹选择框，输出目录在这里设不了」。没有手填框可以退，所以非 Windows 上改这一项只能去 profile 的 `cordis.patch.yml` 里写 `output.dir`。

## 桌面端：两条 preload 桥

DSH Desktop（Electron）加载的是同一份 Web GUI、同一份 `client.js` —— `dsh-client-modules` 的 `resolveMeta` 只服务 `dsh.client.platform === 'web'`，桌面端走的就是这条路，插件不需要另发一套声明。真正的差别只有一处：**页面来源**。桌面页面来自 `dsh-app://app/`（自定义协议），不是 http origin，所以相对 `/api/...` 的请求在那里解析不到宿主。

出厂的几个 UI 包都显式处理过这件事（`dsh-client-ui-chat` / `dsh-client-ui-file-actions` / `dsh-client-ui-sidebar-documentpreview` 里都有 `if (!/^https?:/u.test(base) && !base.startsWith("dsh-app://app/") …) throw`），说明这是平台契约而不是偶发。插件用两个**能力探测**对齐：

| 能力 | 探测对象 | 形状 | 没有时 |
| --- | --- | --- | --- |
| 打宿主的 HTTP 路由 | `globalThis.__DSH_TRANSPORT__.fetch` | `(path, init) => Promise<Response>`，收**文档相对**路径 | 退回页面自己的 `fetch` |
| 弹系统文件夹选择框 | `globalThis.__DSH_DIRECTORY_PICKER__.pick` | `() => Promise<string \| null>`，取消返回 `null` | 走 `POST /api/comfyui/pick-directory` |

两条都是「有就用、没有就回落」，所以同一个 bundle 在 Web 与 Desktop 上都能跑，插件也不需要知道自己跑在哪儿。

**路径必须去掉前导斜杠。** 传给传输钩子的不是 `/api/...`，而是 `api/...` —— 出厂代码就是这么传的：`createWebConnectionRpc` 里 `send(\`${channel}/${endpoint}\`.slice(1), …)`，`dsh-client-hmr` 里 `const EVENTS_ROUTE = "/plugins/events".slice(1)`。`hostFetch()` 统一 `.replace(/^\/+/, '')`，别在别处另写一套。

**为什么桌面端优先用原生桥，而不是继续让宿主 spawn PowerShell。** 桌面端本来就有 Electron 自己的对话框能力，走 preload 直接调它比「HTTP 打到宿主 → 宿主 spawn 子进程 → 子进程弹 WinForms」少两个进程和一次往返，而且不受宿主是否在 Windows 上、`powershell.exe` 在不在的影响。宿主那条 POST 路由仍保留 —— 浏览器端没有别的选择。

**这两条桥没有类型声明。** 全仓 grep `__DSH_[A-Z_]+__` 能找到 16 个 preload 全局，但任何 `.d.ts` 里都没有它们的形状，只能照出厂运行时代码抄（`dsh-client-connection/lib/client.browser.js` 与 `dsh-client-ui-directory-picker-native/lib/client.js`）。改这两处之前先回去读那两个文件。

## 工作流构造

### 两种模型组织方式，两条加载路径

`models/` 下有两种装法，模板两种都认，靠**名字落在哪个文件夹**决定走哪条：

| 装法 | 文件夹 | 加载器 | 需要什么 |
| --- | --- | --- | --- |
| 单扩散模型 | `diffusion_models` | `UNETLoader` + `CLIPLoader` + `VAELoader` | 还要 `text_encoders` 与 `vae` 各有文件（Qwen-Image、Flux 这类是这种组织方式） |
| 整合包 | `checkpoints` | `CheckpointLoaderSimple` | 一个文件就够，MODEL/CLIP/VAE 都从它的 0/1/2 号输出出来（Illustrious / 光辉 这类 SDXL 检查点） |

`resolveModels()` 就是这个判断点：名字在 `checkpoints` 里 → 返回 `{checkpoint}`；在 `diffusion_models` 里 → 返回 `{unet, clip, vae}`；不点名时 `diffusion_models` 优先，空着才退回 `checkpoints`；同名时按整合包算（整合包更完整，缺 `text_encoders` / `vae` 也能跑）。

只走三件套是不行的：只装了整合包的机器上 `diffusion_models` 与 `text_encoders` 都是空的，模板会直接报「一个模型都没有」——而这类机器正是最常见的那种（下载一个 6.6 GB 的 SDXL 检查点就能画）。反过来只走整合包也不行：Qwen-Image / Flux 这类模型根本没有整包文件。

### 节点图（`buildTxt2Img`）

三件套（`diffusion_models`）9 个节点：

| id | class_type | 作用 |
| --- | --- | --- |
| `1` | `UNETLoader` | diffusion model |
| `2` | `CLIPLoader` | 文本编码器 |
| `3` | `VAELoader` | VAE |
| `4` | `CLIPTextEncode` | 正面提示词（`injectPrompt` 默认写这里） |
| `5` | `CLIPTextEncode` | 负面提示词 |
| `6` | `EmptySD3LatentImage` | 尺寸（SD3 系的空白潜空间） |
| `7` | `KSampler` | 采样 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 落盘 |

整合包（`checkpoints`）7 个节点 —— **节点号整体前移**，所以 `comfy_run` 的摘要不能写死 `graph[1].unet_name` / `graph[7]`：

| id | class_type | 作用 |
| --- | --- | --- |
| `1` | `CheckpointLoaderSimple` | 一个文件带出 MODEL(0) / CLIP(1) / VAE(2) |
| `2` | `CLIPTextEncode` | 正面提示词，`clip` 接 `['1', 1]` |
| `3` | `CLIPTextEncode` | 负面提示词，`clip` 接 `['1', 1]` |
| `4` | `EmptyLatentImage` | 尺寸（SDXL 系用普通的空白潜空间） |
| `5` | `KSampler` | 采样，`model` 接 `['1', 0]` |
| `6` | `VAEDecode` | 解码，`vae` 接 `['1', 2]` |
| `7` | `SaveImage` | 落盘 |

默认值：1024×1024、30 步、CFG 4.9、`euler` / `simple`、denoise 1。

挂 LoRA 时插一个节点（三件套是 `10`，整合包是 `8`，都是 `LoraLoader`），并把两条提示词的 `clip` 输入与采样器的 `model` 输入改接到它上面：

```js
graph[10] = {
  class_type: 'LoraLoader',
  inputs: { model: ['1', 0], clip: ['2', 0], lora_name, strength_model: 0.7, strength_clip: 0.7 },
}
graph[4].inputs.clip = ['10', 1]
graph[5].inputs.clip = ['10', 1]
graph[7].inputs.model = ['10', 0]
```

### 连线必须写字符串节点 id

```js
inputs: { model: ['1', 0] }   // ✅
inputs: { model: [1, 0] }     // ❌ ComfyUI execution.py:933 抛 KeyError
```

ComfyUI 内部拿节点 id 当字符串查字典，数字键直接 `KeyError`。这个坑的报错信息（`KeyError: 1`）完全看不出是连线类型问题，所以 `test/graph.test.mjs` 里有一条专门的断言：遍历所有连线的第一个元素，必须是字符串。

### img2img 要先上传底图

`LoadImage` 只能读 ComfyUI `input/` 目录里的文件，不能喂路径。所以 `buildImg2Img` 之前必须先 `client.uploadImage()`（`POST /upload/image`）把字节传上去，拿到返回的文件名再填进 `LoadImage.inputs.image`。这就是 `comfy_run` 的 `image_prompt_id` 需要「之前出过的图的 prompt_id」而不是任意本地路径的原因 —— 只有插件自己出过的图，它才知道字节在哪。

`denoise` 默认 0.6（越小越贴近原图）。重画时默认沿用底图尺寸并按 16 取整。

### upscale 走 ImageScale 而不是放大模型

`ImageScale` 是 ComfyUI 内置节点，不需要 `upscale_models` 目录里有文件。所以即使机器上一个放大模型都没装，`comfy_upscale` 也能用（代价是纯算法插值，没有细节重建）。目标宽高必须是正整数，否则直接抛 `ComfyError('GRAPH')`。

### normalizeGraph 的四类拒收

`mode="graph"` 收的是用户在 ComfyUI 界面导出的 API 格式 JSON。实际会收到的脏数据有四类，全部明确报错而不是猜：

1. `{ prompt: {...} }` —— 界面版工作流的壳，不是 API 格式
2. 空图 `{}`
3. 某个节点是 `null` 或不是对象
4. `inputs` 是数组（有些导出工具会这么干）

另外它会**深拷贝**，不改调用方传进来的对象 —— 因为 `injectPrompt` 会就地改节点，不拷贝会污染调用方手里的模板。

## 审图重生成的状态机

```
comfy_run 出图
   ↓ prompt_id
comfy_review(prompt_id, requirement[, reference_prompt_id])
   ↓
┌── 第 0 轮：把「结果图」(+「参考图」) 交给审图模型
│      ↓ 返回 { satisfied, score, feedback, new_prompt }
│   satisfied === true → 结束，返回这张
│      ↓ false
│   还有重试额度？ 否 → 结束，返回最后一轮
│      ↓ 是
│   用 new_prompt 重画（沿用底图尺寸、`draw.unet` 与 LoRA 设置）
└── 第 1..maxAttempts 轮：同上
```

几个实现细节：

- **审图模型来自设置页**：`review.provider` / `review.model`，两个都留空则回退到当前会话的模型（`exec.agent.options`）。所以「审图模型」和「画图的模型」可以是两个不同的模型。
- **重画用哪个生图模型**：`draw.unet`（绘图控件选的那个）；没选就退回 `diffusion_models` 里第一个，再退回 `checkpoints` 里第一个。这样「审图不满意 → 重画」出来的仍是同一风格，不会忽然换成文件夹里第一个模型。
- **参考图不是要求的一部分**：`reference_prompt_id` 的图只是拿来比对的参照物，图里的内容（比如参考图是海边）不该被算进「必须还原」的要求里。提示词里明确写了这一点，否则模型会拿参考图的背景当要求。
- **模型输出是 JSON**：`llm.stream()` 收 `text-delta` 拼起来再 `JSON.parse`。解析失败按「不满意 + 无新提示词」处理，不会崩。
- **`maxAttempts` 的语义是「重画次数」**，不含首轮。所以 `maxAttempts=1` 最多出 2 张图（首图 + 1 次重画）。

## volatile 字段与热生效

```js
export const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8188'),
  review: z.object({ enabled, provider, model, maxAttempts, extra }).volatile(),
  img2img: z.object({ enabled }).volatile(),
  draw: z.object({ unet: z.string(), lora: z.boolean() }).volatile(),
  upscale: z.object({ enabled }).volatile(),
  output: z.object({ dir: z.string() }).volatile(),
})
```

`.volatile()` 的字段在 `apply()` 里拿到的是 **cosmokit 引用对象**，不是普通值：

```js
function unwrapVolatile(value) {
  if (value && typeof value.get === 'function') return value.get()
  return value
}
```

必须解包才能拿到当前值，否则拿到的是个对象、`enabled` 永远是 `undefined`。解包这一步是「设置页 / 对话栏改了立即生效、不用重启」的全部机制 —— 每次工具调用时现读，所以改完下一次调用就生效。

`baseUrl` **没有** `.volatile()`：它是静态配置，改了要重载插件。设置页里也不显示它。

反过来，宿主对**非 volatile 路径的写入一律抛错**（`Config field "..." is not volatile`），所以「页面上有这一项」等价于「Config 里必须给这一段声明 `.volatile()`」。

## 开关拦截

三个功能各有开关，关着的时候对应入口要**在发起 HTTP 之前**就报错，而不是等 ComfyUI 那边失败：

| 开关 | 拦的是什么 | 报错 |
| --- | --- | --- |
| `img2img.enabled` | `comfy_run` 的 `mode="img2img"` | 提示去设置页开启 |
| `draw.lora` | `comfy_run` 的 `lora` 参数、`comfy_review` 的 `lora` 参数 | 提示去**输入框左侧的绘图控件**打开 |
| `upscale.enabled` | `comfy_upscale` 整个工具 | 提示去设置页开启 |

`draw.lora` 与另外两个不同：它不在设置页，而在会话输入框左侧那颗胶囊上（只有绘图模式可见），因为它是**逐次出图的选择**，不是全局策略。`draw.unet` 同理 —— 它只是「省略 `unet` 时用哪个模型」，指定了也不冲突，所以不拦。

报错文案统一带「开启」字样，`test/registration.test.mjs` 用 `/没开启|开启/` 匹配。这样做的原因：模型很容易顺手就调 `comfy_upscale`，如果等它跑到 HTTP 层才发现功能没开，报错会变成「连接失败」这种误导性的东西。

## 输出图怎么交回模型

工具的 `output.render` 返回块数组，第一块是文本，第二块（有图时）是图片附件：

```js
output.render({}, { text: '...', images: [{ attachmentId, mediaType, ... }] })
// → [{ type: 'text', text }, { type: 'image', attachment }]
```

图片的落盘靠宿主 `attachments.saveImage()`：

```js
const saved = await attachments.saveImage({ bytes, mediaType, name })
// → { attachmentId, mediaType, bytes, width, height, name }
```

所以 `comfy_result` 报出来的路径有两个来源：

- `attachments` 保存后宿主给的路径（模型看到的那张）
- ComfyUI 自己的 `output/` 目录（`onDiskPath` 拼的，`outputRoot` 留空时从 `/system_stats` 的启动参数反推）

`render` 对空值、混垃圾输入必须稳（返回 `[{ type: 'text', text: '' }]` 或只保留合法块），因为它是最后一道渲染，抛异常会让整条消息渲染失败。

### 输出目录：解析链与「默认不复制」

要不要把图另存到用户指定的目录，由一条明确的优先级决定，三个取图入口（`comfy_result` / `comfy_review` / `comfy_upscale`）共用同一条链：

```
args.save_to  →  features.output.dir  →  ''（不复制）
        ↓                 ↓
   resolveOutputDir(wanted, comfyOutputRoot)
        ↓
   ''（留空）/ 绝对路径原样 / 相对路径 join 在 ComfyUI output 下
        ↓
   saveImageCopy(dir, image, bytes) → uniqueTarget → writeFile
```

四个约定：

- **`output.dir` 留空时一行复制代码都不执行**。这是 1.2.0 的兼容边界：没配过这一栏的用户，行为与 1.1.0 完全一致，图只留在 ComfyUI 的 `output/`。
- **绝对路径的判定不走 `path.isAbsolute`**。它在 Windows 与 Linux 上对 `X:/…` 的结论相反，而本仓库的 CI 与用户都可能跨平台。改用 `looksAbsolute`（盘符式 `^[A-Za-z]:[\\/]`、`startsWith('/')`、UNC `\\\\`），同一份配置在两个平台上判定一致。
- **相对路径需要一个基准**，基准是 ComfyUI 自己的 output 目录（`deriveOutputRoot` 从 `/system_stats` 的启动参数里反推，`outputRoot` 配了就用配的）。基准认不出来时直接抛错、让人改绝对路径，而不是悄悄落到进程 CWD 里 —— 那会让「图存哪了」变成猜谜。
- **复制失败不判工具失败**。图已经在 ComfyUI 那边落盘、也已经交回模型了，另存只是附带动作，所以只在文本里追加一行 `! 保存失败：…`。同理，同名文件不覆盖，`uniqueTarget` 依次试 `-1` / `-2`。

**为什么不改 ComfyUI 的 `filename_prefix` 来做重定向**：`SaveImage` 的相对前缀由 ComfyUI 自己用 `os.path.join` 拼在它的 output 下，前缀写成绝对路径时的行为属于实现的偶然结果（不同版本不一定一致），而且这条路只能把图**搬走**、没法「多存一份」。在插件侧复制既跨版本稳定，也能同时满足「ComfyUI 那边还有一份」的预期。

### LoRA 提示词文档：为什么按内容打分、为什么自动并入

「挂 LoRA 时必须先看一遍有没有提示词」这条要求，如果只写在系统提示里让模型自觉去做，等于没做 —— 模型没有任何可靠的「我读过了」凭据，也没法证明自己没漏。所以这里把它做成机制：

```
comfy_run / comfy_review 收到 lora（或 lora: "auto" → 见下一节）
        ↓
features.loraDocs.dir 为空？ ── 是 ──→ 不读任何文件，行为与 1.5.1 完全一致
        ↓ 否
resolveConfiguredDir(dir, comfyOutputRoot, 'LoRA 提示词目录')
        ↓
readLoraDocs(dir) → 递归（≤3 层）列出 [{ name, rel, stem, key, size, siblings }]
        ↓                       ↑ siblings = 同一文件夹里并排的模型文件（key 规范化后）
rankLoraDocs(docs, lora, { maxChars }) → 逐篇读入打分 → 按分排序（同分按文件名，结果可复现）
        ↓                       ↑ 前 120 篇 / 累计 4 MB 两道闸，触到时记 stoppedBy
chooseLoraDoc(ranked) → match（≥45 分）/ sole（只有一篇像提示词）/ none
        ↓
promptBody(text) → 剥 `# 提示词` 那一节（没有就从全文开始）
        ↓
parseOutfitGroups(body) → 切成互斥的「套」（L1 标题开新组 / 行首中文标签切 units / 无标点软标题），
        ↓                   组内正负分流靠状态机，`负面：` / `—— 可用负面词 ——` 切负向，
        ↓                   章节分隔（`====` / `【五】` / `▍①` / `## ` / `方案 A`）复位回正面
chooseOutfitGroups(groups, prompt, limit) → 按你点名的服装挑一套 + 角色本体锚点
        ↓                                   ↑ 组名精确命中 > 同义词桶 > 行标签精确 > 行标签同义词；
        ↓                                   ↑ 没点名并锚点+第一套；说了但文档没有 → 只并锚点并明说
composeLoraPrompt(prompt, section.text) + composeNegative(negative, section.negative)
        ↓                       ↑ 正面进 prompt；负面顺着 KSampler.negative 找目标节点（graph 模式用 findNegativeNode）
结果文本追加一行「提示词文档：xxx.md（按内容挑中…；并的是「女仆」这一套 + 锚点 42 字、共 291 字（上限 4000），另有 4 套没并…；负面 61 字并进了 negative prompt）」
```

四个取舍 + 两条原则：

- **放弃文件名约定，改成按内容打分**。用户的第一版需求是「一篇文档对应一个 LoRA」，但真实目录里往往混着角色说明、画风笔记、tag 清单，名字也各写各的。于是文件名从「门槛」降级成「一个信号」：一致 +100、包含 +70、命中几个词按比例 ×60，而正文提到 LoRA 名 +30、标题命中 +35/+25、有「提示词」小标题 +20、内容像 tag 串 +12。名字完全不对但正文写了「这套是 Belle Anima v1 训的」也能被挑中 —— 这才是「要自己找」的意思。互相包含这一档要求短的那边 ≥3 个字符，否则名字叫 `a.md` 的文档会因为含字母 `a` 就白拿 70 分（写测试时被抓到）。**同目录摆放是最硬的信号**：文档和 LoRA 的模型文件在同一个文件夹里 +120（该文件夹只有这一个模型）/ +60（旁边还有别的模型），排在文件名一致 +100 之前 —— 因为「一个角色一个文件夹、模型与提示词并排」是最常见的摆法，这时候名字怎么起都不该影响配对。
- **`sole` 的跨 LoRA 风险用「透明化」处理，不用硬防**。如果全目录只有一篇像提示词文档，用它比不用更有价值（用户大概率就是只写了一篇）；但结果里会明说「没明确提到这个 LoRA」，让人一眼看出这是猜的。宁可让人知道这是猜的，也别悄悄猜。
- **自动并入 prompt，而不是只报告「找到了」**。只报告的话，模型还得自己再读一遍、再拼一遍，多一步就多一次漏掉的机会。并入是确定性动作，且结果文本可被验证（`N / M 段`、多少字、跳过几块散文、文件名、理由）。`comfy_review` 重画时也带着这段 —— 否则第一轮有角色设定、第二轮就丢了。
- **只并入 tag 行，不并入散文**。这是 1.9.0 的核心改动，起因是一个实测：11085 字的谷风天音清单在 1.8.0 的「从头截 4000 字」策略下，并进去的 3968 字里 **625 个汉字（15.7%）**，前 25 块全是 `【一】模型信息`、`【二】作者原话`、`拆解`、`⚠️ 唯一例外`、`作者备注` —— 而真正的 `tenshi_amane_school, hairband, …` 只在第 14 块之后才出现，`【六】可直接复制的完整 prompt` 干脆被挤到 4000 字门外。出图确实「看了提示词」，但看的是文档的目录和前言。**「按顺序截前 N 字」这个策略本身是错的**：它假设文档从头到尾都是提示词，而真实文档的前三分之一基本都是给人看的说明。改成逐行判定（`tagishLine`：逗号分隔、段数 ≥3、几乎全 ASCII 短片段、不以句号收尾、汉字 ≤20%、非表格、无全角括号），8 篇真实文档的汉字占比全部归零，散文丢弃率 75%–88%。
- **多套服装按「套」挑，绝不混套**。1.9.0 只解决了「散文 vs tag」这一层，没解决「这几套 tag 互相打架」：四季夏目那篇的 `① 常服 / ② 女仆 / ③ 服务员 / ④ 旗袍 / ⑤ 外套` 五套衣服的 tag 会被同时并进 prompt，`white shirt`+`maid`+`waitress`+`china dress`+`fur-trimmed coat` 一起出现，编码器收到互相冲突的服装词，画出来就锁死在默认装束；用户（或绘图 agent）想换场景，只能整个传 `lora_doc:"off"` 把文档关掉。**这才是「这次生图为什么跳提示词了」的深层原因**：不是插件丢文档，是文档把所有衣服一次塞进来。修法是先切互斥「套」（一套衣服一节、或「一章挂五套」靠行首中文标签切 units、或无标点软标题），再按用户点名的服装挑**一套** + 角色本体锚点；同义词桶兜住「穿便服 → 私服」这种换说法，桶里也没有就说「文档没有这套，服装段自己写」。四季夏目并进字数从 1998（五套混合）降到 410 + 42 锚点，换衣服场景不用再关文档。
- **预算可调，但默认不许「悄悄少喂」**。1.6.0 硬编码 1200 字，对中文角色卡太紧（真实目录里那几篇提示词清单都在 8000–11000 字，等于砍掉九成）；而且截断发生在字符中间，`long_hair, blue` 会变成 `blu` 进 prompt。1.8.0 改成设置项（默认 4000，可调 200–20000），并按空行 → 换行 → 逗号 → 空格收口（候选位置须 ≥ 预算的 60%，否则往下一档找，免得为一个逗号白扔一半预算），四档都不满足才硬切兜底。按套挑之后这份预算的含义是「命中的那套 + 角色本体的字数上限」，装不下就不再追加别的套（不切半套衣服）；只有一段 tag、没有「套」结构时才退回 `extractPromptSection` 按边界收口。**为什么不做「按 prompt 总预算动态分配」**：真实生效的预算在 ComfyUI 内部（不同文本编码器的上限差异极大：`sd2_clip.py` 是 77、`qwen_image.py` / `anima.py` 是 `max_length=99999999`），插件侧建不出可信模型，配出来的数字只会让人更困惑；不如给一个明确的字数旋钮 + 把实际并了多少字摆到结果里。
- **负面小节单独走 `negative` 出口**。文档里的 `负面：` / `负面额外加：` / `负面（这一套要额外压短发回流）：` / `—— 可用负面词 ——` / `negative prompt:` 下面跟的都是负面 tag，混进正面会互相抵消。所以识别到就切负向，一路延续到下一个章节分隔（`========` / `【五】` / `▍①` / `## ` / `方案 A`）或 `正面：`。**为什么必须有这道复位**：四季夏目那篇文档里一处 `负面：` 后面紧跟 6 个 `正面：`，不复位的话全部服装段会被当成负面（实测负面 2669 字、正向只剩 8 段）。合并时按 `,` 切分去重、用户写的在前、不换行追加 —— 负面词重复会互相抵消。
- **挑不中就不并**。三档里的 `none` 是刻意留的：目录里全是散文时，把散文塞进 prompt 只会污染出图，还会让用户以为插件「读懂了」。此时只报告「N 篇候选里没有像这个 LoRA 的提示词文档」并给出前几名分数，让人自己去补一篇。

**为什么子目录也要扫**：真实的整理习惯是按角色或画风分文件夹（`belle_anima_v1/角色.md`），只扫根目录会漏掉大部分文档。所以递归最多 3 层，`rel`（子目录/文件名）也参与「文件名」那一档打分 —— 文件夹名就是 LoRA 名时，里面那篇照样命中。代价是可能扫到不该扫的东西，因此有三道闸：扩展名白名单、单文件 256 KB 上限、以及**目录留空时一个文件都不读**。打分侧另有两道闸（前 120 篇 / 累计 4 MB），触到时不再往下读，并把「另有 N 篇没参与打分」写进结果 —— 少看几篇本身能接受，**安静地少看**不行。

**为什么不认 `【一】【三】` 这种分节标记**：真实的中文提示词清单几乎都没有 `#` 标题，而是用 `【三】Common prompt`、`【四】Clothes prompt`、`【六】可直接复制的完整 prompt` 分节 —— 一节里是通用角色本体，另一节里是五套服装的完整 tag，还有一节是速查表。任何「取第一个命中 prompt 字样的节」都会丢掉另外几节，比「全文 + 逐行挑 tag」更差；而「把这些节按什么顺序合并」没有数据能验证。所以 `headingRe` 仍然只认 Markdown 标题，`【…】` 出现在正文里也不影响 —— 1.9.0 之后这也不再是问题：不管有没有小标题，tag 行都是逐行判定的，`【六】可直接复制的完整 prompt` 下面那些 `正面：` 段落照样会被挑中（它们本来就在 tag 行列表里）。分节标记在 1.9.0 里只承担一个职责：把「负面 / 正面」状态复位回正面。

**为什么同目录摆放要单独当一条证据**：`readLoraDocs` 在每一层先扫一遍本层文件，把扩展名命中 `LORA_MODEL_EXTS`（`.safetensors` / `.ckpt` / `.pt` / `.pth` / `.bin` / `.gguf` / `.sft`）的模型名规范化后记成该层文档的 `siblings`。这样 `铃/belle_anima_v1.safetensors` + `铃/绝区零 铃.txt` 这种「名字毫不相干、但摆在一起」的情况也能被 `scoreDocForLora` 直接 +120 配对，不依赖正文碰巧提到 LoRA 名。模型文件本身永远不会被当成文档读，只用来建立这条配对线索。

**为什么留空时一个文件都不读**：这是用户明确要求的边界（「不选择路径默认不参考提示词」），也让升级零风险 —— 没配过这一栏的人，行为与上一版逐字节一致。

**剥扩展名必须走 `KNOWN_EXTS` 白名单**：`safetensors` 有 11 个字母，用「最后一个点之后 ≤8 个字母」判断会剥不掉，导致文件名匹配永远失败、全部退回通用文档（这个 bug 在写测试时被抓到）。

### `lora: "auto"`：为什么让插件去认角色名，而不是让模型自己挑

起因是一次真实的失败：用户在绘图模式里说「画个四季夏目的图」，agent（`deepseek-v4.1-flash`）连着跑了两次 `comfy_run`，**都没传 `lora`**，于是两次都既没挂 LoRA、也没读提示词文档，而结果文本里一个字都没提。翻它的思考记录能看到原因：

```
There's a LoRA "natsume-000016.safetensors" — could be relevant for 四季夏目.
But the LoRA toggle must be on in the input box controls.
Per instructions: "LoRA 没开就不要给 comfy_run 传 lora". … I can't enable the toggle myself.
```

三条事实叠在一起：① 它**看不到** `draw.lora` 是开还是关；② 系统提示和 `preset-draw` 人格都写着「LoRA 没开就别传」；③ `comfy_run` 里查文档的整块逻辑被 `if (args.lora)` 短路。于是「谨慎」直接变成「什么都不做」，而且静默。同一次会话里它还在思考中比较 `Illustrious / 光辉` 类 checkpoint —— 因为它同样看不到 `draw.unet` 是 `anima-base-v1.0`，只能靠世界知识猜，而系统提示里恰好点名了这两个例子。

修法分两半：

```
comfy_run / comfy_review 收到 lora: "auto"
        ↓
client.modelIndex → loras 名单（读不到就说明原因，不挂）
        ↓
loraAliases(file, docs) → 每个 LoRA 的别名
        ↑ 文件名 token（natsume-000016 → natsume）+ 同目录文档的标题/括号/正文名
matchLoraForPrompt(prompt, loras, docs) → 在 prompt 里找别名
        ↓
唯一命中 → 当成传了那个文件名，照常查文档、并 tag、并负面
0 个 → 不挂，照常出图，结果里说「没认出…」并指路 comfy_models
≥2 个 → 不挂，列候选（各自命中哪个别名），让人自己挑
```

- **别名必须覆盖中文 / 日文 / 罗马音**（用户明确要求）。真实文档的第二行几乎都是 `四季夏目（四季 ナツメ / Shiki Natsume）` 这种三段式标题，一行就能产出七个别名。繁简不用额外转换 —— 这类标题里两种写法通常并排出现（`谷风天音（谷風天音 / Tanikaze Amane）`）。反过来，**文档里没写过的写法认不出**（比如 `カナヲ`），这是有意的：宁可不认，也不要靠模糊匹配猜错角色。
- **`docAliases` 只看第一行非装饰行或第一个 Markdown 标题**。一路往下找短行会把 `绝区零 铃.txt` 里的 `Base outfit` / `Summer Skies` 当成角色名，于是 `summer outfit` 这种 prompt 会误命中角色 LoRA。纯 ASCII 多词短行还要求全小写或全大写才算名字。
- **认出多个不替你猜**。`画个四季夏目和因幡巡` 会列两个候选。挑错角色比不挂 LoRA 更糟 —— 不挂至少用户能看出「这次没用 LoRA」，挑错则是静默出错。
- **挑不中时必须把 `args.lora` 清成 `undefined`**。留着字符串 `"auto"` 会同时触发两个错误：拿 `"auto"` 去查一篇不存在的文档，以及在 `buildTxt2Img` 里生成一个 `lora_name="auto"` 的 `LoraLoader` 节点。这条是 `test/registration.test.mjs` 的 auto 用例抓出来的。
- **`comfy_models` 开头报「当前绘图配置」**。系统提示的文本函数只拿得到 `{ scope }`（`@deepseek-ai/dsh-system-prompt` 的 `resolveContext` 不给 sessionId / agentPreset），没法按会话注入 `draw.unet`；所以「现在到底用哪个模型、LoRA 能不能挂、目录配了没」只能由工具返回来回答。同时把系统提示与人格里点名 checkpoint 的句子删掉 —— 那些名字只会诱导模型去比较它没选的东西。
- **没传 `lora` 时结果里补一行交代**。之前这种情况完全静默：`loraDocNote` 保持空串，行都不出现。现在明说「这次没传 lora，没读文档」并指路 `lora:"auto"` —— 「什么都没发生」必须能被看出来。


## 失败模式与报错约定

所有 HTTP / 图构造错误统一抛 `ComfyError`，带 `code` 区分来源：

| code | 什么时候 |
| --- | --- |
| `NETWORK` | 连不上 ComfyUI（服务没起、地址写错） |
| `HTTP` | 状态码非 2xx，带 `status` |
| `GRAPH` | 工作流构造失败（参数非法、节点图不合法） |
| `TIMEOUT` | 超过 `timeoutMs` 或 `maxWaitSeconds` |

`explain(error)` 把它们翻成人话再进工具返回值 —— 模型看到的是「ComfyUI 没起来，先确认服务在 127.0.0.1:8188 上」而不是一堆栈。

`ComfyError` 的 `detail` 保留原始响应体，方便在探针里断言，但**不进**给模型的文本。

## 性能数字

在一台消费级显卡上实测（仅作参考，不是承诺 —— 你的机器可能快也可能慢）：

| 操作 | 耗时 |
| --- | --- |
| `comfy_status` / `comfy_models` / `comfy_node` | 数十毫秒 |
| 512×512 / 4 步出图 | 约 3 秒 |
| 1024×1024 / 30 步出图 | 几十秒到两分钟 |
| `npm test`（121 条纯单测） | 约 1 秒 |

所以 `comfy_result` 的 `wait_seconds` 要按尺寸给：512 给 30 就够，1024 给 120，多张按张数加。显存吃紧时 batch 保持 1，要腾地方用 `comfy_control free_vram`。
