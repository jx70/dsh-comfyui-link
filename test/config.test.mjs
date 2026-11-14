/**
 * config.test.mjs —— 配置 schema + 「能不能直接开源」的守护测试
 * ============================================================================
 * 前半段钉住 Config（设置页表单就是照它渲染的）：
 *   · 六个 volatile 段（review / img2img / upscale / draw / output / loraDocs）都在，默认值对
 *   · 旧的 lora 段已经删掉（LoRA 开关搬到对话栏了）
 *   · review.maxAttempts 的 1–5 边界
 * 后半段钉住「去本地化」这件事本身：
 *   · 包里任何文件都不许再出现 @local/ 这种本机路径式包名
 *   · 任何文件都不许出现作者机器的绝对路径 / 凭据文件硬编码
 *   · package.json 的开源元数据齐全，files 里列的每一项都真的存在
 *   · scripts 指向的脚本都真的存在
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (relPath) => readFileSync(join(ROOT, relPath), 'utf8')
const pkg = JSON.parse(read('package.json'))
const plugin = await import('../index.js')

const { Config, DEFAULTS } = plugin

/**
 * volatile 字段在 apply() 里是 cosmokit 引用对象（`{ get }`），不是普通值。
 * 这里就是 index.js 里 unwrapVolatile 的那一步，测试里也要走一遍。
 */
const unwrap = (value) => (value && typeof value.get === 'function' ? value.get() : value)

/** 仓库里要发出去的那些源文件（跳过 node_modules / .git / 临时产物） */
function sourceFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.comfy-probe', 'coverage', 'dist'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, out)
    } else if (/\.(m?js|json|yml|yaml|md|svg|txt)$/.test(entry.name)) {
      out.push(relative(ROOT, full).replaceAll('\\', '/'))
    }
  }
  return out
}

/* ── Config schema ─────────────────────────────────────────────────────── */

test('Config 给全套默认值：指向本机 8188，三个开关全关、绘图默认直连第一个模型且不挂 LoRA', () => {
  const value = Config({})
  assert.equal(value.baseUrl, 'http://127.0.0.1:8188')
  assert.deepEqual(unwrap(value.review), {
    enabled: false,
    provider: '',
    model: '',
    maxAttempts: 1,
    extra: '',
  })
  assert.deepEqual(unwrap(value.img2img), { enabled: false })
  assert.deepEqual(unwrap(value.upscale), { enabled: false })
  assert.deepEqual(unwrap(value.draw), { unet: '', lora: false })
  // 输出目录默认空：图就留在 ComfyUI 自己的 output 里，不额外复制
  assert.deepEqual(unwrap(value.output), { dir: '' })
  // LoRA 提示词目录默认空：一个文档都不读（不选路径就完全不参考提示词）
  assert.deepEqual(unwrap(value.loraDocs), { dir: '' })
  // 设置页里的 LoRA 分区已经删掉，配置里也不该再有独立的 lora 段
  assert.equal(value.lora, undefined)
})

test('六个功能段都是 volatile（改完即时生效）', () => {
  const value = Config({})
  for (const key of ['review', 'img2img', 'upscale', 'draw', 'output', 'loraDocs']) {
    assert.equal(typeof value[key]?.get, 'function', `${key} 不是 volatile 引用对象`)
  }
  // baseUrl 是静态配置，改了要重载插件，所以它不是 volatile
  assert.equal(typeof value.baseUrl, 'string')
})

test('Config 接受自定义 baseUrl、设置页三个开关与绘图选项', () => {
  const value = Config({
    baseUrl: 'http://192.168.1.9:8188',
    review: { enabled: true, provider: 'p', model: 'm', maxAttempts: 3, extra: '角色必须还原' },
    img2img: { enabled: true },
    upscale: { enabled: true },
    draw: { unet: 'some-model.safetensors', lora: true },
    output: { dir: '/srv/pics' },
    loraDocs: { dir: '/srv/lora-docs' },
  })
  assert.equal(value.baseUrl, 'http://192.168.1.9:8188')
  const review = unwrap(value.review)
  assert.equal(review.maxAttempts, 3)
  assert.equal(review.extra, '角色必须还原')
  assert.equal(unwrap(value.img2img).enabled, true)
  assert.equal(unwrap(value.upscale).enabled, true)
  assert.deepEqual(unwrap(value.draw), { unet: 'some-model.safetensors', lora: true })
  assert.deepEqual(unwrap(value.output), { dir: '/srv/pics' })
  assert.deepEqual(unwrap(value.loraDocs), { dir: '/srv/lora-docs' })
})

test('profile 里残留的旧 lora 段被原样透传但不参与功能（schema 不再声明它）', () => {
  // schemastery 对未知键是透传而不是丢弃，所以这里断言的是「插件不再读它」：
  // draw 段仍是默认值，说明旧的 lora.enabled 不会偷偷把 LoRA 打开。
  const value = Config({ lora: { enabled: true } })
  assert.deepEqual(unwrap(value.draw), { unet: '', lora: false })
})

