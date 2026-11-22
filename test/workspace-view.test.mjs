/**
 * workspace-view.test.mjs —— k91 会话视图「ComfyUI」页的回归测试
 * ============================================================================
 * 覆盖：
 *   · extractWorkflowParams / applyWorkflowParams：从 API 图抽参数、写回原图
 *   · 旁侧索引：append / findByPromptId / findByFilename / recent / 坏行跳过
 *   · resolveWorkflow：索引优先 → history 兜底 → 查不到给可读原因
 *   · 4 条 workspace 路由都注册上
 *   · snapshot / workflow / image / submit 路由的实际行为
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFakeCtx } from './helpers/fake-ctx.mjs'
import {
  applyWorkflowParams,
  createWorkspaceStore,
  extractWorkflowParams,
  resolveWorkflow,
  safeFilename,
} from '../lib/workspace-store.mjs'

const plugin = await import('../index.js')

const GRAPH = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, lowres', clip: ['1', 1] } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 768, batch_size: 1 } },
  '5': {
    class_type: 'KSampler',
    inputs: {
      seed: 12345, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal',
      positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], model: ['1', 0],
    },
  },
}

// ── 参数抽取 / 写回 ──────────────────────────────────────────────────────

test('extractWorkflowParams 按连线找到正负提示词与采样参数', () => {
  const p = extractWorkflowParams(GRAPH)
  assert.equal(p.prompt, 'a cat')
  assert.equal(p.negative, 'blurry, lowres')
  assert.equal(p.width, 1024)
  assert.equal(p.height, 768)
  assert.equal(p.steps, 20)
  assert.equal(p.cfg, 7)
  assert.equal(p.seed, 12345)
  assert.equal(p.sampler, 'euler')
  assert.equal(p.scheduler, 'normal')
  assert.equal(p.model, 'model.safetensors')
  assert.equal(p.nodes.samplerId, '5')
  assert.equal(p.nodes.latentId, '4')
  assert.equal(p.nodes.positiveId, '2')
  assert.equal(p.nodes.negativeId, '3')
})

test('applyWorkflowParams 只改参数，不动节点 id 与连线', () => {
  const p = extractWorkflowParams(GRAPH)
  const next = applyWorkflowParams(GRAPH, {
    ...p,
    prompt: 'a dog', width: 800, steps: 30, cfg: 4.5, seed: 999,
  })
  assert.equal(next['2'].inputs.text, 'a dog')
  assert.equal(next['3'].inputs.text, 'blurry, lowres')
  assert.equal(next['4'].inputs.width, 800)          // 800 按 16 对齐 → 800
  assert.equal(next['4'].inputs.height, 768)
  assert.equal(next['5'].inputs.steps, 30)
  assert.equal(next['5'].inputs.cfg, 4.5)
  assert.equal(next['5'].inputs.seed, 999)
  assert.equal(next['5'].inputs.positive[0], '2')     // 连线没变
  assert.notEqual(next, GRAPH)                          // 返回副本，不改原图
  assert.equal(GRAPH['2'].inputs.text, 'a cat')
})

test('applyWorkflowParams 改已有 LoRA 节点的名字与强度', () => {
  const graph = structuredClone(GRAPH)
  graph['6'] = { class_type: 'LoraLoader', inputs: { lora_name: 'old.safetensors', strength_model: 1, strength_clip: 1, model: ['1', 0], clip: ['1', 1] } }
  const p = extractWorkflowParams(graph)
  assert.equal(p.lora.length, 1)
  const next = applyWorkflowParams(graph, {
    ...p,
    lora: [{ id: '6', name: 'new.safetensors', strengthModel: 0.7, strengthClip: 0.6 }],
  })
  assert.equal(next['6'].inputs.lora_name, 'new.safetensors')
  assert.equal(next['6'].inputs.strength_model, 0.7)
  assert.equal(next['6'].inputs.strength_clip, 0.6)
})

test('applyWorkflowParams 增删 LoRA 时重建 model/clip 链并保持连线', () => {
  // 基座 checkpoint → LoraLoader → KSampler/CLIPTextEncode 的标准链
  const graph = structuredClone(GRAPH)
  graph['6'] = {
    class_type: 'LoraLoader',
    inputs: { lora_name: 'a.safetensors', strength_model: 1, strength_clip: 1, model: ['1', 0], clip: ['1', 1] },
  }
  graph['2'].inputs.clip = ['6', 1]
  graph['3'].inputs.clip = ['6', 1]
  graph['5'].inputs.model = ['6', 0]
  const p = extractWorkflowParams(graph)
  assert.equal(p.lora.length, 1)

  // 加一个 LoRA（新项无 id），应插两个节点：链头指向基座，链尾接回消费者
  const added = applyWorkflowParams(graph, {
    ...p,
    lora: [
      { id: '6', name: 'a.safetensors', strengthModel: 1, strengthClip: 1 },
      { id: '', name: 'b.safetensors', strengthModel: 0.6, strengthClip: 0.7 },
    ],
  })
  const loraIds = Object.keys(added).filter((id) => added[id].class_type === 'LoraLoader')
  assert.equal(loraIds.length, 2, '应有两个 LoRA 节点')
  const newId = loraIds.find((id) => added[id].inputs.lora_name === 'b.safetensors')
  assert.ok(newId)
  assert.deepEqual(added[newId].inputs.model, ['6', 0], '新 LoRA 接在旧 LoRA 之后')
  assert.equal(added[newId].inputs.strength_model, 0.6)
  assert.equal(added[newId].inputs.strength_clip, 0.7)
  assert.deepEqual(added['5'].inputs.model, [newId, 0], 'KSampler.model 改指向新链尾')
  assert.deepEqual(added['2'].inputs.clip, [newId, 1], 'CLIP.clip 改指向新链尾')

  // 全删 LoRA，应退回基座 checkpoint，消费者直连 ['1',0] / ['1',1]
  const removed = applyWorkflowParams(graph, { ...p, lora: [] })
  const loraAfter = Object.keys(removed).filter((id) => removed[id].class_type === 'LoraLoader')
  assert.equal(loraAfter.length, 0, 'LoRA 节点应全删')
  assert.deepEqual(removed['5'].inputs.model, ['1', 0], 'KSampler.model 退回基座')
  assert.deepEqual(removed['2'].inputs.clip, ['1', 1], 'CLIP.clip 退回基座')
  // 原图不被修改
  assert.ok(graph['6'], '原图仍有原 LoRA 节点')
})

test('safeFilename 拒绝路径穿越与绝对路径', () => {
  assert.equal(safeFilename('ComfyUI_00001.png'), 'ComfyUI_00001.png')
  assert.equal(safeFilename('../secret.png'), '')
  assert.equal(safeFilename('a/b.png'), '')
  assert.equal(safeFilename('C:\\x.png'), '')
  assert.equal(safeFilename(''), '')
})

// ── 旁侧索引 ──────────────────────────────────────────────────────────────

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'k91-ws-'))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('索引：append / findByPromptId / findByFilename / recent，坏行跳过', async () => {
  await withTempRoot(async (root) => {
    const store = createWorkspaceStore({ root })
    await store.append({
      promptId: 'p1', graph: GRAPH, params: extractWorkflowParams(GRAPH),
      files: [{ filename: 'a.png', type: 'output', subfolder: '' }], title: 'first',
    })
    await store.append({
      promptId: 'p2', graph: GRAPH, params: extractWorkflowParams(GRAPH),
      files: [{ filename: 'b.png', type: 'output', subfolder: 'dsh' }], title: 'second',
    })
    assert.equal((await store.findByPromptId('p1'))?.title, 'first')
    assert.equal((await store.findByFilename('b.png'))?.promptId, 'p2')
    assert.equal((await store.findByFilename('nope.png')), null)
    assert.deepEqual((await store.recent(5)).map((e) => e.promptId), ['p2', 'p1'])

    // 写入一条半截坏行，readAll 应跳过它
    const file = await store.indexPath()
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(file, 'utf8')
    await writeFile(file, `${text}{"promptId":"broken"\n`, 'utf8')
    assert.equal(await store.findByPromptId('broken'), null)
    assert.equal((await store.findByPromptId('p1'))?.title, 'first')
  })
})

test('索引：updateFiles 去重合并，覆盖同文件名', async () => {
  await withTempRoot(async (root) => {
    const store = createWorkspaceStore({ root })
    await store.append({ promptId: 'p1', graph: GRAPH, files: [{ filename: 'a.png', type: 'output', subfolder: '' }] })
    await store.updateFiles('p1', [
      { filename: 'a.png', type: 'output', subfolder: '' },
      { filename: 'b.png', type: 'output', subfolder: '' },
    ])
    const hit = await store.findByPromptId('p1')
    assert.equal(hit.files.length, 2)
    assert.equal(await store.updateFiles('missing', [{ filename: 'x.png' }]), false)
  })
})

// ── 反查 ──────────────────────────────────────────────────────────────────

test('resolveWorkflow：索引命中优先，不碰 ComfyUI 历史', async () => {
  await withTempRoot(async (root) => {
    const store = createWorkspaceStore({ root })
    await store.append({ promptId: 'p1', graph: GRAPH, params: extractWorkflowParams(GRAPH), files: [{ filename: 'a.png', type: 'output', subfolder: '' }] })
    let historyCalled = false
    const client = {
      historyEntry: async () => { historyCalled = true; return null },
      history: async () => { historyCalled = true; return [] },
    }
    const result = await resolveWorkflow({ store, client, promptId: 'p1' })
    assert.equal(result.ok, true)
    assert.equal(result.source, 'index')
    assert.equal(result.promptId, 'p1')
    assert.equal(result.params.prompt, 'a cat')
    assert.equal(historyCalled, false)
  })
})

test('resolveWorkflow：索引没命中时走 history 兜底，按文件名找到 prompt', async () => {
  await withTempRoot(async (root) => {
    const store = createWorkspaceStore({ root })
    const client = {
      history: async () => [{ promptId: 'h1', entry: { prompt: [0, GRAPH, {}], outputs: { '9': { images: [{ filename: 'from-history.png', type: 'output' }] } } } }],
      historyEntry: async (id) => (id === 'h1' ? { prompt: [0, GRAPH, {}], outputs: {} } : null),
    }
    const byFile = await resolveWorkflow({ store, client, filename: 'from-history.png' })
    assert.equal(byFile.ok, true)
    assert.equal(byFile.source, 'history')
    assert.equal(byFile.promptId, 'h1')
    assert.equal(byFile.params.prompt, 'a cat')

    const byId = await resolveWorkflow({ store, client, promptId: 'h1' })
    assert.equal(byId.ok, true)
    assert.equal(byId.params.steps, 20)
  })
})

test('resolveWorkflow：查不到给可读提示，不抛错', async () => {
  const client = { historyEntry: async () => null, history: async () => [] }
  const byId = await resolveWorkflow({ client, promptId: 'missing-id' })
  assert.equal(byId.ok, false)
  assert.match(byId.reason, /missing-id/)
  const byFile = await resolveWorkflow({ client, filename: 'gone.png' })
  assert.equal(byFile.ok, false)
  assert.match(byFile.reason, /gone\.png/)
  const nothing = await resolveWorkflow({ client })
  assert.equal(nothing.ok, false)
})

// ── 路由注册与行为 ────────────────────────────────────────────────────────

function startFakeComfy() {
  const promptIds = []
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: { argv: ['/tmp/ComfyUI/main.py'] } }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/queue') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ queue_running: [[1, 'run-1', {}]], queue_pending: [[2, 'wait-1', {}]] }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/models/loras') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ name: 'detail_tuner.safetensors' }, { name: 'film.safetensors' }]))
      return
    }
    if (req.method === 'GET' && url.pathname === '/object_info/KSampler') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        KSampler: { input: { required: {
          sampler_name: [['euler', 'dpmpp_2m', 'ddim'], ''],
          scheduler: [['simple', 'karras', 'normal'], ''],
        } } },
      }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jobs: [{ id: 'run-1', status: 'completed' }, { id: 'wait-1', status: 'pending' }] }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        promptIds.push(JSON.parse(body))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ prompt_id: `fake-${promptIds.length}`, number: promptIds.length }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(id === 'hist-1' ? { 'hist-1': { prompt: [0, GRAPH, {}], outputs: {} } } : {}))
      return
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({}))
      return
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(png)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        promptIds,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function routeOf(routes, path) {
  return routes.find((r) => r.path === path)
}

test('4 条 workspace 路由都注册上', () => {
  const fake = createFakeCtx()
  plugin.apply(fake.ctx, {})
  for (const path of [
    '/api/comfyui/workspace/snapshot',
    '/api/comfyui/workspace/workflow',
    '/api/comfyui/workspace/image',
    '/api/comfyui/workspace/submit',
  ]) {
    assert.ok(routeOf(fake.routes, path), `缺路由 ${path}`)
  }
})

test('snapshot 路由：返回在线状态 / 队列 / jobs / 最近生成', async () => {
  const comfy = await startFakeComfy()
  try {
    await withTempRoot(async (root) => {
      const fake = createFakeCtx()
      plugin.apply(fake.ctx, { baseUrl: comfy.baseUrl, outputRoot: root })
      const route = routeOf(fake.routes, '/api/comfyui/workspace/snapshot')
      const res = await route.fetch(new Request('http://x/api/comfyui/workspace/snapshot'))
      const data = await res.json()
      assert.equal(data.ok, true)
      assert.equal(data.online, true)
      assert.equal(data.queue.running.length, 1)
      assert.equal(data.queue.pending.length, 1)
      assert.equal(data.jobs.length, 2)
      assert.equal(data.baseUrl, comfy.baseUrl)
      assert.deepEqual(data.samplers, ['euler', 'dpmpp_2m', 'ddim'])
      assert.deepEqual(data.schedulers, ['simple', 'karras', 'normal'])
      assert.equal(data.loras.length, 2)
      assert.equal(data.loras[0].name, 'detail_tuner.safetensors')
    })
  } finally { await comfy.close() }
})

test('workflow 路由：按 prompt_id 反查历史里的完整工作流', async () => {
  const comfy = await startFakeComfy()
  try {
    await withTempRoot(async (root) => {
      const fake = createFakeCtx()
      plugin.apply(fake.ctx, { baseUrl: comfy.baseUrl, outputRoot: root })
      const route = routeOf(fake.routes, '/api/comfyui/workspace/workflow')
      const hit = await route.fetch(new Request('http://x/api/comfyui/workspace/workflow?promptId=hist-1'))
      const data = await hit.json()
      assert.equal(data.ok, true)
      assert.equal(data.source, 'history')
      assert.equal(data.params.prompt, 'a cat')
      assert.equal(data.params.steps, 20)

      const miss = await route.fetch(new Request('http://x/api/comfyui/workspace/workflow?promptId=nope'))
      const bad = await miss.json()
      assert.equal(bad.ok, false)
      assert.match(bad.reason, /nope/)

      const empty = await route.fetch(new Request('http://x/api/comfyui/workspace/workflow'))
      assert.equal(empty.status, 400)
    })
  } finally { await comfy.close() }
})

test('image 路由：代理 ComfyUI 产出图，拒绝路径穿越', async () => {
  const comfy = await startFakeComfy()
  try {
    await withTempRoot(async (root) => {
      const fake = createFakeCtx()
      plugin.apply(fake.ctx, { baseUrl: comfy.baseUrl, outputRoot: root })
      const route = routeOf(fake.routes, '/api/comfyui/workspace/image')
      const ok = await route.fetch(new Request('http://x/api/comfyui/workspace/image?filename=a.png'))
      assert.equal(ok.status, 200)
      assert.equal(ok.headers.get('content-type'), 'image/png')
      const bad = await route.fetch(new Request('http://x/api/comfyui/workspace/image?filename=..%2Fsecret.png'))
      assert.equal(bad.status, 400)
    })
  } finally { await comfy.close() }
})

test('submit 路由：图上改参后写回工作流再提交，并记入索引', async () => {
  const comfy = await startFakeComfy()
  try {
    await withTempRoot(async (root) => {
      const fake = createFakeCtx()
      plugin.apply(fake.ctx, { baseUrl: comfy.baseUrl, outputRoot: root })
      const route = routeOf(fake.routes, '/api/comfyui/workspace/submit')
      const res = await route.fetch(new Request('http://x/api/comfyui/workspace/submit', {
        method: 'POST',
        body: JSON.stringify({
          graph: GRAPH,
          params: { prompt: 'edited prompt', width: 512, steps: 12, seed: 42 },
        }),
      }))
      const data = await res.json()
      assert.equal(data.ok, true)
      assert.equal(data.promptId, 'fake-1')
      assert.equal(comfy.promptIds.length, 1)
      // 提交上去的图里，提示词/尺寸/步数已改，连线仍在
      const submitted = comfy.promptIds[0]
      const nodes = submitted?.prompt ?? submitted
      assert.ok(JSON.stringify(nodes).includes('edited prompt'))

      const store = createWorkspaceStore({ root })
      const recorded = await store.findByPromptId('fake-1')
      assert.ok(recorded, '索引里应有这条记录')
      assert.equal(recorded.params.prompt, 'edited prompt')

      const bad = await route.fetch(new Request('http://x/api/comfyui/workspace/submit', {
        method: 'POST', body: '{}',
      }))
      assert.equal(bad.status, 400)
    })
  } finally { await comfy.close() }
})
