/**
 * env.mjs —— 开发脚本共用的「从哪找环境」出口
 * ============================================================================
 * 这个仓库里所有脚本都要在**别人的机器**上跑得起来，所以任何本机绝对路径、
 * 固定端口、凭据文件位置都从这里读，不再硬编码在各自的脚本里。
 *
 * 全部走环境变量，取不到就用「业界默认值」而不是「作者机器上的值」：
 *
 *   COMFY_URL          ComfyUI 服务地址            默认 http://127.0.0.1:8188
 *   DSH_BASE           正在跑的 DSH Web 地址        默认 http://127.0.0.1:3080
 *   DSH_CREDENTIALS    DSH 凭据文件路径            默认 <home>/.dsh/.credentials.yaml
 *   DSH_HOST_MODULES   @deepseek-ai/* 宿主包目录   默认用 createRequire 自己解析
 *   DSH_AUTH_COOKIE    直接给一个现成 cookie 字符串 给了就不读凭据文件
 *
 * 需要 DSH 凭据的只有 probe-http / probe-client-bundle 两个「真打 HTTP」的
 * 探针。它们拿到不凭据时会打印提示并 exit 0（跳过，不算失败），这样 CI 与
 * 别人的机器上跑 `npm run probe:http` 不会红一片。
 * ============================================================================
 */
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** ComfyUI 服务地址。 */
export function comfyUrl() {
  return (process.env.COMFY_URL ?? 'http://127.0.0.1:8188').replace(/\/+$/, '')
}

/** 正在运行的 DSH Web 地址（探针用）。 */
export function dshBase() {
  return (process.env.DSH_BASE ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
}

/** DSH 凭据文件路径。 */
export function credentialsPath() {
  return process.env.DSH_CREDENTIALS ?? join(homedir(), '.dsh', '.credentials.yaml')
}

/**
 * 找宿主 @deepseek-ai/* 包所在目录（`dsh-tools` 之类）。
 * 顺序：DSH_HOST_MODULES → 自己 resolve → 同级 node_modules → null
 * @returns {string | null}
 */
export function hostModulesDir() {
  const explicit = process.env.DSH_HOST_MODULES
  if (explicit) return explicit
  try {
    // @deepseek-ai/dsh-tools/lib/index.js → .../node_modules/@deepseek-ai
    const entry = require.resolve('@deepseek-ai/dsh-tools/package.json')
    return dirname(dirname(entry))
  } catch {
    /* 没装宿主依赖，继续往下猜 */
  }
  for (const guess of [
    join(process.cwd(), 'node_modules', '@deepseek-ai'),
    join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai'),
  ]) {
    if (existsSync(guess)) return guess
  }
  return null
}

/**
 * 从 DSH 凭据文件里读 browser-session 的签名密钥。
 * @returns {Buffer | null}
 */
export function readBrowserSecret() {
  const path = credentialsPath()
  if (!existsSync(path)) return null
  const yaml = readFileSync(path, 'utf8')
  const m = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
  if (!m) return null
  const secret = Buffer.from(m[1], 'base64url')
  return secret.byteLength === 32 ? secret : null
}

const b64 = (buf) => Buffer.from(buf).toString('base64url')

/**
 * 造一个 DSH 认的浏览器 cookie。
 * 给了 DSH_AUTH_COOKIE 就直接用它（省得读凭据文件）。
 * @returns {string | null}
 */
export function browserCookie(base = dshBase()) {
  if (process.env.DSH_AUTH_COOKIE) return process.env.DSH_AUTH_COOKIE

  const secret = readBrowserSecret()
  if (!secret) return null

  const authority = new URL(base).host // http ⇒ audience 就是 host（不带协议）
  const name = 'dsh-auth-' + b64(createHash('sha256').update(authority).digest())
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 }
  const body = b64(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64(createHmac('sha256', secret).update(body).digest())
  return `${name}=v${payload.version}.${body}.${sig}`
}

/**
 * 要 cookie 的探针开头都调它：拿不到就打印怎么配、然后 exit 0（跳过不是失败）。
 * @param {string} label 探针名，用于提示
 * @returns {string} 可用的 cookie
 */
export function requireCookieOrSkip(label) {
  const cookie = browserCookie()
  if (cookie) return cookie
  console.log(`· 跳过 ${label}：没找到 DSH 凭据`)
  console.log(`  需要 ${credentialsPath()}（含 client-connection/browser-session.secret）`)
  console.log('  或者设 DSH_CREDENTIALS=<凭据文件路径> / DSH_AUTH_COOKIE=<现成 cookie>')
  process.exit(0)
}

/** 小工具：打印一行提示并正常退出（用于「环境不具备」的跳过）。 */
export function skip(label, reason) {
  console.log(`· 跳过 ${label}：${reason}`)
  process.exit(0)
}
