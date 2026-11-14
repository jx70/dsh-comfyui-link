# dsh-comfyui-link 设计说明

这份文档讲实现：**为什么是这么写的**，以及改代码前必须知道的边界。上手怎么用看 [README](../README.md)。

- [三层结构](#三层结构)
- [为什么模型清单必须由宿主开路由](#为什么模型清单必须由宿主开路由)
- [为什么「选择目录」要开一条 POST 路由，而且它会阻塞](#为什么选择目录要开一条-post-路由而且它会阻塞)
- [桌面端：两条 preload 桥](#桌面端两条-preload-桥)
- [工作流构造](#工作流构造)
- [审图重生成的状态机](#审图重生成的状态机)
- [volatile 字段与热生效](#volatile-字段与热生效)
- [开关拦截](#开关拦截)
- [输出图怎么交回模型](#输出图怎么交回模型)
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

输入框左侧的绘图控件要的是另一份清单：ComfyUI 的 `diffusion_models` / `text_encoders` / `vae` / `loras` 文件名。那份东西在 `client.modelIndex()` 里，浏览器同样拿不到（还要防 CORS），所以再开一条 `/api/comfyui/draw-models`。三条路由（含后面那节讲的 `POST /api/comfyui/pick-directory`）都由 `mountDataRoutes` 里各自的 `scope.effect` 注册。

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
  path: '/api/comfyui/pick-directory',
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: pickHandler,
}))
```

注册在栅栏**内部**，鉴权由栅栏自己做完，handler 只管数据。所以 handler 里不要再自己判 cookie。

`/api/comfyui/draw-models` 与审图那条的区别：它读的是 ComfyUI 的模型列表，所以会真的打一次 `client.modelIndex()`。ComfyUI 没跑时返回 502 + `{ok:false,error,folders:{}}`，前端据此显示「读不到 ComfyUI 模型清单」，下拉退化成只剩「自动」一项 —— 不会因为 ComfyUI 掉线把整个输入框卡住。

**降级路径**：没有 `connection`（旧版宿主、或者极简 ctx）时只记一行日志就返回，8 个工具照常注册。设置页的下拉框会取不到清单，退化成「跟随当前会话模型」，绘图控件的下拉也只剩「自动」，输出目录只能在 profile 的 `cordis.patch.yml` 里配。这条路径由 `test/registration.test.mjs` 里的「删掉 ctx.connection 后 routes 为空但 tools.size 仍 8」钉住。

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

### 为什么是 UNETLoader + CLIPLoader + VAELoader

内置模板不用 `CheckpointLoaderSimple`，而是三个 loader 分开加载。原因是现在常见的组织方式就是 UNET + 独立的文本编码器 + 独立的 VAE（尤其是 Qwen-Image、Flux 这类），而 `checkpoints` 目录经常是空的。三个 loader 的写法对「三个目录各有文件」的部署最稳。

用 `checkpoints` 组织方式的用户走 `mode="graph"` 传自己的工作流，这是明确的设计取舍，不是漏做。

### 节点图（`buildTxt2Img`，9 节点）

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

默认值：1024×1024、30 步、CFG 4.9、`euler` / `simple`、denoise 1。

挂 LoRA 时插一个节点 `10`（`LoraLoader`），并把 `4` / `5` 的 `clip` 输入与 `7` 的 `model` 输入改接到它上面：

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
- **重画用哪个扩散模型**：`draw.unet`（绘图控件选的那个）；没选就退回 `diffusion_models` 里第一个。这样「审图不满意 → 重画」出来的仍是同一风格，不会忽然换成文件夹里第一个模型。
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
| `npm test`（83 条纯单测） | 约 1 秒 |

所以 `comfy_result` 的 `wait_seconds` 要按尺寸给：512 给 30 就够，1024 给 120，多张按张数加。显存吃紧时 batch 保持 1，要腾地方用 `comfy_control free_vram`。
