/**
 * lora-docs.test.mjs —— LoRA 提示词文档的挑选链
 * ============================================================================
 * 这些函数不碰网络、不碰 ComfyUI，`npm test` 里直接跑；落盘用临时目录。
 * 覆盖的重点：
 *   · 目录留空时一个文件都不读（设置里没选目录 = 完全关掉这个功能）。
 *   · **文件名不再是门槛**：名字完全不对、正文里提到 LoRA 名也要能挑中。
 *   · 目录里混着散文、图片、子目录时，只挑像提示词的那篇。
 *   · 挑不中就什么都不并（mode='none'），宁缺毋滥。
 *   · 只认 .md / .markdown / .txt，深度最多 3 层，超大文件跳过。
 *   · 提示词段：有「提示词 / Prompt」标题就只取那一段，没有就取全文；超长截断。
 *   · 空文档并进 prompt 时一个字符都不改（否则会在 prompt 尾巴上留空白）。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  chooseLoraDoc,
  composeLoraPrompt,
  docTitle,
  extractPromptSection,
  looksLikePrompt,
  nameTokens,
  normalizeLoraKey,
  rankLoraDocs,
  readLoraDocs,
  resolveConfiguredDir,
  scoreDocForLora,
} from '../index.js'

/** 造一个临时目录，跑完自动删；回调里拿到的 root 就是「提示词目录」 */
async function withDir(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'comfyui-lora-docs-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = join(root, name)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('normalizeLoraKey 把各种写法收敛成同一个 key', () => {
  // 扩展名、大小写、空格、下划线、连字符都不该影响对齐
  assert.equal(normalizeLoraKey('belle_anima_v1.safetensors'), 'belle_anima_v1')
  assert.equal(normalizeLoraKey('Belle Anima v1.safetensors'), 'belle_anima_v1')
  assert.equal(normalizeLoraKey('belle-anima-v1'), 'belle_anima_v1')
  assert.equal(normalizeLoraKey('  Belle__Anima--v1  '), 'belle_anima_v1')
  // 没有扩展名也照常
  assert.equal(normalizeLoraKey('光辉'), '光辉')
  // 非字符串一律空 key（调用方据此判定「没法对齐」）
  assert.equal(normalizeLoraKey(undefined), '')
  assert.equal(normalizeLoraKey(''), '')
})

test('nameTokens 把名字切成词，用来算「命中几个词」', () => {
  assert.deepEqual(nameTokens('Belle Anima v1.safetensors'), ['belle', 'anima', 'v1'])
  assert.deepEqual(nameTokens('belle-anima-v1'), ['belle', 'anima', 'v1'])
  assert.deepEqual(nameTokens('光辉'), ['光辉'])
  assert.deepEqual(nameTokens(''), [])
  assert.deepEqual(nameTokens(undefined), [])
})

test('looksLikePrompt：逗号分隔的 tag 串算提示词，成段的说明文字不算', () => {
  assert.equal(looksLikePrompt('1girl, solo, long hair, blue eyes, smile'), true)
  // 中文逗号、顿号都算分隔符
  assert.equal(looksLikePrompt('一个女孩，长发，蓝眼睛，微笑，白裙'), true)
  // 散文：分隔符不够
  assert.equal(looksLikePrompt('最近在试一种更冷的色调。画面的光比很大，阴影偏蓝。'), false)
  // 逗号很多但都是长句（说明文里的列举），也不认
  assert.equal(
    looksLikePrompt([
      '这张图我想做成一种偏冷的色调，光源从左侧打过来，阴影偏蓝，整体要安静一点',
      '角色的头发要有银色的高光，眼睛是红色，衣服是黑色长裙，背景是一座荒废的花园',
    ].join('\n')),
    false,
  )
  assert.equal(looksLikePrompt(''), false)
  assert.equal(looksLikePrompt(undefined), false)
})

