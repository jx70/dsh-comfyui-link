/**
 * picker.test.mjs —— 原生文件夹选择框的纯函数与路由契约
 * ============================================================================
 * 这一份**不弹任何窗口**：对话框本身要么靠人去点，要么靠子进程，测试里一律绕开。
 * 钉住的是四件事：
 *   1. powershellPath() 在非 Windows 上返回 ''（CI 的 ubuntu 也要能跑）
 *   2. 单引号转义（路径里带 ' 时脚本不被截断）
 *   3. 脚本内容（-STA、隐形 owner、UTF-8 临时文件）与 initial 空值不写 SelectedPath
 *   4. 回传文本的解析与 POST 路由的形状/坏请求分支
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPickerScript,
  parsePickedText,
  parsePowerShellError,
  powershellPath,
  quotePowerShell,
} from '../index.js'
import { createFakeCtx } from './helpers/fake-ctx.mjs'

const plugin = await import('../index.js')

const PICK_PATH = '/api/comfyui/pick-directory'

test('powershellPath 在非 Windows 上返回空串，在 Windows 上指到 powershell.exe', () => {
  const found = powershellPath()
  if (process.platform === 'win32') {
    assert.match(found, /powershell\.exe$/i)
  } else {
    assert.equal(found, '')
  }
})

test('quotePowerShell 把内部单引号双写，路径不会被截断', () => {
  assert.equal(quotePowerShell('plain'), "'plain'")
  assert.equal(quotePowerShell("D:\\a'b"), "'D:\\a''b'")
  assert.equal(quotePowerShell("C:\\it''s"), "'C:\\it''''s'")
  assert.equal(quotePowerShell(undefined), "''")
})

test('buildPickerScript 生成了 -STA 需要的完整脚本', () => {
  const script = buildPickerScript({ tempFile: 'C:\\tmp\\x.txt' })
  assert.match(script, /FolderBrowserDialog/)
  assert.match(script, /ShowDialog\(\$owner\)/)
  assert.match(script, /UTF8Encoding\(\$false\)/)
  assert.match(script, /\$ErrorActionPreference/)
  // 不关进度流的话 stderr 会塞满 CLIXML 噪音，真正的错误就被埋了
  assert.match(script, /\$ProgressPreference = 'SilentlyContinue'/)
  assert.match(script, /\$owner\.TopMost = \$true/)
  assert.match(script, /\$owner\.Opacity = 0/)
  assert.match(script, /'C:\\tmp\\x\.txt'/)
  // 没给 initial 就不该有赋值（否则对话框会每次都跳回上次那个目录）
  assert.doesNotMatch(script, /\$dlg\.SelectedPath = /)
})

test('buildPickerScript 带 initial 时写进 SelectedPath，并转义标题', () => {
  const script = buildPickerScript({
    tempFile: 'C:\\tmp\\x.txt',
    title: "选 目录 'x'",
    initial: 'D:\\图片\\输出',
  })
  assert.match(script, /\$dlg\.SelectedPath = 'D:\\图片\\输出'/)
  assert.match(script, /\$dlg\.Description = '选 目录 ''x'''/)
})

test('buildPickerScript 不含本机绝对路径（去本地化守护）', () => {
  const script = buildPickerScript({ tempFile: '/tmp/picked.txt' })
  assert.doesNotMatch(script, /[A-Za-z]:[\\/]Users[\\/]/)
  assert.doesNotMatch(script, /npm-cache[\\/]_npx/)
})

test('parsePickedText 认 OK / CANCEL / 乱码，并把 BOM 剥掉', () => {
  assert.deepEqual(parsePickedText('OK\r\nD:\\图片\r\n'), { cancelled: false, path: 'D:\\图片' })
  assert.deepEqual(parsePickedText('\uFEFFOK\n/nested/dir\n'), { cancelled: false, path: '/nested/dir' })
  assert.deepEqual(parsePickedText('OK\n\\\\server\\share'), {
    cancelled: false,
    path: '\\\\server\\share',
  })
  assert.deepEqual(parsePickedText('CANCEL'), { cancelled: true, path: '' })
  assert.deepEqual(parsePickedText(''), { cancelled: true, path: '' })
  assert.deepEqual(parsePickedText('garbage'), { cancelled: true, path: '' })
  assert.deepEqual(parsePickedText('OK'), { cancelled: true, path: '' })
  assert.deepEqual(parsePickedText(undefined), { cancelled: true, path: '' })
})

test('parsePowerShellError 从 CLIXML 里挖出正文，普通 stderr 取最后一行', () => {
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    + '<S S="Error">boom 中文_x000D__x000A_</S><S S="Error">所在位置 行:3 字符: 1_x000D__x000A_</S></Objs>'
  assert.equal(parsePowerShellError(clixml), 'boom 中文')
  assert.equal(parsePowerShellError('some error line\r\n'), 'some error line')
  assert.equal(parsePowerShellError(''), '')
  assert.equal(parsePowerShellError(undefined), '')
})

test('选择目录路由是 POST + buffered，且只注册一条', () => {
  const fake = createFakeCtx()
  plugin.apply(fake.ctx, {})
  const route = fake.routes.find((r) => r.path === PICK_PATH)
  assert.ok(route, '选择目录路由没注册')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(fake.routes.filter((r) => r.path === PICK_PATH).length, 1)
})

test('选择目录路由：坏 JSON 直接 400，绝不开对话框', async () => {
  const fake = createFakeCtx()
  plugin.apply(fake.ctx, {})
  const route = fake.routes.find((r) => r.path === PICK_PATH)
  const response = await route.fetch(
    new Request('http://localhost/api/comfyui/pick-directory', {
      method: 'POST',
      body: 'not json at all',
      headers: { 'content-type': 'application/json' },
    }),
  )
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'bad-request')
})
