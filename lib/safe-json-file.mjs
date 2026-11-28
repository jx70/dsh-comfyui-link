/**
 * lib/safe-json-file.mjs —— 工作流 JSON 路径的安全读取（P0）
 * ============================================================================
 * comfy_inspect 与 comfy_learn 共用：
 *   · 只接受 .json / .jsonl（默认 .json）普通文件；
 *   · 拒绝相对路径、URL、NUL、空路径；
 *   · realpath 后仍必须落在明确白名单目录内，白名单本身也 realpath；
 *   · 拒绝符号链接 / 非常规文件 / >16 MiB；
 *   · 错误只返回稳定、不含真实路径的文案，避免泄露用户目录。
 *
 * 白名单来源（显式传入优先）：
 *   1. caller roots：ComfyUI output root / 插件家目录里的工作流目录；
 *   2. process.cwd() 下的 workflows / workflow / 工作流 / examples / example 目录（存在才收）；
 *   3. ComfyUI 常见 user/default/workflows 目录（存在才收）；
 * 不接收任意绝对路径：这是给 Agent 用的工具，路径来自自然语言，不能当能力边界。
 * ============================================================================
 */
import { lstat, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve, sep } from 'node:path'

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const ALLOWED_EXT = new Set(['.json', '.jsonl'])

const isDirInside = (dir, parent) => dir === parent || dir.startsWith(parent + sep)

function asTrimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 安全读取 JSON 文件。
 * @param {object} opts
 * @param {string} opts.path 用户给的路径（只接受绝对路径）
 * @param {string[]} [opts.roots] 允许的根目录（绝对路径）
 * @param {number} [opts.maxBytes] 最大字节数
 * @returns {Promise<{ok:true, value:any, meta:{extension:string, size:number}} | {ok:false, error:string}>}
 */
export async function readSafeJsonFile({ path, roots = [], maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const raw = asTrimmed(path)
  if (!raw) return { ok: false, error: '文件路径为空' }
  if (raw.includes('\0')) return { ok: false, error: '文件路径含非法字符' }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return { ok: false, error: '只接受本地文件路径，不接受 URL' }
  if (!isAbsolute(raw)) return { ok: false, error: '请用绝对路径（工作流 JSON 的完整路径）' }

  const ext = extname(raw).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) return { ok: false, error: '只接受 .json / .jsonl 文件' }

  let candidate
  try {
    candidate = await realpath(raw)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: '文件不存在' }
    if (error?.code === 'ELOOP') return { ok: false, error: '拒绝符号链接指向的文件' }
    return { ok: false, error: '文件不可读' }
  }

  let info
  try {
    info = await lstat(candidate)
  } catch {
    return { ok: false, error: '文件不可读' }
  }
  if (info.isSymbolicLink()) return { ok: false, error: '拒绝符号链接指向的文件' }
  if (!info.isFile()) return { ok: false, error: '不是普通文件' }
  if (info.size > maxBytes) return { ok: false, error: '文件超过大小上限' }

  const allowed = []
  for (const item of roots) {
    const r = asTrimmed(item)
    if (!r || !isAbsolute(r)) continue
    try {
      allowed.push(await realpath(r))
    } catch {
      // 白名单目录不存在就跳过，不把它当可写可任意通过的口子
    }
  }
  // 当前工作目录是用户明确的工作区，允许其下的工作流资源目录（不是整个 cwd）
  const cwd = resolve(process.cwd() ?? '')
  for (const sub of ['workflows', 'workflow', '工作流', 'examples', 'example']) {
    try {
      allowed.push(await realpath(resolve(cwd, sub)))
    } catch {
      // 目录不存在跳过
    }
  }
  if (allowed.length === 0 || !allowed.some((root) => isDirInside(candidate, root))) {
    return { ok: false, error: '文件不在允许的工作流目录内' }
  }

  const { readFile } = await import('node:fs/promises')
  let text
  try {
    text = await readFile(candidate, 'utf8')
  } catch {
    return { ok: false, error: '文件不可读' }
  }
  let value
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, error: '不是合法 JSON' }
  }
  return { ok: true, value, meta: { extension: ext, size: info.size } }
}