test('docTitle 取第一行非空行，去掉 markdown 井号', () => {
  assert.equal(docTitle('# Belle Anima\n\n正文'), 'Belle Anima')
  assert.equal(docTitle('\n\n  银发角色  \n正文'), '银发角色')
  assert.equal(docTitle('\uFEFF## 提示词\nhello'), '提示词')
  assert.equal(docTitle(''), '')
  assert.equal(docTitle(undefined), '')
})

test('extractPromptSection：有「提示词」标题只取那一段', () => {
  const text = [
    '# Belle Anima',
    '',
    '这是一份说明，不该被塞进 prompt。',
    '',
    '## 提示词',
    'masterpiece, silver long hair, red eyes',
    '',
    '### 备注',
    '子标题算正文。',
    '',
    '## 其他',
    '这段不该带上。',
  ].join('\n')
  const section = extractPromptSection(text)
  assert.equal(section.heading, '## 提示词')
  assert.equal(section.truncated, false)
  assert.match(section.text, /masterpiece, silver long hair, red eyes/)
  assert.match(section.text, /子标题算正文/)
  assert.doesNotMatch(section.text, /不该被塞进 prompt/)
  assert.doesNotMatch(section.text, /这段不该带上/)
})

test('extractPromptSection：没有标题就取全文，超长截断并标记', () => {
  const plain = 'just a prompt, no heading at all'
  assert.deepEqual(extractPromptSection(plain), { text: plain, truncated: false, heading: '' })

  const long = 'x'.repeat(50)
  const cut = extractPromptSection(long, { maxChars: 10 })
  assert.equal(cut.truncated, true)
  assert.equal(cut.text.length, 10)
  assert.equal(cut.heading, '')

  // 空白 / 非字符串 → 空段，不抛
  assert.deepEqual(extractPromptSection('   '), { text: '', truncated: false, heading: '' })
  assert.deepEqual(extractPromptSection(undefined), { text: '', truncated: false, heading: '' })
  // BOM 要剥掉，否则第一行标题匹配不上
  assert.equal(extractPromptSection('\uFEFF## Prompt\nhello').text, 'hello')
})

test('scoreDocForLora：名字完全不对，但正文提到 LoRA 名 + 有提示词小标题，照样高分', () => {
  const doc = { name: '角色笔记.md', stem: '角色笔记', key: '角色笔记' }
  const text = [
    '# 银发角色',
    '',
    '这套 LoRA 是 Belle Anima v1 训练出来的，用在 SDXL 上。',
    '',
    '## 提示词',
    'masterpiece, best quality, 1girl, silver long hair, red eyes',
  ].join('\n')
  const result = scoreDocForLora(doc, text, 'Belle Anima v1.safetensors')
  assert.ok(result.score >= 45, `分数应该够高，实际 ${result.score}`)
  assert.deepEqual(result.reasons, ['正文提到 LoRA 名', '有「提示词」小标题', '内容像提示词'])
  assert.equal(result.promptish, true)
  assert.equal(result.hasPromptHeading, true)
  assert.equal(result.title, '银发角色')
  assert.match(result.section.text, /masterpiece/)
})

test('scoreDocForLora：文件名一致分最高；散文得零分', () => {
  const named = { name: 'belle_anima_v1.md', stem: 'belle_anima_v1', key: 'belle_anima_v1' }
  const hit = scoreDocForLora(named, 'a girl, standing, in a garden, at night', 'belle_anima_v1.safetensors')
  assert.ok(hit.reasons.includes('文件名与 LoRA 名一致'))
  assert.ok(hit.score >= 100)

  const prose = { name: '画风随笔.txt', stem: '画风随笔', key: '画风随笔' }
  const miss = scoreDocForLora(prose, '最近在试一种更冷的色调。\n画面的光比很大，阴影偏蓝。', 'belle_anima_v1.safetensors')
  assert.equal(miss.score, 0)
  assert.deepEqual(miss.reasons, [])

  // 部分命中：文件名里有 2/3 个词
  const partial = { name: 'belle_anima_notes.md', stem: 'belle_anima_notes', key: 'belle_anima_notes' }
  const half = scoreDocForLora(partial, 'nothing here', 'belle_anima_v1.safetensors')
  assert.ok(half.reasons.some((item) => /文件名命中 2\/3 个词/.test(item)), half.reasons.join('、'))
})

