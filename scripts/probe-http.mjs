/**
 * probe-http.mjs —— 用 DSH 自己的签名规则造一个合法浏览器 cookie，
 * 然后真的走 HTTP 打三条路由：/api/comfyui/vision-models、/api/comfyui/draw-models
 * 与 /api/comfyui/pick-directory。
 * ============================================================================
 * 这一步验证的是「路由确实挂在 /api 信任栅栏内部、浏览器带 cookie 能取到」，
 * 也就是设置页下拉、输入框左侧绘图控件、输出目录「选择」按钮真正会走的路径。
 *
 * pick-directory 这条**故意不真弹窗**：空请求体打在栅栏外面会被 401 挡掉，
 * 栅栏里面则用 GET 打它（路由只声明 POST）来确认「方法不匹配 → 404」。
 *
 * 环境（都可用环境变量覆盖）：
 *   DSH_BASE          DSH Web 地址，默认 http://127.0.0.1:3080
 *   DSH_CREDENTIALS   凭据文件，默认 <home>/.dsh/.credentials.yaml
 *   DSH_AUTH_COOKIE   直接给现成 cookie，给了就不读凭据文件
 *
 * 拿不到凭据就打印提示并跳过（exit 0），不算失败。
 * ============================================================================
 */
import http from 'node:http'
import { dshBase, requireCookieOrSkip } from './env.mjs'

const BASE = dshBase()
const VISION_PATH = '/api/comfyui/vision-models'
const DRAW_PATH = '/api/comfyui/draw-models'
const PICK_PATH = '/api/comfyui/pick-directory'
const cookie = requireCookieOrSkip('probe:http')

console.log(`· 目标 ${BASE}`)

function request(path, { method = 'GET', headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const get = (path, headers) => request(path, { headers })

;(async () => {
  console.log(`\n=== ${VISION_PATH} ===`)
  const withCookie = await get(VISION_PATH, { cookie })
  console.log(`带 cookie → ${withCookie.status} ${withCookie.headers['content-type'] ?? ''}`)
  let body2
  try { body2 = JSON.parse(withCookie.text) } catch { body2 = null }
  if (body2) {
    console.log(`  ok=${body2.ok}  error=${body2.error ?? '（无）'}`)
    for (const p of body2.providers ?? []) {
      console.log(`  ${p.id} — ${p.name}`)
      for (const mm of p.models) console.log(`      ${mm.id}  ${mm.name}`)
    }
  } else {
    console.log(`  正文：${withCookie.text.slice(0, 200)}`)
  }

  console.log(`\n=== ${DRAW_PATH} ===`)
  const draw = await get(DRAW_PATH, { cookie })
  console.log(`带 cookie → ${draw.status} ${draw.headers['content-type'] ?? ''}`)
  let drawBody
  try { drawBody = JSON.parse(draw.text) } catch { drawBody = null }
  if (drawBody) {
    if (drawBody.ok === true) {
      for (const [folder, names] of Object.entries(drawBody.folders ?? {})) {
        console.log(`  ${folder}: ${names.length} 个${names.length ? ` — ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' …' : ''}` : ''}`)
      }
    } else {
      console.log(`  ok=false  error=${drawBody.error}`)
    }
  } else {
    console.log(`  正文：${draw.text.slice(0, 200)}`)
  }

  const noCookie = await get(VISION_PATH, {})
  console.log(`\n不带 cookie → ${noCookie.status}（应为 401）`)
  const drawNoCookie = await get(DRAW_PATH, {})
  console.log(`draw 不带 cookie → ${drawNoCookie.status}（应为 401）`)

  console.log(`\n=== ${PICK_PATH} （不真弹窗）===`)
  const pickGet = await get(PICK_PATH, { cookie })
  console.log(`带 cookie 用 GET → ${pickGet.status}（应为 404：这条只声明了 POST）`)
  const pickBad = await request(PICK_PATH, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: 'not json',
  })
  let pickBadBody = null
  try { pickBadBody = JSON.parse(pickBad.text) } catch { /* 留在 null */ }
  console.log(`带 cookie 用 POST 打坏 JSON → ${pickBad.status}（应为 400） reason=${pickBadBody?.reason ?? '?'}`)
  const pickNoCookie = await request(PICK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(`POST 不带 cookie → ${pickNoCookie.status}（应为 401）`)

  const missing = await get('/api/comfyui/no-such-route', { cookie })
  console.log(`不存在的路由（带 cookie）→ ${missing.status} ${missing.text.slice(0, 40)}`)

  const pass = withCookie.status === 200 && body2?.ok === true
    && draw.status === 200 && drawBody?.ok === true
    && noCookie.status === 401 && drawNoCookie.status === 401
    && pickGet.status === 404
    && pickBad.status === 400 && pickBadBody?.reason === 'bad-request'
    && pickNoCookie.status === 401
    && missing.status === 404
  console.log(pass ? '\n全部通过：三条路由都挂在栅栏内部，浏览器带 cookie 可读可调' : '\n有失败项')
  process.exit(pass ? 0 : 1)
})()
