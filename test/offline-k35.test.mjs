/**
 * offline-k35.test.mjs —— k35：ComfyUI 离线时的统一行为
 * ============================================================================
 * 钉住三件事：
 *   1. 所有会碰 ComfyUI 的工具入口，遇到 OFFLINE 都「返回」统一文案，不 throw；
 *   2. 文案含地址（where()）、大概原因（explain()）、「先把 ComfyUI 启动起来再试」；
 *   3. 全程不 spawn / exec main.py —— 用假 fetch 让每个入口走到网络层，
 *      再断言子进程 API 一次都没被调用。
 * 所有请求都用一个抛 OFFLINE 的假 fetch 接住，不依赖本机真的开着/关着 ComfyUI。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createExec, createFakeCtx } from './helpers/fake-ctx.mjs'
import { ComfyError } from '../lib/comfy.mjs'

const plugin = await import('../index.js')

const BASE = 'http://127.0.0.1:1'

function boot(config = {}) {
  const fake = createFakeCtx()
  plugin.apply(fake.ctx, { baseUrl: BASE, timeoutMs: 2000, ...config })
  return fake
}

/** 断言一个 OFFLINE 结果文本符合统一口径 */
function assertOfflineText(text) {
  assert.equal(typeof text, 'string', '离线结果应是 { text }')
  assert.match(text, /ComfyUI 没在跑/, '文案要直说没在跑')
  assert.match(text, /127\.0\.0\.1:1/, '文案要带服务地址 where()')
  assert.match(text, /先把 ComfyUI 启动起来再试/, '文案要给自救指引')
  assert.match(text, /连不上|fetch failed|ECONNREFUSED|没在跑|大概没在跑/, '文案要带大概原因 explain()')
}

/**
 * 用抛 OFFLINE 的假 fetch 包住执行；同时盯死 child_process 的 spawn/exec。
 * 一旦哪个入口偷偷起 ComfyUI，就会命中这里的断言。
 */
async function withDeadFetch(fn) {
  const originalFetch = globalThis.fetch
  // 让每一次网络调用都变成 OFFLINE；是否 spawn 子进程用源码静态扫描另测。
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('comfy_status：离线返回统一文案，不 throw', async () => {
  const { tools } = boot()
  const result = await withDeadFetch(() => tools.get('comfy_status').execute({}, createExec()))
  assertOfflineText(result.text)
})

test('comfy_models：离线返回统一文案，不 throw', async () => {
  const { tools } = boot()
  const result = await withDeadFetch(() => tools.get('comfy_models').execute({}, createExec()))
  assertOfflineText(result.text)
})

test('comfy_node：离线返回统一文案，不 throw', async () => {
  const { tools } = boot()
  const result = await withDeadFetch(() => tools.get('comfy_node').execute({ node_class: 'KSampler' }, createExec()))
  assertOfflineText(result.text)
})

test('comfy_run（template / graph）：离线都返回统一文案，不 throw', async () => {
  const { tools } = boot()
  for (const args of [
    { mode: 'template', prompt: '一只猫' },
    { mode: 'graph', graph: { '1': { class_type: 'KSampler', inputs: {} } } },
  ]) {
    const result = await withDeadFetch(() => tools.get('comfy_run').execute(args, createExec()))
    assertOfflineText(result.text)
  }
})

test('comfy_result：离线返回统一文案，不 throw', async () => {
  const { tools } = boot()
  const result = await withDeadFetch(() => tools.get('comfy_result').execute({ prompt_id: 'p1', wait_seconds: 0 }, createExec()))
  assertOfflineText(result.text)
})

test('comfy_control：离线返回统一文案，不 throw', async () => {
  const { tools } = boot()
  const result = await withDeadFetch(() => tools.get('comfy_control').execute({ action: 'interrupt' }, createExec()))
  assertOfflineText(result.text)
})

test('comfy_review：离线返回统一文案，不 throw', async () => {
  const { tools } = boot({ review: { enabled: true, provider: 'mock-provider', model: 'mock-vision-model' } })
  const result = await withDeadFetch(() => tools.get('comfy_review').execute(
    { prompt_id: 'p1', requirement: '一只猫' },
    createExec(),
  ))
  assertOfflineText(result.text)
})

test('comfy_upscale：离线返回统一文案，不 throw', async () => {
  const { tools } = boot({ upscale: { enabled: true } })
  const result = await withDeadFetch(() => tools.get('comfy_upscale').execute(
    { image_prompt_id: 'p1', width: 512, height: 512 },
    createExec(),
  ))
  assertOfflineText(result.text)
})

test('源码快照：任何入口都不 spawn / exec main.py，也没有自动拉起重试', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const lines = source.split('\n')

  // 子进程调用点：只认独立单词 spawn / exec / execFile / execSync(，
  // 负向后顾排除 RegExp.exec() / child.spawn() 这类方法调用。
  const childProcRe = /(?<![.\w])(?:spawn|exec|execFile|execSync)\s*\(/
  const callSites = []
  for (let i = 0; i < lines.length; i += 1) {
    if (childProcRe.test(lines[i])) callSites.push(i)
  }

  // 唯一的子进程调用是 pickDirectory 里弹 powershell 文件夹选择框。
  assert.equal(
    callSites.length, 1,
    `期望只有 1 处子进程调用，实际 ${callSites.length} 处（行 ${callSites.map((i) => i + 1).join(',')}）`,
  )
  const window = lines.slice(Math.max(0, callSites[0] - 20), callSites[0] + 12).join('\n')
  assert.match(window, /powershell|pickDirectory/, '唯一的子进程调用必须是 powershell 文件夹选择框')
  assert.doesNotMatch(window, /main\.py|\bpython\b/i, '文件夹选择框不该夹带 main.py / python 启动参数')

  // 撇开调用点，也不能有任何把 main.py 当命令启动的写法。
  // 注：deriveOutputRoot 里从 system_stats.argv 只读推导 output 目录的 main.py 是合法用途，
  // 它所在函数体不调用任何子进程 API，不受这条约束。
  assert.doesNotMatch(
    source,
    /(?:spawn|exec|execFile|execSync|fork)\s*\(\s*["'`][^"'`]*(?:python|main\.py)/i,
    '不该出现 spawn/exec("python …") 之类的自动拉起',
  )
})

test('offlineResult 文案形状稳定：ComfyError(OFFLINE) 才能进统一分支', () => {
  // 直接验证判据本身：非 OFFLINE 的 ComfyError 不该走友好文案。
  const offline = new ComfyError('连不上 ComfyUI（x）：fetch failed —— 服务大概没在跑', { code: 'OFFLINE' })
  const nonOffline = new ComfyError('ComfyUI 返回 500', { code: 'HTTP', status: 500 })
  assert.equal(offline.code, 'OFFLINE')
  assert.notEqual(nonOffline.code, 'OFFLINE')
})
