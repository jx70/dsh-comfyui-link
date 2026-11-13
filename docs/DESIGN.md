# dsh-comfyui-bridge 设计说明

这份文档讲实现：**为什么是这么写的**，以及改代码前必须知道的边界。上手怎么用看 [README](../README.md)。

- [三层结构](#三层结构)
- [为什么审图模型必须由宿主开路由](#为什么审图模型必须由宿主开路由)
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
│ client.js   浏览器半端（设置页那一页）          │
│   ctx.slots.register('settings.section')       │
│   ctx.configForms.get('comfyui')               │
│   fetch('/api/comfyui/vision-models')          │
└───────────────────────┬───────────────────────┘
                        │ HTTP（带浏览器 cookie）
┌───────────────────────▼───────────────────────┐
│ index.js    Host 插件                          │
│   export const name / inject / Config          │
│   ctx.tools.register(...) × 8                  │
│   ctx.systemPrompt.section(...)                │
│   ctx.connection.fetch.register(vision route)  │
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
- `client.js` 拿不到宿主服务（client 侧没有 `llm` / `tools`），所以它需要的一切数据都得由 host 侧开路由送过去。

## 为什么审图模型必须由宿主开路由

设置页要列「能看图的模型」，这份清单在宿主里（`llm.listProviders()` / `listModels()` / `resolveModelInfo()`）。但浏览器半端拿不到 `llm` 服务，只能让 host 侧开一条只读路由。

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
  log('没有 connection.fetch，设置页的模型清单路由挂不上（审图模型改成跟随当前会话）')
  return
}
scope.effect(() => connection.fetch.register({
  path: '/api/comfyui/vision-models',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: handler,
}))
```

注册在栅栏**内部**，鉴权由栅栏自己做完，handler 只管数据。所以 handler 里不要再自己判 cookie。

**降级路径**：没有 `connection`（旧版宿主、或者极简 ctx）时只记一行日志就返回，8 个工具照常注册。设置页的下拉框会取不到清单，退化成「跟随当前会话模型」。这条路径由 `test/registration.test.mjs` 里的「删掉 ctx.connection 后 routes 为空但 tools.size 仍 8」钉住。

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
│   用 new_prompt 重画（沿用底图尺寸与 LoRA 设置）
└── 第 1..maxAttempts 轮：同上
```

几个实现细节：

- **审图模型来自设置页**：`review.provider` / `review.model`，两个都留空则回退到当前会话的模型（`exec.agent.options`）。所以「审图模型」和「画图的模型」可以是两个不同的模型。
- **参考图不是要求的一部分**：`reference_prompt_id` 的图只是拿来比对的参照物，图里的内容（比如参考图是海边）不该被算进「必须还原」的要求里。提示词里明确写了这一点，否则模型会拿参考图的背景当要求。
- **模型输出是 JSON**：`llm.stream()` 收 `text-delta` 拼起来再 `JSON.parse`。解析失败按「不满意 + 无新提示词」处理，不会崩。
- **`maxAttempts` 的语义是「重画次数」**，不含首轮。所以 `maxAttempts=1` 最多出 2 张图（首图 + 1 次重画）。

## volatile 字段与热生效

```js
export const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8188'),
  review: z.object({ enabled, provider, model, maxAttempts, extra }).volatile(),
  img2img: z.object({ enabled }).volatile(),
  lora: z.object({ enabled }).volatile(),
  upscale: z.object({ enabled }).volatile(),
})
```

`.volatile()` 的字段在 `apply()` 里拿到的是 **cosmokit 引用对象**，不是普通值：

```js
function unwrapVolatile(value) {
  if (value && typeof value.get === 'function') return value.get()
  return value
}
```

必须解包才能拿到当前值，否则拿到的是个对象、`enabled` 永远是 `undefined`。解包这一步是「设置页改了立即生效、不用重启」的全部机制 —— 每次工具调用时现读，所以改完下一次调用就生效。

`baseUrl` **没有** `.volatile()`：它是静态配置，改了要重载插件。设置页里也不显示它。

## 开关拦截

三个功能各有开关，关着的时候对应入口要**在发起 HTTP 之前**就报错，而不是等 ComfyUI 那边失败：

| 开关 | 拦的是什么 | 报错 |
| --- | --- | --- |
| `img2img.enabled` | `comfy_run` 的 `mode="img2img"` | 提示去设置页开启 |
| `lora.enabled` | `comfy_run` 的 `lora` 参数、`comfy_review` 的 `lora` 参数 | 同上 |
| `upscale.enabled` | `comfy_upscale` 整个工具 | 同上 |

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

在一台 8 GiB 显存的消费级显卡上实测（仅作参考，不是承诺 —— 你的机器可能快也可能慢）：

| 操作 | 耗时 |
| --- | --- |
| `comfy_status` / `comfy_models` / `comfy_node` | 数十毫秒 |
| 512×512 / 4 步出图 | 约 3 秒 |
| 1024×1024 / 30 步出图 | 几十秒到两分钟 |
| `npm test`（40 条纯单测） | 约 1 秒 |

所以 `comfy_result` 的 `wait_seconds` 要按尺寸给：512 给 30 就够，1024 给 120，多张按张数加。显存吃紧时 batch 保持 1，要腾地方用 `comfy_control free_vram`。