test('Config 拒绝越界的 review.maxAttempts（1–5）', () => {
  assert.throws(() => Config({ review: { maxAttempts: 0 } }), /maxAttempts/)
  assert.throws(() => Config({ review: { maxAttempts: 9 } }), /maxAttempts/)
  assert.throws(() => Config({ review: { maxAttempts: 2.5 } }), /maxAttempts/)
  assert.equal(unwrap(Config({ review: { maxAttempts: 5 } }).review).maxAttempts, 5)
  assert.equal(unwrap(Config({ review: { maxAttempts: 1 } }).review).maxAttempts, 1)
})

test('DEFAULTS 是运行期的兜底值，和 Config 的默认值一致', () => {
  assert.deepEqual(DEFAULTS, {
    baseUrl: 'http://127.0.0.1:8188',
    timeoutMs: 20000,
    pollMs: 2500,
    maxWaitSeconds: 900,
    outputRoot: '',
  })
})

/* ── 开源元数据 ────────────────────────────────────────────────────────── */

test('package.json 的开源元数据齐全', () => {
  assert.equal(pkg.name, 'dsh-comfyui-link')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.private, undefined, '要发布就不能是 private')
  assert.equal(typeof pkg.description, 'string')
  assert.ok(pkg.description.length > 0)
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 5)
  assert.match(pkg.repository.url, /^git\+https:\/\/github\.com\/.+\/.+\.git$/)
  assert.match(pkg.homepage, /^https:\/\/github\.com\/.+\/.+#readme$/)
  assert.match(pkg.bugs.url, /^https:\/\/github\.com\/.+\/.+\/issues$/)
  assert.equal(pkg.author, 'dsh-comfyui-link contributors')
})

test('engines 与 publishConfig 说明清楚给谁装、往哪发', () => {
  assert.equal(pkg.engines.node, '>=22')
  assert.match(pkg.engines.dsh, /^>=\d+\.\d+\.\d+/)
  assert.deepEqual(pkg.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' })
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.icon, './icon.svg')
})

test('dsh 字段声明了 bundle patch 与 web 客户端注入', () => {
  assert.deepEqual(pkg.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
  ])
})

test('exports 里每条路径都指向真实文件（通配符按示例展开）', () => {
  const samples = { './locale/*.json': './locale/zh.json' }
  for (const [key, target] of Object.entries(pkg.exports)) {
    const path = samples[target] ?? target
    assert.doesNotThrow(() => statSync(join(ROOT, path)), `exports["${key}"] → ${target} 不存在`)
  }
})

test('files 里每一项都真的存在（npm pack 不会漏东西）', () => {
  for (const entry of pkg.files) {
    // 以 ! 开头的是排除规则（例如 !docs/demo.png），要校验的是它指的那个文件
    const target = entry.startsWith('!') ? entry.slice(1) : entry
    assert.doesNotThrow(() => statSync(join(ROOT, target)), `files 里的 ${entry} 不存在`)
  }
  // 关键运行文件必须在发布清单里
  for (const required of ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'locale', 'icon.svg']) {
    assert.ok(pkg.files.includes(required), `files 少了 ${required}`)
  }
})

test('scripts 指向的脚本文件都存在', () => {
  for (const [name, command] of Object.entries(pkg.scripts)) {
    const match = /node\s+(\S+\.mjs)/.exec(command)
    if (!match) continue
    assert.doesNotThrow(() => statSync(join(ROOT, match[1])), `scripts.${name} 指向的 ${match[1]} 不存在`)
  }
})

test('运行期只依赖 schemastery（lib 与 client 都不引宿主内部包）', () => {
  assert.deepEqual(Object.keys(pkg.dependencies), ['@deepseek-ai/schemastery'])
  assert.equal(pkg.devDependencies, undefined, '不该有 devDependencies：测试只用 node:test')
})

/* ── 去本地化守护 ──────────────────────────────────────────────────────── */

