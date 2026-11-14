/**
 * output.test.mjs —— 输出目录那几个纯函数
 * ============================================================================
 * 这些函数不碰网络、不碰 ComfyUI，`npm test` 里直接跑；落盘用临时目录。
 * 覆盖的重点是踩过的坑：
 *   · 绝对路径判定不能用 path.isAbsolute —— 它跟平台走，同一份配置在两台机器上
 *     会得出相反结论（盘符路径在 Linux 上被当成相对路径）。所以这里两个平台的
 *     写法都要断言，测试本身不能依赖 process.platform。
 *   · 相对路径必须挂在 ComfyUI 的 output 下面；认不出根目录要报错，不能悄悄写到 cwd。
 *   · 重名加 -1 / -2，不覆盖用户已有的文件。
 *   · 目录留空时一行都不写（默认行为跟没有这个功能时完全一致）。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { looksAbsolute, resolveOutputDir, saveImageCopy, uniqueTarget } from '../index.js'

const WIN_ABS = 'X:' + sep + 'pics'
const POSIX_ABS = '/srv/pics'
const UNC = sep + sep + 'nas' + sep + 'share'

test('looksAbsolute 认三种绝对写法，且结论与平台无关', () => {
  // 盘符：Windows 上是绝对路径，在 Linux 上写法依然「看起来绝对」
  assert.equal(looksAbsolute(WIN_ABS), true)
  assert.equal(looksAbsolute('C:/pics'), true)
  // POSIX 根
  assert.equal(looksAbsolute(POSIX_ABS), true)
  // UNC
  assert.equal(looksAbsolute(UNC), true)
  // 相对路径一律不是
  assert.equal(looksAbsolute('pics/out'), false)
  assert.equal(looksAbsolute('./out'), false)
  assert.equal(looksAbsolute('..'), false)
  // 空 / 非字符串
  assert.equal(looksAbsolute(''), false)
  assert.equal(looksAbsolute('   '), false)
  assert.equal(looksAbsolute(undefined), false)
  assert.equal(looksAbsolute(null), false)
})

test('resolveOutputDir：留空＝不复制，绝对＝原样，相对＝挂在 ComfyUI 的 output 下', () => {
  // 留空（含只有空白）→ 空串，调用方据此跳过整条复制路径
  assert.equal(resolveOutputDir('', '/comfy/output'), '')
  assert.equal(resolveOutputDir('   ', '/comfy/output'), '')
  assert.equal(resolveOutputDir(undefined, '/comfy/output'), '')

  // 绝对路径原样返回，不往上拼任何东西
  assert.equal(resolveOutputDir(WIN_ABS, '/comfy/output'), WIN_ABS)
  assert.equal(resolveOutputDir(POSIX_ABS, '/comfy/output'), POSIX_ABS)

  // 相对路径拼到 ComfyUI 的 output 下，并且容忍根本身的尾分隔符
  assert.equal(resolveOutputDir('pics', '/comfy/output'), join('/comfy/output', 'pics'))
  assert.equal(resolveOutputDir('pics', '/comfy/output/'), join('/comfy/output', 'pics'))

  // 相对路径但认不出根 → 报错（否则会写进进程 cwd，用户根本找不到）
  assert.throws(() => resolveOutputDir('pics', ''), /相对路径/)
  assert.throws(() => resolveOutputDir('pics', undefined), /相对路径/)
})

test('uniqueTarget 不覆盖已有文件，重名依次加 -1 / -2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfyui-out-'))
  try {
    const first = await uniqueTarget(dir, 'image.png')
    assert.equal(first, join(dir, 'image.png'))

    await writeFile(first, 'a')
    const second = await uniqueTarget(dir, 'image.png')
    assert.equal(second, join(dir, 'image-1.png'))

    await writeFile(second, 'b')
    const third = await uniqueTarget(dir, 'image.png')
    assert.equal(third, join(dir, 'image-2.png'))

    // 没扩展名 / 点开头的隐藏文件也不能把名字切坏
    assert.equal(await uniqueTarget(dir, 'noext'), join(dir, 'noext'))
    assert.equal(await uniqueTarget(dir, '.hidden'), join(dir, '.hidden'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saveImageCopy：目录留空什么都不做，配了就建目录并落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-save-'))
  const dir = join(root, 'nested', 'out')
  try {
    const image = { filename: 'ComfyUI_00001_.png', subfolder: 'dsh' }
    const bytes = Buffer.from('fake-png-bytes')

    // 留空 → 空串，且不创建任何目录
    assert.equal(await saveImageCopy('', image, bytes), '')
    assert.equal(await saveImageCopy('   ', image, bytes), '')
    // 没有字节也不写（取图失败时不该留下空文件）
    assert.equal(await saveImageCopy(dir, image, undefined), '')

    const target = await saveImageCopy(dir, image, bytes)
    assert.equal(target, join(dir, 'ComfyUI_00001_.png'))
    assert.equal(await readFile(target, 'utf8'), 'fake-png-bytes')

    // 同一个文件名再来一次 → 加 -1，不覆盖
    const again = await saveImageCopy(dir, image, bytes)
    assert.equal(again, join(dir, 'ComfyUI_00001_-1.png'))
    assert.equal(await readFile(target, 'utf8'), 'fake-png-bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