test('readLoraDocs：目录留空直接返回空清单，一个文件都不读', async () => {
  assert.deepEqual(await readLoraDocs(''), { ok: true, dir: '', docs: [] })
  assert.deepEqual(await readLoraDocs('   '), { ok: true, dir: '', docs: [] })
  assert.deepEqual(await readLoraDocs(undefined), { ok: true, dir: '', docs: [] })
})

test('readLoraDocs：只收 .md/.markdown/.txt，跳过别的类型，目录不存在不抛', async () => {
  await withDir({
    'belle_anima_v1.md': 'a',
    'other.markdown': 'b',
    'plain.txt': 'c',
    'cover.png': 'not a doc',
    'sub/nested.md': 'd',
  }, async (root) => {
    const listed = await readLoraDocs(root)
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.docs.map((doc) => doc.name).sort(), [
      'belle_anima_v1.md', 'nested.md', 'other.markdown', 'plain.txt',
    ])
    assert.equal(listed.docs.find((doc) => doc.name === 'belle_anima_v1.md').key, 'belle_anima_v1')
    assert.equal(listed.docs.find((doc) => doc.name === 'nested.md').key, 'nested')

    // 目录不存在 → ok:false + 中文原因，绝不抛
    const missing = await readLoraDocs(join(root, 'nope'))
    assert.equal(missing.ok, false)
    assert.equal(missing.error, '目录不存在')
    assert.deepEqual(missing.docs, [])
  })
})

test('resolveConfiguredDir 报错时带上调用方给的名字', () => {
  // 相对路径 + 认不出根 → 报错，且文案里出现自定义 label（不是写死的「目录」）
  assert.throws(() => resolveConfiguredDir('docs', '', 'LoRA 提示词目录'), /LoRA 提示词目录/)
  assert.throws(() => resolveConfiguredDir('docs', undefined, '输出目录'), /输出目录/)
  // 留空 / 绝对路径都原样通过，不依赖根目录
  assert.equal(resolveConfiguredDir('', '', 'LoRA 提示词目录'), '')
  assert.equal(resolveConfiguredDir('/srv/docs', '', 'LoRA 提示词目录'), '/srv/docs')
})

test('rankLoraDocs + chooseLoraDoc：名字不对齐也能 match，散文不参与', async () => {
  await withDir({
    '角色笔记.md': [
      '# 银发角色',
      '',
      '这套是 Belle Anima v1 训的。',
      '',
      '## 提示词',
      'masterpiece, best quality, 1girl, silver long hair, red eyes',
    ].join('\n'),
    '画风随笔.txt': '最近在试一种更冷的色调。\n画面的光比很大，阴影偏蓝。',
    'cover.png': 'not a doc',
  }, async (root) => {
    const listed = await readLoraDocs(root)
    const ranked = await rankLoraDocs(listed.docs, 'belle_anima_v1.safetensors')
    assert.equal(ranked.total, 2)
    assert.equal(ranked.scanned, 2)
    assert.equal(ranked.candidates[0].doc.name, '角色笔记.md')
    assert.ok(ranked.candidates[0].score >= 45)

    const { chosen, mode } = chooseLoraDoc(ranked.candidates)
    assert.equal(mode, 'match')
    assert.equal(chosen.doc.name, '角色笔记.md')
    assert.match(chosen.section.text, /silver long hair/)
  })
})

