/**
 * polling-k37.test.mjs —— k37：轮询卡住时不再空转，超时/状态丢失都给可读反馈
 * ============================================================================
 * 钉住五件事：
 *   1. 正常 pending→in_progress→completed 路径照常结束；
 *   2. /api/jobs 变 404 但 history 有记录 → 视为完成，不空转到 deadline；
 *   3. /api/jobs、history、/queue 三处都找不到 → reason='lost'，comfy_result 返回明确文案；
 *   4. wait_seconds 到期仍在跑 → 超时文案含「还在跑 / wait_seconds / comfy_status / 队列快照」；
 *   5. AbortSignal 触发 → 抛 CANCELLED，循环停止，无悬挂 await。
 * 所有请求走假 fetch，按 URL 分派脚本，不依赖本机 ComfyUI。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createClient } from '../lib/comfy.mjs'
import { createExec, createFakeCtx } from './helpers/fake-ctx.mjs'

const plugin = await import('../index.js')
const BASE = 'http://127.0.0.1:1'
const PROMPT = 'p-k37'

function boot(config = {}) {
  const fake = createFakeCtx()
  plugin.apply(fake.ctx, { baseUrl: BASE, timeoutMs: 2000, pollMs: 30, ...config })
  return fake
}

function json(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) }
}

/**
 * 装一个按 URL 分派的假 fetch。
 * handlers: { '/api/jobs/p-k37': (n) => job|null, '/history/p-k37': fn, '/queue': fn }
 * 每次请求对应路径的 handler 会被调用（参数是这个路径被请求的序号）。
 */
function withFetch(handlers, fn) {
  const originalFetch = globalThis.fetch
  const counts = {}
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    counts[path] = (counts[path] ?? 0) + 1
    const handler = handlers[path]
    if (!handler) throw new Error(`假 fetch 没有 handler：${path}`)
    const out = handler(counts[path])
    if (out === null) return json({}, 404)
    if (out && out.__status) return json(out.body ?? {}, out.__status)
    return json(out)
  }
  return Promise.resolve().then(() => fn(counts)).finally(() => { globalThis.fetch = originalFetch })
}

const historyWithImage = {
  [PROMPT]: {
    status: { status_str: 'success' },
    outputs: { 9: { images: [{ filename: 'k37.png', subfolder: '', type: 'output' }] } },
  },
}

test('normalizeStatus：各版本状态归一到终态/中间态', () => {
  const n = plugin.normalizeStatus
  assert.equal(n('success'), 'completed')
  assert.equal(n('COMPLETED'), 'completed')
  assert.equal(n('error'), 'failed')
  assert.equal(n('execution_error'), 'failed')
  assert.equal(n('interrupted'), 'cancelled')
  assert.equal(n('execution_interrupted'), 'cancelled')
  assert.equal(n('in_progress'), 'in_progress')
  assert.equal(n('running'), 'in_progress')
  assert.equal(n('brand_new_status'), 'brand_new_status')
})

test('正常路径：pending → in_progress → completed 正常结束', async () => {
  const client = createClient({ baseUrl: BASE, timeoutMs: 1000 })
  const waiter = plugin.createJobWaiter(client, { pollMs: 5, maxWaitSeconds: 5 })
  await withFetch({
    '/api/jobs/p-k37': (n) => (n <= 2 ? { id: PROMPT, status: n === 1 ? 'pending' : 'in_progress' } : { id: PROMPT, status: 'completed' }),
  }, async () => {
    const r = await waiter(PROMPT, { signal: AbortSignal.timeout(2000), deadline: Date.now() + 2000 })
    assert.equal(r.reason, 'finished')
    assert.equal(r.job.status, 'completed')
  })
})

