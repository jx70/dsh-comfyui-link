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
 *   · 提示词段：有「提示词 / Prompt」标题就只取那一段，没有就取全文；超长按边界收口（不切半个 tag）。
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
  composeDocSection,
  composeLoraPrompt,
  composeNegative,
  describeDrawConfig,
  docAliases,
  docTitle,
  extractPromptSection,
  findNegativeNode,
  loraAliases,
  looksLikePrompt,
  matchLoraForPrompt,
  nameTokens,
  normalizeAlias,
  normalizeLoraKey,
  parsePromptBlocks,
  pickPromptBlocks,
  promptBody,
  promptWords,
  rankLoraDocs,
  readLoraDocs,
  resolveConfiguredDir,
  scoreDocForLora,
  tagishLine,
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

test('extractPromptSection：没有标题就取全文，超长按边界收口并报出字数', () => {
  const plain = 'just a prompt, no heading at all'
  assert.deepEqual(extractPromptSection(plain), {
    text: plain, truncated: false, heading: '', totalChars: plain.length, keptChars: plain.length, cut: '',
  })

  // 空行边界最优先
  const blankRun = 'line one, tag, tag\n\nline two, tag, tag, tag'
  const blankCut = extractPromptSection(blankRun, { maxChars: 20 })
  assert.equal(blankCut.cut, 'blank')
  assert.equal(blankCut.text, 'line one, tag, tag')
  assert.equal(blankCut.truncated, true)
  assert.equal(blankCut.totalChars, blankRun.length)
  assert.equal(blankCut.keptChars, blankCut.text.length)

  // 中文逗号边界、且切后不带残留分隔符、不切半个 tag
  const tags = 'masterpiece, best quality, 1girl, silver long hair, red eyes, school uniform'
  // 上限 30 时窗口是 "...1girl" 的半截（"1gir"），应该退到前一个逗号，绝不带半截 tag
  const tagCut = extractPromptSection(tags, { maxChars: 30 })
  assert.equal(tagCut.cut, 'comma')
  assert.equal(tagCut.text, 'masterpiece, best quality')
  assert.ok(tagCut.keptChars <= 30)
  // 上限 33 时窗口刚好把一个完整 tag 包含进来，就把它收进来
  const wider = extractPromptSection(tags, { maxChars: 33 })
  assert.equal(wider.cut, 'comma')
  assert.equal(wider.text, 'masterpiece, best quality, 1girl')
  assert.doesNotMatch(wider.text, /[,，、;；\s]$/)

  // 完全没有边界 → 硬切，并如实标出来
  const noBoundary = 'x'.repeat(50)
  const hardCut = extractPromptSection(noBoundary, { maxChars: 10 })
  assert.equal(hardCut.truncated, true)
  assert.equal(hardCut.cut, 'hard')
  assert.equal(hardCut.keptChars, 10)

  // 空白 / 非字符串 → 空段，不抛
  const emptyShape = { truncated: false, heading: '', totalChars: 0, keptChars: 0, cut: '' }
  assert.deepEqual(extractPromptSection('   '), { text: '', ...emptyShape })
  assert.deepEqual(extractPromptSection(undefined), { text: '', ...emptyShape })
  // BOM 要剥掉，否则第一行标题匹配不上
  assert.equal(extractPromptSection('\uFEFF## Prompt\nhello').text, 'hello')
})

test('extractPromptSection：边界太靠前就换下一档，不把预算浪费成几个字', () => {
  // 逗号在 4 个字处（< 60% 的下限），后面只有空格 → 应该退到空格边界
  const text = 'aaaa, bbbb cccc dddd eeee ffff gggg'
  const cut = extractPromptSection(text, { maxChars: 20 })
  assert.equal(cut.cut, 'space')
  assert.equal(cut.text, 'aaaa, bbbb cccc')

  // 上限比全文大 → 不截断、cut 为空
  const short = 'a, b, c'
  const whole = extractPromptSection(short, { maxChars: 4000 })
  assert.equal(whole.truncated, false)
  assert.equal(whole.cut, '')
  assert.equal(whole.keptChars, whole.totalChars)
})

