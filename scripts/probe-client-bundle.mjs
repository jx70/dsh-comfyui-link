/**
 * probe-client-bundle.mjs —— 验证「浏览器真正下载到的那份 client.js 是新代码」
 * ============================================================================
 * 之前踩过的坑：改了 client.js、插件也 enable 了，但浏览器可能仍拿旧 bundle
 * （客户端模块按 rev 缓存）。这个脚本用合法 cookie 抓一次首页 HTML，从里面
 * 找出包含 comfyui 的那条合并 bundle URL，取回来检查本轮新增的东西是否都在：
 * 设置页的 ModelPicker（审图模型）+ 保存按钮、对话栏的 DrawBar（只在绘图模式
 * 里渲染）+ 两条只读路由。
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
    const marks = {
      ModelPicker: res.text.includes('ModelPicker'),
      DrawBar: res.text.includes('DrawBar'),
      select: res.text.includes('data-comfy-select'),
      vision: res.text.includes('/api/comfyui/vision-models'),
      draw: res.text.includes('/api/comfyui/draw-models'),
      slot: res.text.includes('conversation.input.left'),
      save: res.text.includes('data-comfy-btn'),
      // 设置页新加的「输出目录」字段
      outputDir: res.text.includes('outputDirHint'),
      // 输出目录那一栏：只读路径行 + 「选择」/「清除」两个按钮 + 打的那条原生对话框路由
      outputPath: res.text.includes('data-comfy-path'),
      outputClear: res.text.includes('data-comfy-clear'),
      pick: res.text.includes('data-comfy-pick'),
      pickApi: res.text.includes('/api/comfyui/pick-directory'),
      // 手填框必须已经删掉：TextRow 的 action 分支与它的容器都不该再出现
      noInline: !res.text.includes('data-comfy-inline'),
      // 设置页的 LoRA 开关应该已经没了：只剩对话栏那个 chip
      noSettingsLora: !res.text.includes('loraHint'),
      // 桌面端适配：宿主请求走 __DSH_TRANSPORT__，选目录优先用 preload 的原生桥
      hostFetch: res.text.includes('__DSH_TRANSPORT__'),
      desktopPicker: res.text.includes('__DSH_DIRECTORY_PICKER__'),
      // 生图模型下拉要同时列 checkpoints 里的整合包（光辉这类），否则只看得见 diffusion_models
      drawCheckpoints: res.text.includes('drawGroupCheckpoint'),
      drawUnets: res.text.includes('drawGroupUnet'),
      // 暗色下那组控件得看得清：底色换成主题里真实存在的 token，选项显式给底色与字色
      optionSkin: res.text.includes('[data-comfy-mini] option'),
      // LoRA 提示词：设置页那一栏 + 「识别到几篇」的反馈 + 打的那条目录清单路由
      loraDocs: res.text.includes('data-comfy-lora-docs'),
      loraDocsApi: res.text.includes('/api/comfyui/lora-docs'),
      loraDocsCount: res.text.includes('data-comfy-doc-count'),
      // 设置页 UI 优化：审图分区带副标题、图生图/放大并进「功能开关」分区、保存条 sticky
      reviewNote: res.text.includes('reviewNote'),
      features: res.text.includes('data-comfy-sec-head') && res.text.includes('data-comfy-sub'),
      savebar: res.text.includes('data-comfy-savebar'),
    }
    console.log(`  ${path.slice(0, 72)}…`)
    console.log(`    → ${res.status}，${res.text.length} 字节；${Object.entries(marks).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    if (res.status !== 200) ok = false
    for (const [key, present] of Object.entries(marks)) if (!present) ok = false
  }

  console.log(ok
    ? '\n✓ 浏览器下载的 client.js 已包含 ModelPicker / DrawBar / 四条路由 / 保存按钮 / 输出目录与 LoRA 提示词两栏的选择按钮 / 桌面端两条桥 / 生图模型下拉的两个分组（扩散模型 + 整合包）/ 暗色下能看清的选项配色 / 设置页的分区副标题、功能开关合并与 sticky 保存条 / 设置页卡片化与主题 token 上色，手填框与设置页 LoRA 都已移除'
    : '\n✗ bundle 内容不是最新代码')
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