test('chooseLoraDoc：只有一篇像提示词时用 sole，都不像就 none', async () => {
  // sole：全目录只有一篇 tag 串，名字毫不相干也用它（并在结果里说明）
  await withDir({
    'random-name.md': '1girl, solo, long hair, blue eyes, smile',
    'notes.txt': '这里记一点杂事。\n买牛奶，修图，回消息。',
  }, async (root) => {
    const listed = await readLoraDocs(root)
    const ranked = await rankLoraDocs(listed.docs, 'belle_anima_v1.safetensors')
    const { chosen, mode } = chooseLoraDoc(ranked.candidates)
    assert.equal(mode, 'sole')
    assert.equal(chosen.doc.name, 'random-name.md')
  })

  // none：两篇散文，谁都不像提示词，也都没提到这个 LoRA
  await withDir({
    'a.txt': '这里记一点杂事。\n买牛奶，修图，回消息。',
    'b.txt': '另一份笔记。\n今天下雨，没有出门。',
  }, async (root) => {
    const listed = await readLoraDocs(root)
    const ranked = await rankLoraDocs(listed.docs, 'belle_anima_v1.safetensors')
    const { chosen, mode } = chooseLoraDoc(ranked.candidates)
    assert.equal(mode, 'none')
    assert.equal(chosen, null)
  })

  // 空目录也不抛
  assert.deepEqual(chooseLoraDoc([]), { chosen: null, mode: 'none' })
  assert.deepEqual(chooseLoraDoc(undefined), { chosen: null, mode: 'none' })
})

test('子文件夹里的文档也算：按角色分目录摆照样能挑中', async () => {
  await withDir({
    // 角色名当文件夹、文档名随便取 —— 常见的摆法
    'belle_anima_v1/角色.md': [
      '# 银发角色',
      '',
      '## 提示词',
      'masterpiece, best quality, 1girl, silver long hair, red eyes',
    ].join('\n'),
    '画风/冷色调.txt': '最近在试一种更冷的色调。\n画面的光比很大，阴影偏蓝。',
    'cover.png': 'not a doc',
  }, async (root) => {
    const listed = await readLoraDocs(root)
    assert.equal(listed.ok, true)
    // 两层都在清单里，且带上了相对路径
    assert.deepEqual(listed.docs.map((doc) => doc.rel).sort(), ['belle_anima_v1/角色.md', '画风/冷色调.txt'])

    const ranked = await rankLoraDocs(listed.docs, 'belle_anima_v1.safetensors')
    const { chosen, mode } = chooseLoraDoc(ranked.candidates)
    assert.equal(mode, 'match')
    assert.equal(chosen.doc.rel, 'belle_anima_v1/角色.md')
    // 文件夹名就是 LoRA 名 → 命中「所在文件夹名与 LoRA 名一致」
    assert.ok(chosen.reasons.includes('所在文件夹名与 LoRA 名一致'), chosen.reasons.join('、'))
    assert.match(chosen.section.text, /silver long hair/)
  })
})

test('深度上限：第 4 层再往下的文档不扫（防止误指整个盘）', async () => {
  await withDir({
    'a.md': '1girl, solo, long hair, blue eyes',
    'd1/b.md': '1girl, solo, long hair, blue eyes',
    'd1/d2/c.md': '1girl, solo, long hair, blue eyes',
    'd1/d2/d3/d4/deep.md': '1girl, solo, long hair, blue eyes',
  }, async (root) => {
    const listed = await readLoraDocs(root)
    const names = listed.docs.map((doc) => doc.rel).sort()
    assert.deepEqual(names, ['a.md', 'd1/b.md', 'd1/d2/c.md'])
  })
})