test('包里任何文件都不许再出现 @local/ 这种本机包名', () => {
  const localScope = '@local' + '/'
  const offenders = []
  for (const file of sourceFiles()) {
    if (file.startsWith('test/')) continue // 这个测试自己会提到它
    if (read(file).includes(localScope)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `这些文件还带着本机包名：${offenders.join(', ')}`)
})

test('包里任何文件都不许硬编码作者机器的绝对路径', () => {
  const patterns = [
    /[A-Za-z]:[\\/]Users[\\/]/i, // 作者机器的用户目录
    /npm-cache[\\/]_npx/i, // npx 缓存里的哈希路径
    /[A-Za-z]:[\\/](?:Agent|DSH|Comfy)[\\/]/i, // 作者机器的项目 / ComfyUI 安装目录
  ]
  const offenders = []
  for (const file of sourceFiles()) {
    if (file.startsWith('test/')) continue
    const text = read(file)
    for (const pattern of patterns) {
      if (pattern.test(text)) offenders.push(`${file} ← ${pattern}`)
    }
  }
  assert.deepEqual(offenders, [], `还有本机绝对路径：${offenders.join('; ')}`)
})

test('凭据文件只在 env.mjs 里被读，脚本与源码都不许自己开它', () => {
  // 注释里提一句路径（告诉使用者该配什么）是应该的，所以先把注释剥掉再看代码。
  const stripComments = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .replace(/^\s*\/\/.*$/gm, '') // 整行行注释
  const offenders = []
  for (const file of sourceFiles()) {
    if (file.startsWith('test/') || file === 'scripts/env.mjs') continue
    if (!/\.(m?js|json|ya?ml)$/.test(file)) continue
    if (/\.credentials\.yaml/.test(stripComments(read(file)))) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `这些文件自己读了凭据文件：${offenders.join(', ')}`)
})

test('脚本一律从 scripts/env.mjs 取环境，不自己写死地址', () => {
  for (const file of ['scripts/selftest.mjs', 'scripts/e2e.mjs', 'scripts/probe-features.mjs', 'scripts/probe-http.mjs', 'scripts/probe-client-bundle.mjs', 'scripts/probe-route.mjs', 'scripts/offline.mjs']) {
    const text = read(file)
    assert.match(text, /from '\.\/env\.mjs'/, `${file} 没从 env.mjs 取环境`)
  }
})

test('cordis.patch.yml 用的是发布名，且只放静态默认值', () => {
  const yaml = read('cordis.patch.yml')
  assert.match(yaml, /name: dsh-comfyui-link/)
  assert.match(yaml, /baseUrl: 'http:\/\/127\.0\.0\.1:8188'/)
  assert.doesNotMatch(yaml, /@local/)
})

test('cordis.patch.yml 声明了第五个模式「绘图模式」', () => {
  const yaml = read('cordis.patch.yml')
  // 声明行 + 身份 + 顺序：这是 agentPresets.register 认的三样
  assert.match(yaml, /id: preset-draw/)
  assert.match(yaml, /name: '@deepseek-ai\/dsh-agent-preset'/)
  assert.match(yaml, /^\s+id: draw$/m)
  assert.match(yaml, /^\s+order: 5$/m)
  // 新预设必须自带 name/description，否则会被当成内置模式走 locale（那里没有它）
  assert.match(yaml, /name: 绘图模式/)
  assert.match(yaml, /description: /)
  // 子插件必须写裸包名：相对路径不会被解析层按安装目录重写，会解析失败
  const relative = []
  for (const line of yaml.split('\n')) {
    const m = /^\s+name:\s*['"]?([^'"\n]+)['"]?\s*$/.exec(line)
    if (m && /^\.{1,2}\//.test(m[1])) relative.push(m[1])
  }
  assert.deepEqual(relative, [], `preset 子插件用了相对路径：${relative.join(', ')}`)
  // complete: true 会把 system prompt 压成只剩 persona，连 comfyui 的出图说明一起没了
  assert.doesNotMatch(yaml, /complete:\s*true/)
})

test('client.js 的模块 id 与 style 标记跟着包名走', () => {
  const text = read('client.js')
  assert.match(text, /id: 'dsh-comfyui-link'/)
  assert.match(text, /const tagId = 'dsh-comfyui-link\/settings'/)
  assert.match(text, /style\.dataset\.plugin = 'dsh-comfyui-link'/)
  assert.doesNotMatch(text, /@local/)
})

test('client.js 的宿主请求走页面传输钩子，桌面端才找得到宿主', () => {
  const text = read('client.js')
  // 桌面端的页面来源是 dsh-app://app/，相对 /api 在那里解析不到宿主
  assert.match(text, /globalThis\.__DSH_TRANSPORT__/)
  assert.match(text, /function hostFetch\(route, init\)/)
  // 三条 GET 路由（含 LoRA 提示词目录）都不能直接裸调 fetch
  assert.doesNotMatch(text, /\bfetch\((VISION_API|DRAW_API|LORA_DOCS_API|PICK_API)\b/)
  // 桌面端优先用 preload 的原生目录桥，取消返回 null
  assert.match(text, /globalThis\.__DSH_DIRECTORY_PICKER__/)
  assert.match(text, /function desktopPicker\(\)/)
})

test('生图模型下拉同时列 checkpoints 里的整合包，不再只认 diffusion_models', () => {
  const client = read('client.js')
  assert.match(client, /drawGroupCheckpoint/)
  assert.match(client, /drawGroupUnet/)
  assert.match(client, /folders\.checkpoints/)
  // 宿主那条路由必须把 checkpoints 一起发出来
  const index = read('index.js')
  assert.match(index, /checkpoints: index\.checkpoints \?\? \[\]/)
})

test('README 与 locale 里没有本机硬件实况（显卡/显存/具体模型文件名）', () => {
  for (const file of ['README.md', 'README.en.md']) {
    let text
    try {
      text = read(file)
    } catch {
      continue // 英文 README 可以后补
    }
    assert.doesNotMatch(text, /RTX\s*\d{4}/i, `${file} 里还有显卡型号`)
    assert.doesNotMatch(text, /\d+\s*GiB\s*显存/, `${file} 里还有显存实况`)
    assert.doesNotMatch(text, /anima-base-v1\.0/, `${file} 里还有作者机器上的模型文件名`)
  }
})

test('LICENSE 是 MIT，且写的是 contributors 而不是某个人', () => {
  const text = read('LICENSE')
  assert.match(text, /MIT License/)
  assert.match(text, /Copyright \(c\) \d{4} dsh-comfyui-link contributors/)
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/)
})

/* ── 包名守护 ──────────────────────────────────────────────────────────── */

test('旧的包名不许复活（它和 npm 上别人的包重名）', () => {
  // 运行时拼接，免得这个测试文件自己命中自己。
  const retired = ['dsh', 'comfyui', 'bridge'].join('-')
  const offenders = []
  for (const file of sourceFiles()) {
    if (file.startsWith('test/')) continue
    // CHANGELOG 要记改名历史，允许它提旧名；其余文件一律不许。
    if (file === 'CHANGELOG.md') continue
    if (read(file).includes(retired)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `这些文件里还有旧包名：${offenders.join(', ')}`)
})

test('绘图控件的底色与字色都用主题里真实存在的 token', () => {
  const text = read('client.js')
  // `--dsw-alias-bg-layer-4` 在主题里根本不存在，兜底成 12% 灰 —— 暗色下等于没有底色，
  // 而字色又是继承来的近白色，于是下拉文字看着像在发白光。
  assert.doesNotMatch(text, /--dsw-alias-bg-layer-4/)
  assert.match(text, /var\(--dsw-alias-bg-layer-1/)
  assert.match(text, /var\(--dsw-alias-label-primary/)
  // 展开的选项由浏览器自己画表面色，必须显式给底色与字色，不能靠继承。
  assert.match(text, /\[data-comfy-mini\] option/)
  assert.match(text, /\[data-comfy-select\] option/)
})

test('设置页的配色一律走主题 token，不硬编码品牌色与错误色', () => {
  const text = read('client.js')
  // 硬编码 #3b82f6 在换主题后不会跟着变，暗色下对比度也不受主题保证。
  assert.doesNotMatch(text, /#3b82f6/i)
  assert.doesNotMatch(text, /#ef4444/i)
  assert.doesNotMatch(text, /#93c5fd/i)
  assert.doesNotMatch(text, /#fff\b/i)
  // 出厂设置页那套 token：卡片底/描边、品牌色、主按钮、反色前景、开关滑块、状态色。
  for (const token of [
    '--dsw-alias-settings-card-fill',
    '--dsw-alias-settings-card-stroke',
    '--dsw-alias-brand-primary',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-label-primary-foreground',
    '--dsw-alias-switch-thumb',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
  ]) {
    assert.match(text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `缺少 ${token}`)
  }
  // 任何「颜色声明」都不许直接写十六进制。
  assert.doesNotMatch(text, /(?:background|background-color|color|border-color|box-shadow)\s*:\s*#/i)
})

test('设置页用卡片分块，不再用分隔线', () => {
  const text = read('client.js')
  const sec = text.match(/\[data-comfy-sec\]\{[^}]*\}/)
  assert.ok(sec, '没有 [data-comfy-sec] 规则')
  assert.doesNotMatch(sec[0], /border-bottom/)
  assert.match(sec[0], /border-radius:var\(--dsw-radius-xl/)
  assert.match(sec[0], /var\(--dsw-alias-settings-card-fill/)
  assert.match(sec[0], /var\(--dsw-alias-settings-card-stroke/)
})

test('README 不许给出会装到别人包的 npm 安装命令', () => {
  // 本包没发 npm。写成 `add dsh-comfyui-link` 会让读者从 registry 拉一个空名/别人的包。
  const pkgName = pkg.name
  const forbidden = new RegExp(`add\\s+${pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?!-)`)
  for (const file of ['README.md', 'README.en.md', 'cordis.patch.yml', 'docs/DEVELOPMENT.md']) {
    let text
    try {
      text = read(file)
    } catch {
      continue
    }
    assert.doesNotMatch(text, forbidden, `${file} 里出现了直接按包名安装的命令`)
  }
})
