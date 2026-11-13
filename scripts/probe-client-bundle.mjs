/**
 * probe-client-bundle.mjs —— 验证「浏览器真正下载到的那份 client.js 是新代码」
 * ============================================================================
 * 之前踩过的坑：改了 client.js、插件也 enable 了，但浏览器可能仍拿旧 bundle
 * （客户端模块按 rev 缓存）。这个脚本用合法 cookie 抓一次首页 HTML，从里面
 * 找出包含 comfyui 的那条合并 bundle URL，取回来检查是否含本轮新增的
 * ModelPicker + /api/comfyui/vision-models。
 *
 * 环境同 probe-http.mjs：DSH_BASE / DSH_CREDENTIALS / DSH_AUTH_COOKIE。
 * 拿不到凭据就跳过（exit 0）。
 * ============================================================================
 */
import http from 'node:http'
import { dshBase, requireCookieOrSkip } from './env.mjs'

const BASE = dshBase()
const cookie = requireCookieOrSkip('probe:bundle')

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method: 'GET', headers: { cookie } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

const unescapeHtml = (s) => s.replace(/&amp;/g, '&')

;(async () => {
  console.log(`· 目标 ${BASE}`)
  const home = await get('/')
  if (home.status !== 200) { console.log(`✗ 首页 ${home.status}`); process.exit(1) }

  const hrefs = [...home.text.matchAll(/href="([^"]+)"/g)].map((x) => unescapeHtml(x[1]))
  const bundles = hrefs.filter((h) => h.includes('client.js') && h.includes('comfyui'))
  console.log(`首页 200，${home.text.length} 字节，含 comfyui 的 bundle 链接 ${bundles.length} 条`)

  if (bundles.length === 0) {
    console.log('✗ HTML 里没有 comfyui 的 client bundle —— 客户端半端没被加载')
    process.exit(1)
  }

  let ok = true
  for (const raw of bundles) {
    const path = raw.startsWith('/') ? raw : `/${raw}`
    const res = await get(path)
    const hasPicker = res.text.includes('ModelPicker')
    const hasApi = res.text.includes('/api/comfyui/vision-models')
    const hasSelect = res.text.includes('data-comfy-select')
    console.log(`  ${path.slice(0, 72)}…`)
    console.log(`    → ${res.status}，${res.text.length} 字节；ModelPicker=${hasPicker} select=${hasSelect} vision-models=${hasApi}`)
    if (res.status !== 200 || !hasPicker || !hasApi) ok = false
  }

  console.log(ok ? '\n✓ 浏览器下载的 client.js 已包含 ModelPicker + vision-models 路由' : '\n✗ bundle 内容不是最新代码')
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