test('模型与文档并排放在同一个文件夹：这是最硬的配对证据', async () => {
  await withDir({
    // 真实摆法：一个角色一个文件夹，LoRA 文件和提示词文档放一起，名字毫不相干
    '铃/belle_anima_v1.safetensors': 'not a doc',
    '铃/绝区零 铃.txt': [
      'Use the identity token plus one outfit token.',
      '',
      'Base outfit',
      'bellezzz, baseout, black shirt, long sleeves, jacket, orange gloves',
    ].join('\n'),
    // 另一个角色也有自己的文件夹与文档，不能串台
    '绫地宁宁/ayachi-nene-0.2-32.safetensors': 'not a doc',
    '绫地宁宁/绫地宁宁_提示词清单.txt': 'nene, long hair, blue eyes, school uniform',
  }, async (root) => {
    const listed = await readLoraDocs(root)
    // 模型文件本身不是文档，不会进清单；但它的名字被记进同目录文档的 siblings
    assert.deepEqual(listed.docs.map((doc) => doc.rel).sort(), ['铃/绝区零 铃.txt', '绫地宁宁/绫地宁宁_提示词清单.txt'].sort())
    const bell = listed.docs.find((doc) => doc.rel === '铃/绝区零 铃.txt')
    assert.deepEqual(bell.siblings, ['belle_anima_v1'])

    const ranked = await rankLoraDocs(listed.docs, 'belle_anima_v1.safetensors')
    const { chosen, mode } = chooseLoraDoc(ranked.candidates)
    assert.equal(mode, 'match')
    // 名字完全不对齐，靠「同目录」拿下
    assert.equal(chosen.doc.rel, '铃/绝区零 铃.txt')
    assert.ok(chosen.reasons.includes('和这个 LoRA 摆在同一个文件夹'), chosen.reasons.join('、'))
    assert.match(chosen.section.text, /bellezzz/)

    // 另一个角色的 LoRA 只会挑到自己的那篇，不会因为都在同一棵树下就串台
    const other = await rankLoraDocs(listed.docs, 'ayachi-nene-0.2-32.safetensors')
    const picked = chooseLoraDoc(other.candidates)
    assert.equal(picked.mode, 'match')
    assert.equal(picked.chosen.doc.rel, '绫地宁宁/绫地宁宁_提示词清单.txt')
  })
})

test('同一个文件夹里放了好几个 LoRA：同目录只算半个证据，仍要别的东西指认', async () => {
  await withDir({
    // 一整个系列共用一个文件夹，文档不点名就不知道该给谁
    '系列/alpha_v1.safetensors': 'not a doc',
    '系列/beta_v2.safetensors': 'not a doc',
    '系列/通用说明.txt': '1girl, solo, long hair, blue eyes, smile',
  }, async (root) => {
    const listed = await readLoraDocs(root)
    const doc = listed.docs[0]
    assert.deepEqual(doc.siblings.sort(), ['alpha_v1', 'beta_v2'])

    const ranked = await rankLoraDocs(listed.docs, 'gamma_v3.safetensors')
    const { chosen, mode } = chooseLoraDoc(ranked.candidates)
    // gamma 不在这层里 → 没有同目录加成；唯一一篇像提示词 → sole
    assert.equal(mode, 'sole')
    assert.equal(chosen.doc.rel, '系列/通用说明.txt')

    // alpha 在这层里 → 有同目录加成（60 分）+ 像提示词（12）→ match，但理由写明文件夹里还有别的模型
    const alpha = await rankLoraDocs(listed.docs, 'alpha_v1.safetensors')
    const alphaPick = chooseLoraDoc(alpha.candidates)
    assert.equal(alphaPick.mode, 'match')
    assert.ok(alphaPick.chosen.reasons.some((item) => item.includes('文件夹里还有别的模型')), alphaPick.chosen.reasons.join('、'))
  })
})

test('composeLoraPrompt：空文档原样返回，有内容才拼接', () => {
  assert.equal(composeLoraPrompt('a cat', ''), 'a cat')
  assert.equal(composeLoraPrompt('a cat', '   '), 'a cat')
  assert.equal(composeLoraPrompt('a cat', undefined), 'a cat')
  assert.equal(composeLoraPrompt('a cat', 'silver hair'), 'a cat\n\nsilver hair')
  // 用户没给 prompt 时，文档就是全部（不留前导空行）
  assert.equal(composeLoraPrompt('', 'silver hair'), 'silver hair')
  assert.equal(composeLoraPrompt(undefined, 'silver hair'), 'silver hair')
  // 前后空白要收掉，避免 prompt 里出现三连换行
  assert.equal(composeLoraPrompt('  a cat  ', '  silver hair  '), 'a cat\n\nsilver hair')
})