test('状态消失但 history 有记录：视为完成，不空转', async () => {
  const client = createClient({ baseUrl: BASE, timeoutMs: 1000 })
  const waiter = plugin.createJobWaiter(client, { pollMs: 5, maxWaitSeconds: 5 })
  await withFetch({
    '/api/jobs/p-k37': () => null,
    '/history/p-k37': () => historyWithImage,
  }, async (counts) => {
    const r = await waiter(PROMPT, { signal: AbortSignal.timeout(2000), deadline: Date.now() + 2000 })
    assert.equal(r.reason, 'finished')
    assert.equal(r.job.status, 'completed')
    assert.ok(counts['/api/jobs/p-k37'] >= 1)
  })
})

test('三处都找不到：reason=lost，comfy_result 返回明确文案', async () => {
  const client = createClient({ baseUrl: BASE, timeoutMs: 1000 })
  const waiter = plugin.createJobWaiter(client, { pollMs: 5, maxWaitSeconds: 5 })
  await withFetch({
    '/api/jobs/p-k37': () => null,
    '/history/p-k37': () => null,
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  }, async () => {
    const r = await waiter(PROMPT, { signal: AbortSignal.timeout(2000), deadline: Date.now() + 2000 })
    assert.equal(r.reason, 'lost')
    assert.equal(r.job, null)
  })

  // comfy_result 的初查也会先撞 history 缺失，这里用 job 先给一个 in_progress，
  // 再让它消失，以此覆盖「等待过程中丢失」的分支。
  const { tools } = boot({ pollMs: 5 })
  const result = await withFetch({
    '/api/jobs/p-k37': (n) => (n === 1 ? { id: PROMPT, status: 'in_progress' } : null),
    '/history/p-k37': () => null,
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  }, async () => tools.get('comfy_result').execute(
    { prompt_id: PROMPT, wait_seconds: 3 },
    createExec({ timeoutMs: 4000 }),
  ))
  assert.match(result.text, /状态从 ComfyUI 消失了/)
  assert.match(result.text, /comfy_status/)
})

test('deadline 到期仍在跑：超时文案带队列快照与自救建议', async () => {
  const { tools } = boot({ pollMs: 5 })
  const result = await withFetch({
    '/api/jobs/p-k37': () => ({ id: PROMPT, status: 'in_progress' }),
    '/queue': () => ({ queue_running: [{ 1: 'x' }], queue_pending: [[1, PROMPT]] }),
  }, async () => tools.get('comfy_result').execute(
    { prompt_id: PROMPT, wait_seconds: 1 },
    createExec({ timeoutMs: 3000 }),
  ))
  assert.match(result.text, /还在跑/)
  assert.match(result.text, /comfy_status/)
  assert.match(result.text, /wait_seconds/)
  assert.match(result.text, /队列：正在跑 1 个，排队 1 个/)
})

test('AbortSignal 触发：抛 CANCELLED，循环立即停止', async () => {
  const client = createClient({ baseUrl: BASE, timeoutMs: 1000 })
  const waiter = plugin.createJobWaiter(client, { pollMs: 5, maxWaitSeconds: 60 })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 60)
  await withFetch({
    '/api/jobs/p-k37': () => ({ id: PROMPT, status: 'in_progress' }),
  }, async () => {
    const start = Date.now()
    await assert.rejects(
      () => waiter(PROMPT, { signal: ac.signal, deadline: Date.now() + 60000 }),
      (err) => err?.code === 'CANCELLED',
    )
    assert.ok(Date.now() - start < 2000, 'abort 后应快速退出，不应空转到 deadline')
  })
})

test('源码快照：submitAndFetch 超时分支给出明确文案，不再直接取图', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('async function submitAndFetch'), source.indexOf('function registerComfyTool'))
  assert.match(block, /等待任务.*超时/)
  assert.match(block, /comfy_status/)
  // 超时/lost 分支必须在 fetchImageRef 之前 return/throw
  const throwAt = block.indexOf("reason === 'timeout'")
  const lostAt = block.indexOf("reason === 'lost'")
  const fetchAt = block.indexOf('fetchImageRef(promptId')
  assert.ok(throwAt >= 0 && lostAt >= 0 && fetchAt > lostAt, '超时与丢失分支必须先于取图')
})
