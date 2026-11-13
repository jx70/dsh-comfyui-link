/**
 * selftest.mjs —— 不装插件也能跑：直接对着 ComfyUI 把 lib/comfy.mjs 走一遍
 * ============================================================================
 *   node scripts/selftest.mjs                 只读探测（不提交任务）
 *   node scripts/selftest.mjs --run           真的排一个很小的任务（512×512, 4 步）
 *   node scripts/selftest.mjs --run --wait    排完等它跑完，并把输出图字节取回来
 *
 * 服务地址取 COMFY_URL，默认 http://127.0.0.1:8188。
 * ============================================================================
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MODEL_FOLDERS, buildTxt2Img, collectImages, createClient, humanDuration,
  normalizeGraph, resolveModels, summarizeGraph,
} from '../lib/comfy.mjs'
import { comfyUrl } from './env.mjs'

const args = new Set(process.argv.slice(2))
const baseUrl = comfyUrl()
const client = createClient({ baseUrl })

const ok = (label, extra = '') => console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
const step = (label) => console.log(`\n[${label}]`)

console.log(`· 目标 ${baseUrl}`)

step('服务')
const stats = await client.systemStats()
const dev = stats.devices?.[0]
ok('system_stats', `ComfyUI ${stats.system?.comfyui_version} · Python ${stats.system?.python_version?.split(' ')[0]}`)
if (dev) ok('GPU', `${dev.name} · 空闲 ${(dev.vram_free / 2 ** 30).toFixed(1)}/${(dev.vram_total / 2 ** 30).toFixed(1)} GiB`)

step('模型')
const index = await client.modelIndex()
for (const folder of MODEL_FOLDERS) ok(folder, index[folder].length ? `${index[folder].length} 个：${index[folder].slice(0, 3).join(', ')}` : '（空）')
const models = resolveModels(index)
ok('自动挑选', `unet=${models.unet} · clip=${models.clip} · vae=${models.vae}`)

step('节点规范')
const ksampler = await client.nodeInfo('KSampler')
const enumOf = (info, key) => {
  const raw = info?.input?.required?.[key]
  return Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : null
}
const samplers = enumOf(ksampler, 'sampler_name')
ok('KSampler.sampler_name', `${samplers?.length ?? 0} 个：${samplers?.slice(0, 4).join(', ')}`)
ok('KSampler.scheduler', `${(enumOf(ksampler, 'scheduler') ?? []).join(', ')}`)

step('队列 / 任务')
const q = await client.queue()
ok('queue', `running=${q.queue_running?.length ?? 0} pending=${q.queue_pending?.length ?? 0}`)
const jobs = await client.jobs({ limit: 3 })
for (const job of jobs) {
  const dur = job.execution_end_time && job.execution_start_time ? humanDuration(job.execution_end_time - job.execution_start_time) : ''
  ok(`job ${job.id.slice(0, 8)}`, `${job.status}${dur ? ` ${dur}` : ''} outputs=${job.outputs_count}`)
}

step('历史 / 取图')
const history = await client.history(1)
if (history.length === 0) {
  ok('history', '（还没有生成记录）')
} else {
  const { promptId, entry } = history[0]
  const images = collectImages(entry)
  ok('history', `${promptId.slice(0, 8)} → ${images.length} 张图`)
  if (images.length > 0) {
    const bytes = await client.view(images[0])
    ok('view', `${images[0].filename} ${(bytes.length / 1024).toFixed(0)} KiB，前 4 字节 ${[...bytes.slice(0, 4)].join(' ')}`)
  }
}

step('工作流模板')
const graph = buildTxt2Img({
  unet: models.unet,
  clip: models.clip,
  vae: models.vae,
  prompt: 'a red apple on a wooden table, soft light',
  negative: 'blurry, low quality',
  width: 512,
  height: 512,
  steps: 4,
  seed: 12345,
})
const normalized = normalizeGraph(graph)
const summary = summarizeGraph(normalized)
ok('buildTxt2Img', `${summary.count} 个节点：${Object.entries(summary.byClass).map(([k, v]) => `${k}×${v}`).join(' ')}`)

if (!args.has('--run')) {
  console.log('\n（只读探测完成；加 --run 才会真的提交任务）')
  process.exit(0)
}

step('提交')
const submitted = await client.submit(normalized)
if (!submitted.ok) {
  console.error('  ✗ 提交被拒：', submitted.error)
  console.error('   node_errors:', JSON.stringify(submitted.nodeErrors, null, 2))
  process.exit(1)
}
ok('已排队', `prompt_id=${submitted.promptId} number=${submitted.number}`)

if (!args.has('--wait')) {
  console.log('\n（加 --wait 会等它跑完并把图取回来）')
  process.exit(0)
}

step('等待')
const started = Date.now()
let job = null
for (;;) {
  job = await client.job(submitted.promptId)
  if (job && (job.status === 'completed' || job.status === 'failed')) break
  if (Date.now() - started > 10 * 60_000) {
    console.error('  ✗ 等了 10 分钟还没结束')
    process.exit(1)
  }
  process.stdout.write(`  … ${job?.status ?? '未知'}（已等 ${humanDuration(Date.now() - started)}）\r`)
  await new Promise((r) => setTimeout(r, 1500))
}
ok('状态', `${job.status} · ${humanDuration(Date.now() - started)}`)

step('取结果')
const entry = await client.historyEntry(submitted.promptId)
const images = collectImages(entry)
ok('输出', `${images.length} 张图`)
const dir = join(process.cwd(), '.comfy-probe', 'out')
mkdirSync(dir, { recursive: true })
for (const [i, image] of images.entries()) {
  const bytes = await client.view(image)
  const file = join(dir, `selftest-${i}.png`)
  writeFileSync(file, bytes)
  ok(`保存 ${file}`, `${(bytes.length / 1024).toFixed(0)} KiB`)
}
console.log('\n全部通过。')
