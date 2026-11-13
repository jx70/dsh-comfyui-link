/**
 * probe-http.mjs —— 用 DSH 自己的签名规则造一个合法浏览器 cookie，
 * 然后真的走 HTTP 打一次 /api/comfyui/vision-models。
 * ============================================================================
 * 这一步验证的是「路由确实挂在 /api 信任栅栏内部、浏览器带 cookie 能取到」，
 * 也就是设置页下拉真正会走的路径。
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
const PATH = '/api/comfyui/vision-models'
const cookie = requireCookieOrSkip('probe:http')

console.log(`· 目标 ${BASE}`)

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method: 'GET', headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

;(async () => {
  const withCookie = await get(PATH, { cookie })
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

  const noCookie = await get(PATH, {})
  console.log(`不带 cookie → ${noCookie.status}（应为 401）`)

  const missing = await get('/api/comfyui/no-such-route', { cookie })
  console.log(`不存在的路由（带 cookie）→ ${missing.status} ${missing.text.slice(0, 40)}`)

  const pass = withCookie.status === 200 && body2?.ok === true && noCookie.status === 401 && missing.status === 404
  console.log(pass ? '\n全部通过：路由挂在栅栏内部，浏览器带 cookie 可读' : '\n有失败项')
  process.exit(pass ? 0 : 1)
})()
