/**
 * probe-http.mjs —— 真打插件挂在 /api 下的四条只读路由
 * ============================================================================
 * 前置：DSH 起着、插件已加载、ComfyUI 在跑（否则 vision/draw 会 502，但脚本会
 * 把失败原因打出来而不是崩栈）。用法：
 *
 *   node scripts/probe-http.mjs
 *
 * 环境变量（都在 scripts/env.mjs 里统一兜底）：
 *   DSH_BASE         正在跑的 DSH Web 地址，默认 http://127.0.0.1:3080
 *   DSH_CREDENTIALS / DSH_AUTH_COOKIE  拿 cookie 的两种方式
 *
 * 拿不到凭据时**跳过并 exit 0**（不算失败），所以别人机器上跑也不会红。
 *
 * 钉住的四件事：
 *   1. 带 cookie 时四条路由都在栅栏内部，能拿到 200 与结构化数据
 *   2. 不带 cookie 时一律 401（说明它们没绕开 connection 的鉴权）
 *   3. 不存在的 /api/comfyui/* 是 404（说明前缀确实被插件接管，不是通配）
 *   4. LoRA 提示词目录没配时回空清单而不是报错
 * ============================================================================
 */
import { dshBase, requireCookieOrSkip } from './env.mjs'

const BASE = dshBase()
const COOKIE = requireCookieOrSkip('probe:http')

const VISION_PATH = '/api/comfyui/vision-models'
const DRAW_PATH = '/api/comfyui/draw-models'
const LORA_DOCS_PATH = '/api/comfyui/lora-docs'
const MISSING_PATH = '/api/comfyui/definitely-not-a-route'

async function hit(path, init = {}) {
  const res = await fetch(new URL(path, BASE), {
    ...init,
    headers: { cookie: COOKIE, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch { /* 非 JSON 就留 null */ }
  return { status: res.status, body, text }
}

async function bare(path) {
  const res = await fetch(new URL(path, BASE))
  return res.status
}

console.log(`目标：${BASE}`)

// ── 1. 审图模型清单 ────────────────────────────────────────────────────────
const vision = await hit(VISION_PATH)
console.log(`\n[vision] GET ${VISION_PATH} → ${vision.status}`)
if (vision.status === 200) {
  const providers = vision.body?.providers ?? []
  for (const provider of providers) {
    const models = (provider.models ?? []).map((model) => model.model).join(', ')
    console.log(`  ${provider.provider}: ${models || '（无）'}`)
  }
  if (providers.length === 0) console.log('  （没有能收图的模型）')
} else if (vision.body?.error) {
  console.log(`  ${vision.body.error}`)
}

// ── 2. 生图模型清单 ────────────────────────────────────────────────────────
const draw = await hit(DRAW_PATH)
console.log(`\n[draw] GET ${DRAW_PATH} → ${draw.status}`)
if (draw.status === 200) {
  const folders = draw.body?.folders ?? {}
  for (const [folder, files] of Object.entries(folders)) {
    const list = Array.isArray(files) ? files : []
    const head = list.slice(0, 3).join(', ')
    console.log(`  ${folder}: ${list.length} 个${head ? ` — ${head}` : ''}`)
  }
} else if (draw.body?.error) {
  console.log(`  ${draw.body.error}`)
}

// ── 3. LoRA 提示词目录清单 ─────────────────────────────────────────────────
const docs = await hit(LORA_DOCS_PATH)
console.log(`\n[lora-docs] GET ${LORA_DOCS_PATH} → ${docs.status}`)
if (docs.status === 200) {
  const dir = docs.body?.dir ?? ''
  console.log(`  dir: ${dir || '（未指定，不读任何文档）'}`)
  console.log(`  count: ${docs.body?.count ?? 0}，promptish: ${docs.body?.promptish ?? 0}`)
  for (const doc of (docs.body?.docs ?? []).slice(0, 5)) {
    const where = doc.rel && doc.rel !== doc.name ? ` (${doc.rel})` : ''
    console.log(`    ${doc.name}${where}${doc.promptish ? ' ✓ 像提示词' : ''}`)
  }
} else if (docs.body?.error) {
  console.log(`  ${docs.body.error}`)
}

// ── 4. 未授权 / 404 ────────────────────────────────────────────────────────
const noCookie = await bare(VISION_PATH)
const drawNoCookie = await bare(DRAW_PATH)
const docsNoCookie = await bare(LORA_DOCS_PATH)
// 404 要带 cookie 验：不带 cookie 时信任栅栏在路由匹配之前就把一切 /api 打成 401
const missing = await hit(MISSING_PATH)
console.log(`\n[guard] 不带 cookie：vision ${noCookie} / draw ${drawNoCookie} / lora-docs ${docsNoCookie}`)
console.log(`[guard] 带 cookie 打不存在的路由：${missing.status}`)

const pass = vision.status === 200
  && draw.status === 200
  && docs.status === 200
  && noCookie === 401
  && drawNoCookie === 401
  && docsNoCookie === 401
  && missing.status === 404

if (!pass) {
  console.error('\n✗ 有断言没通过')
  process.exit(1)
}
console.log('\n✓ 全部通过：四条路由都挂在栅栏内部，浏览器带 cookie 可读')