test('extractPromptSection：不变量 —— keptChars <= maxChars，truncated 与 cut 一致', () => {
  const text = Array.from({ length: 40 }, (_, i) => `tag_${i}`).join(', ')
  for (const maxChars of [200, 201, 250, 400]) {
    const cut = extractPromptSection(text, { maxChars })
    assert.ok(cut.keptChars <= maxChars, `${maxChars} 超了：${cut.keptChars}`)
    assert.equal(cut.truncated, cut.keptChars !== cut.totalChars)
    assert.equal(cut.truncated, cut.cut !== '')
  }
})

test('promptBody：只剥 BOM 与标题，不做截断', () => {
  const text = '# 标题\n\n## 提示词\nmasterpiece, 1girl\n\n## 其他\n别带'
  const body = promptBody(text)
  assert.equal(body.heading, '## 提示词')
  assert.doesNotMatch(body.body, /别带/)
  assert.match(body.body, /masterpiece, 1girl/)
  assert.deepEqual(promptBody(undefined), { body: '', heading: '' })
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

test('rankLoraDocs：触到扫描上限时记 stoppedBy 并列出没打分的篇目，不再静默', async () => {
  // 目录里塞 5 篇，扫描上限调成 2 —— 剩下 3 篇必须被点名，不能当作「目录里就这几篇」
  const files = {}
  for (let index = 0; index < 5; index += 1) {
    files[`doc-${index}.txt`] = `1girl, solo, long hair, tag_${index}`
  }
  await withDir(files, async (root) => {
    const listed = await readLoraDocs(root)
    const ranked = await rankLoraDocs(listed.docs, 'belle_anima_v1.safetensors', { limit: 2 })
    assert.equal(ranked.total, 5)
    assert.equal(ranked.scanned, 2)
    assert.equal(ranked.stoppedBy, 'limit')
    assert.equal(ranked.notScanned.length, 3)
    // 没参与打分的名字必须来自剩下那 3 篇，不能把已读过的混进来
    const scannedNames = new Set(listed.docs.slice(0, 2).map((doc) => doc.name))
    for (const name of ranked.notScanned) assert.ok(!scannedNames.has(name), `${name} 其实读过`)
  })

  // 没触到上限时两个字段都是空的 —— 别让人误以为「总有文档没看」
  await withDir({ 'a.txt': '1girl, solo, long hair' }, async (root) => {
    const listed = await readLoraDocs(root)
    const ranked = await rankLoraDocs(listed.docs, 'belle_anima_v1.safetensors')
    assert.equal(ranked.stoppedBy, '')
    assert.deepEqual(ranked.notScanned, [])
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
  assert.equal(composeLoraPrompt('  a cat  ',  '  silver hair  '), 'a cat\n\nsilver hair')
})

test('tagishLine：逗号分隔的 tag 串是 tag，中文说明 / 表格 / 全角括号都不是', () => {
  assert.equal(tagishLine('tenshi_amane_school, hairband, black hairband, braid, yellow necktie'), true)
  // 末尾挂着分隔符也算同一行（作者手滑多打了个逗号）
  assert.equal(tagishLine('masterpiece, best quality, 1girl, solo, '), true)
  // 太短 / 段数不够
  assert.equal(tagishLine('a, b'), false)
  assert.equal(tagishLine('masterpiece, best quality, 1girl'), true)
  // 中文叙述、句号收尾、表格、全角括号里的说明
  assert.equal(tagishLine('这套是 Belle Anima v1 训的。'), false)
  assert.equal(tagishLine('| 项目 | 说明 |'), false)
  assert.equal(tagishLine('off shoulder（要披肩时用）, lowres, bad anatomy, bad hands'), false)
  // 「一段中文标签 + 一串英文 tag」混排：绝大多数段不是纯英文，判掉（交给上层剥标签）
  assert.equal(tagishLine('军装 peaked cap, military hat, black headwear, white gloves'), false)
  // 空值不抛
  assert.equal(tagishLine(''), false)
  assert.equal(tagishLine(undefined), false)
})

test('parsePromptBlocks：正负分流、跨块延续、章节标题把态重置回正面', () => {
  const doc = [
    '这套是 Belle Anima v1 训的。',
    '',
    '▍① SCHOOL UNIFORM',
    'tenshi_amane_school, hairband, braid, yellow necktie',
    '',
    '负面：',
    'worst quality, low quality, bad anatomy',
    '',
    '▍② ROOM WEAR',
    'tenshi_amane_roomwear, cardigan, floral print, sleeveless',
    '',
    '作者备注：无。',
  ].join('\n')
  const parsed = parsePromptBlocks(doc)
  assert.deepEqual(parsed.positive.map((b) => b.text), [
    'tenshi_amane_school, hairband, braid, yellow necktie',
    // `▍②` 是章节标题：不然后面这段会跟着上一处「负面」一起算负面
    'tenshi_amane_roomwear, cardigan, floral print, sleeveless',
  ])
  assert.deepEqual(parsed.negative.map((b) => b.text), ['worst quality, low quality, bad anatomy'])
  assert.equal(parsed.blocks, 5)
  // 开头那句散文 + 结尾「作者备注：无。」两块都是纯说明
  assert.equal(parsed.dropped, 2)
  assert.equal(parsed.totalChars, doc.length)
  // 负面单独成行、tag 写在下一块，仍然算负面（`负面：` 后空一行是常见写法）
  const split = parsePromptBlocks(['负面：', '', 'low quality, blurry, bad anatomy'].join('\n'))
  assert.equal(split.positive.length, 0)
  assert.deepEqual(split.negative.map((b) => b.text), ['low quality, blurry, bad anatomy'])
})

test('parsePromptBlocks：行内 tag、中文标签、方括号占位符都要洗干净', () => {
  const doc = [
    '## 正面提示词',
    '',
    '军装 peaked cap, military hat, black headwear, white gloves, military uniform',
    '',
    'masterpiece, best quality, 1girl, solo, shiki natsume, [在这里写你要的服装标签], looking at viewer',
    '',
    '校服 school uniform, black pantyhose, white skirt',
    '',
    '负面：low quality, blurry, worst quality',
  ].join('\n')
  const parsed = parsePromptBlocks(doc)
  assert.deepEqual(parsed.positive.map((b) => b.text), [
    // 段首中文标签是给人看的，剥掉
    'peaked cap, military hat, black headwear, white gloves, military uniform',
    // 方括号占位符是模板槽位，不该进 prompt
    'masterpiece, best quality, 1girl, solo, shiki natsume, looking at viewer',
    'school uniform, black pantyhose, white skirt',
  ])
  // 冒号后面直接跟 tag 的写法
  assert.deepEqual(parsed.negative.map((b) => b.text), ['low quality, blurry, worst quality'])
})

test('parsePromptBlocks：`对策：负面里写死 xxx` 是正文，不是负面小标题', () => {
  const doc = [
    'tenshi_amane_school, hairband, braid, yellow necktie',
    '',
    '对策：负面里写死 school uniform, yellow necktie, suspender skirt。',
    '',
    'tenshi_amane_roomwear, cardigan, floral print, sleeveless',
  ].join('\n')
  const parsed = parsePromptBlocks(doc)
  assert.equal(parsed.negative.length, 0)
  assert.equal(parsed.positive.length, 2)
})

test('promptWords：只留内容词，停用词与权重数字不算', () => {
  assert.deepEqual(promptWords('masterpiece, best quality, 1girl, solo, SILVER hair, (red eyes:1.2), 0.8'), [
    '1girl', 'silver', 'hair', 'red', 'eyes',
  ])
  assert.deepEqual(promptWords(''), [])
  assert.deepEqual(promptWords(undefined), [])
})

test('pickPromptBlocks：贴题的段优先，装不下的进 unpicked，最后仍按原文顺序拼', () => {
  const blocks = [
    { text: 'school uniform, yellow necktie, suspender skirt, pleated skirt' },
    { text: 'green eyes, pink hair, very long hair, single braid, hairband' },
    { text: 'battle uniform, black jacket, red armband, boots, gloves' },
  ]
  // 预算紧：先装最贴题的那段，再装按原文顺序排在它前面的
  const hair = pickPromptBlocks(blocks, { maxChars: 130, prompt: 'pink hair, hairband' })
  assert.match(hair.text, /hairband/)
  assert.match(hair.text, /school uniform/)
  assert.doesNotMatch(hair.text, /battle uniform/)
  assert.equal(hair.picked, 2)
  assert.equal(hair.total, 3)
  assert.equal(hair.unpicked.length, 1)
  const battle = pickPromptBlocks(blocks, { maxChars: 130, prompt: 'battle uniform, boots' })
  assert.match(battle.text, /battle uniform/)
  assert.doesNotMatch(battle.text, /hairband/)
  // 拼回去的顺序必须是文档顺序（school 在前面）
  assert.ok(battle.text.indexOf('school uniform') < battle.text.indexOf('battle uniform'))
  // 没给 prompt 时退化成按原文顺序取
  const plain = pickPromptBlocks(blocks, { maxChars: 130 })
  assert.equal(plain.picked, 2)
  assert.ok(plain.text.startsWith('school uniform'))
})

test('pickPromptBlocks：唯一一段就超预算时按边界收口，不整篇白读', () => {
  const blocks = [{ text: Array.from({ length: 100 }, (_, i) => `tag_${i}`).join(', ') }]
  const picked = pickPromptBlocks(blocks, { maxChars: 120 })
  assert.equal(picked.picked, 1)
  assert.equal(picked.partial, true)
  assert.ok(picked.text.length <= 120, `超预算了：${picked.text.length}`)
  // 收口落在完整 tag 上
  assert.match(picked.text.slice(-16), /, tag_\d+$/)
  assert.equal(picked.unpicked.length, 1)
})

test('pickPromptBlocks：短段不会因为「都提到 red eyes」把整段长 tag 判成重复', () => {
  const blocks = [
    { text: 'red eyes' },
    { text: 'red eyes, long hair, twin tails, school uniform, ribbon, pleated skirt, thighhighs' },
  ]
  const picked = pickPromptBlocks(blocks, { maxChars: 500 })
  assert.equal(picked.picked, 2)
  assert.equal(picked.unpicked.length, 0)
})

test('composeDocSection：多套服装走 tags 模式，单段 tag / 纯散文退回整段按边界收口', () => {
  // 多套服装：按「套」挑，一次只并一套（另一套不出现在结果里）
  const multi = composeDocSection([
    '这套 LoRA 用 Belle Anima v1 训的。',
    '',
    '## 提示词',
    'belle_anima_v1, school',
    'school_uniform, yellow necktie, pleated skirt',
    '',
    'belle_anima_v1, battle',
    'battle_uniform, combat boots, silver hair',
  ].join('\n'), { maxChars: 4000, prompt: '1girl, battle uniform' })
  assert.equal(multi.mode, 'tags')
  assert.match(multi.text, /battle_uniform/)
  assert.doesNotMatch(multi.text, /school_uniform/)
  assert.equal(multi.picked, 1)
  assert.equal(multi.outfit, 'battle')
  assert.equal(multi.how, 'name')

  // 单段 tag + 负面：没有可互斥的「套」，退回整段收口，负面照旧
  const single = composeDocSection([
    '这套 LoRA 用 Belle Anima v1 训的。',
    '',
    '## 提示词',
    '1girl, green eyes, pink hair, short hair',
    '',
    '负面：',
    'worst quality, low quality, bad anatomy',
  ].join('\n'), { maxChars: 4000 })
  assert.equal(single.mode, 'plain')
  assert.equal(single.text, '1girl, green eyes, pink hair, short hair')
  assert.equal(single.negative, 'worst quality, low quality, bad anatomy')
  assert.equal(single.truncated, false)
  assert.ok(single.negativeChars > 0)

  // 一个 tag 行都没有：退回整篇按边界收口（旧行为不能丢）
  const plain = composeDocSection('这是一篇没有 tag 的说明文字。'.repeat(50), { maxChars: 100 })
  assert.equal(plain.mode, 'plain')
  assert.equal(plain.negative, '')
  assert.equal(plain.truncated, true)
  assert.ok(plain.keptChars <= 100)
})

test('composeNegative：两段负面词合并去重，空的直接让位', () => {
  assert.equal(composeNegative('lowres, blurry', 'blurry, bad hands, BAD HANDS'), 'lowres, blurry, bad hands')
  // 用户自己填的负面词保持在前面
  assert.ok(composeNegative('my negative', 'doc negative').startsWith('my negative'))
  assert.equal(composeNegative('lowres', ''), 'lowres')
  assert.equal(composeNegative('', 'bad hands'), 'bad hands')
  assert.equal(composeNegative(undefined, undefined), '')
  // 文档负面词不该换行追加：重复的词会互相抵消
  assert.doesNotMatch(composeNegative('lowres', 'bad hands'), /\n/)
})

test('findNegativeNode：顺着 KSampler.negative 找 CLIPTextEncode，不靠节点序号猜', () => {
  const graph = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'a girl' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres' } },
    3: { class_type: 'KSampler', inputs: { positive: ['1', 0], negative: ['2', 0] } },
  }
  assert.equal(findNegativeNode(graph, '1'), '2')
  // 不跳过时也能找到（线上调用会传 positiveId，这里只验「跳过」生效）
  assert.equal(findNegativeNode(graph), '2')
  assert.equal(findNegativeNode(graph, '2'), null)
  // 没有 CLIPTextEncode / 空图 / 坏的 link
  assert.equal(findNegativeNode({}), null)
  assert.equal(findNegativeNode(undefined), null)
  assert.equal(findNegativeNode({ 3: { class_type: 'KSampler', inputs: { negative: ['9', 0] } } }), null)
})

// ── 角色别名：中文 / 日文 / 罗马音都对得上 LoRA 文件名 ──────────────────────
// 用户说的往往是中文（四季夏目），LoRA 文件名却是罗马音或编号（natsume-000016）。
// 对照表只能从已有证据里取 —— 文档标题行的「中文（日文 / 罗马音）」就是现成的。

test('docAliases：从标题行同时取出中文、日文、罗马音', () => {
  const { line, aliases } = docAliases([
    '========================================================================',
    '四季夏目（四季 ナツメ / Shiki Natsume）Anima LoRA 提示词清单',
    '版本：natsume-ani1.0',
  ].join('\n'))
  assert.match(line, /四季夏目/)
  for (const want of ['四季夏目', '四季 ナツメ', 'ナツメ', 'Shiki Natsume', 'Natsume']) {
    assert.ok(aliases.includes(want), `别名里缺「${want}」：${JSON.stringify(aliases)}`)
  }
  // 体裁词与版本号不该混进来
  for (const bad of ['Anima', 'LoRA', '提示词清单', 'natsume-ani1.0']) {
    assert.ok(!aliases.includes(bad), `别名里混进了「${bad}」`)
  }
  // 繁简两种写法在同一行里并排出现时都要收（不做繁简转换）
  const twins = docAliases('谷风天音（谷風天音 / Tanikaze Amane）Illustrious LoRA 提示词清单')
  assert.ok(twins.aliases.includes('谷风天音'))
  assert.ok(twins.aliases.includes('谷風天音'))
})

test('docAliases：一行说明 + 小节名的文档不会把小节名当角色名', () => {
  // `绝区零 铃.txt` 的真实结构：第 1 行英文说明，下面是 Base outfit / Summer Skies 这些服装小节
  const text = [
    'Use the identity token plus one outfit token, then the kit line for that outfit.',
    '',
    'Base outfit',
    'bellezzz, baseout, black shirt',
    '',
    'Summer Skies',
    'bellezzz, summerout, white shirt',
  ].join('\n')
  assert.deepEqual(docAliases(text).aliases, [])
})

test('normalizeAlias：空格 / 下划线 / 中点 / 全角都不影响比对', () => {
  assert.equal(normalizeAlias('Shiki Natsume'), normalizeAlias('shiki_natsume'))
  assert.equal(normalizeAlias('四季 ナツメ'), normalizeAlias('四季・ナツメ'))
  assert.equal(normalizeAlias('因幡　めぐる'), normalizeAlias('因幡めぐる'))
})

test('loraAliases + matchLoraForPrompt：中文 / 日文 / 罗马音都能挑中同一个 LoRA', () => {
  const docs = [
    {
      stem: '四季夏目_Anima_LoRA_提示词清单',
      raw: '========================================================================\n四季夏目（四季 ナツメ / Shiki Natsume）Anima LoRA 提示词清单\n',
      siblings: ['natsume_000016'],
    },
    {
      stem: '谷风天音__提示词清单',
      raw: '谷风天音（谷風天音 / Tanikaze Amane）Illustrious LoRA 提示词清单\n',
      siblings: ['tenshi_amane'],
    },
  ]
  const loras = ['natsume-000016.safetensors', 'tenshi_amane.safetensors', 'belle_anima_v1.safetensors']
  const natsume = loraAliases('natsume-000016.safetensors', docs)
  // 文件名只给「natsume」，中文/日文靠同目录文档补上
  assert.ok(natsume.aliases.includes('四季夏目'))
  assert.ok(natsume.aliases.includes('四季 ナツメ'))
  assert.ok(natsume.sources.docs.length > 0)

  for (const prompt of ['画个四季夏目', '四季 ナツメ を描いて', 'shiki natsume', 'NATSUME']) {
    const matched = matchLoraForPrompt(prompt, loras, docs)
    assert.equal(matched.pick, 'natsume-000016.safetensors', `「${prompt}」没挑中：${matched.reason}`)
    assert.equal(matched.candidates.length, 1)
  }
  // 同理，罗马音先行的文件名也能被中文 prompt 命中
  assert.equal(matchLoraForPrompt('画个谷风天音', loras, docs).pick, 'tenshi_amane.safetensors')
  assert.equal(matchLoraForPrompt('tanikaze amane', loras, docs).pick, 'tenshi_amane.safetensors')
})

test('matchLoraForPrompt：认不出就不挂，认出多个就列候选', () => {
  const docs = [
    { stem: '四季夏目', raw: '四季夏目（四季 ナツメ / Shiki Natsume）\n', siblings: ['natsume'] },
    { stem: '因幡巡', raw: '因幡巡（因幡 めぐる / Inaba Meguru）\n', siblings: ['meguru'] },
  ]
  const loras = ['natsume.safetensors', 'meguru.safetensors']
  // 泛称 / 服装词 / 空 prompt 都不能当成角色
  for (const prompt of ['画个美少女', 'summer outfit', '', 'a girl, solo, best quality']) {
    const matched = matchLoraForPrompt(prompt, loras, docs)
    assert.equal(matched.pick, '')
    assert.equal(matched.candidates.length, 0, `「${prompt}」误命中：${JSON.stringify(matched.candidates)}`)
    assert.match(matched.reason, /没在 prompt 里认出/)
  }
  // 同时点了两个角色 → 不替你猜
  const both = matchLoraForPrompt('画个四季夏目和因幡巡', loras, docs)
  assert.equal(both.pick, '')
  assert.equal(both.candidates.length, 2)
  assert.match(both.reason, /不替你猜/)
  // loras 为空时不抛错
  assert.equal(matchLoraForPrompt('四季夏目', [], docs).pick, '')
})

test('describeDrawConfig：把「模型 / LoRA 开关 / 文档目录」讲成模型能直接读的几句话', () => {
  const fixed = describeDrawConfig(
    { draw: { unet: 'anima-base-v1.0.safetensors', lora: true }, loraDocs: { dir: 'D:\\docs', maxChars: 4000 } },
    { diffusion_models: ['anima-base-v1.0.safetensors'], checkpoints: ['Illustrious-XL-v2.0.safetensors'], loras: ['a'] },
  ).join('\n')
  assert.match(fixed, /生图模型：anima-base-v1\.0\.safetensors/)
  // 用户已经选定了模型，就必须说清「传 unet 也不会覆盖」—— 否则模型会以为能自己换
  assert.match(fixed, /不会覆盖/)
  assert.match(fixed, /LoRA：允许挂/)
  assert.match(fixed, /字数预算 4000/)

  const auto = describeDrawConfig(
    { draw: { unet: '', lora: false }, loraDocs: { dir: '', maxChars: 4000 } },
    { diffusion_models: ['anima-base-v1.0.safetensors'], checkpoints: [], loras: [] },
  ).join('\n')
  assert.match(auto, /生图模型：自动/)
  assert.match(auto, /LoRA：已关/)
  assert.match(auto, /没配目录/)

  // 一个模型都没有时要说清「先装模型」，别让模型去猜
  assert.match(describeDrawConfig({ draw: { unet: '', lora: true }, loraDocs: { dir: '', maxChars: 4000 } }, {}).join('\n'), /先装模型/)
})
