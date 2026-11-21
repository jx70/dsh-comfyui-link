/**
 * format-adapter.test.mjs —— 格式适配层（lib/format-adapter.mjs）的单测
 * ============================================================================
 * 覆盖：
 *   · API/UI 双格式识别；空图/坏结构报错
 *   · UI 结构提取：id/type/title/links/widget 名/widgets_values 原样
 *   · 误映射回归：widget 顺序与 widgets_values 不一致时，绝不绑定 name→value
 *   · 六类诊断：重复节点 ID / 重复 Link ID / 输出槽越界 / 三向对账不一致 /
 *     类型不匹配 / 缺关键输入；跨 scope 同号 id 不误报
 *   · 子图识别：边界、节点数、端口、实例节点；内部节点不进顶层参数
 * ============================================================================
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { detectFormat, parseWorkflow, uiStructureToApi } from '../lib/format-adapter.mjs'
import { inspectWorkflow } from '../lib/inspector.mjs'
import { buildTxt2Img } from '../lib/comfy.mjs'

const MODELS = { unet: 'u.safetensors', clip: 'c.safetensors', vae: 'v.safetensors' }

function clone(value) { return JSON.parse(JSON.stringify(value)) }

function codesOf(parsed) { return parsed.diagnostics.map((d) => d.code) }

/** 一份干净的 UI 图：一个源节点连到一个汇节点 */
function cleanUi() {
  return {
    nodes: [
      {
        id: 1, type: 'FooSource', title: '源',
        inputs: [],
        outputs: [{ name: 'OUT', type: 'IMAGE', links: [10] }],
        widgets_values: ['a', 'b'],
      },
      {
        id: 2, type: 'BarSink', title: '汇',
        inputs: [{ name: 'in', type: 'IMAGE', link: 10 }],
        outputs: [],
        widgets_values: ['x'],
      },
    ],
    links: [[10, 1, 0, 2, 0, 'IMAGE']],
  }
}

test('detectFormat 认得 API / UI 两种形状，其他报错', () => {
  assert.equal(detectFormat(buildTxt2Img({ ...MODELS, prompt: 'x' })), 'api')
  assert.equal(detectFormat(cleanUi()), 'ui')
  assert.throws(() => detectFormat({}), /识别不了|工作流/)
  assert.throws(() => detectFormat([]), /必须是 JSON 对象/)
})

test('API 图解析：透传 class_type，无 warning / 无 unresolved / 无诊断', () => {
  const graph = buildTxt2Img({ ...MODELS, prompt: 'a cat' })
  const parsed = parseWorkflow(graph)
  assert.equal(parsed.format, 'api')
  assert.equal(parsed.graph['1'].class_type, 'UNETLoader') // 三件套输入 → 扩散模型加载器
  const promptNode = Object.values(parsed.graph).find((n) => n.class_type === 'CLIPTextEncode')
  assert.equal(promptNode.inputs.text, 'a cat')
  assert.deepEqual(parsed.warnings, [])
  assert.deepEqual(parsed.diagnostics, [])
  assert.deepEqual(parsed.unresolved, [])
  assert.equal(inspectWorkflow(parsed.graph).editable.some((e) => e.value === 'a cat'), true)
})

test('UI 结构提取：id / type / title / link / widget 名 / widgets_values 原样', () => {
  const parsed = parseWorkflow(cleanUi())
  assert.equal(parsed.format, 'ui')
  assert.equal(parsed.graph['2'].class_type, 'BarSink')
  assert.deepEqual(parsed.graph['2'].inputs.in, ['1', 0]) // 连线可靠，转成 [from, slot]
  assert.equal(parsed.graph['2']._meta.title, '汇')
  assert.equal(codesOf(parsed).length, 0, `干净 UI 图不该有诊断：${JSON.stringify(parsed.diagnostics)}`)
  const u = parsed.unresolved.find((x) => x.nodeId === '1')
  assert.deepEqual(u.widgetsValues, ['a', 'b'])
})

test('误映射回归：widget 名与 widgets_values 顺序不一致时，不绑定 name→value', () => {
  const ui = cleanUi()
  ui.nodes[0].type = 'CLIPLoader'
  ui.nodes[0].inputs = [
    { name: 'unet_name', type: 'COMBO', widget: { name: 'unet_name' }, link: null },
    { name: 'clip_name', type: 'COMBO', widget: { name: 'clip_name' }, link: null },
    { name: 'vae_name', type: 'COMBO', widget: { name: 'vae_name' }, link: null },
  ]
  ui.nodes[0].widgets_values = ['qwen_3_4b.safetensors', 'lumina2', 'default']
  ui.links = []
  ui.nodes[0].outputs = [{ name: 'CLIP', type: 'CLIP', links: [] }]
  ui.nodes[1].inputs = []

  const parsed = parseWorkflow(ui)
  const result = inspectWorkflow(parsed.graph)
  // 关键：任何 editable 都不能把这些原始 widgets_values 当成具名参数值
  const values = result.editable.map((e) => e.value)
  for (const raw of ['qwen_3_4b.safetensors', 'lumina2', 'default']) {
    assert.ok(!values.includes(raw), `不该把 widget 值 ${raw} 绑到参数上`)
  }
  const u = parsed.unresolved.find((x) => x.nodeId === '1')
  assert.deepEqual(u.params, ['unet_name', 'clip_name', 'vae_name'])
  assert.deepEqual(u.widgetsValues, ['qwen_3_4b.safetensors', 'lumina2', 'default'])
  assert.match(parsed.warnings.join('\n'), /Save \(API Format\)/)
})

test('诊断：同一 scope 重复节点 ID / 重复 Link ID', () => {
  const ui = cleanUi()
  ui.nodes.push(clone(ui.nodes[0])) // 重复 id 1
  let parsed = parseWorkflow(ui)
  assert.ok(codesOf(parsed).includes('DUPLICATE_NODE_ID'))

  ui.nodes.pop()
  ui.links.push([10, 1, 0, 2, 0, 'IMAGE']) // 重复 link id 10
  parsed = parseWorkflow(ui)
  assert.ok(codesOf(parsed).includes('DUPLICATE_LINK_ID'))
})

test('诊断：输出槽位越界', () => {
  const ui = cleanUi()
  ui.links = [[10, 1, 3, 2, 0, 'IMAGE']] // 源只有 1 个输出，引用槽 3
  const parsed = parseWorkflow(ui)
  assert.ok(codesOf(parsed).includes('OUTPUT_SLOT_OUT_OF_RANGE'))
})

test('诊断：输入侧与 links 表不一致（双向）', () => {
  // 输入侧记着 link 99，但表里只有 10
  const ui = cleanUi()
  ui.nodes[1].inputs[0].link = 99
  let parsed = parseWorkflow(ui)
  assert.ok(codesOf(parsed).includes('LINK_TABLE_MISMATCH'))
  const messages = parsed.diagnostics
    .filter((d) => d.code === 'LINK_TABLE_MISMATCH')
    .map((d) => d.message).join('\n')
  assert.match(messages, /links 表里没有/) // 输入侧记着 99 但表里没有（另一个方向是表里 10 指向该输入但 link 不符）

  // 反向：outputs[].links 记着 77，表里没有
  const ui2 = cleanUi()
  ui2.nodes[0].outputs[0].links = [10, 77]
  parsed = parseWorkflow(ui2)
  assert.ok(codesOf(parsed).includes('LINK_TABLE_MISMATCH'))
})

test('诊断：类型不匹配（link 声明与节点 slot 类型不同）', () => {
  const ui = cleanUi()
  ui.links = [[10, 1, 0, 2, 0, 'MASK']] // 源/汇 slot 都是 IMAGE，但 link 声明 MASK
  const parsed = parseWorkflow(ui)
  assert.ok(codesOf(parsed).includes('TYPE_MISMATCH'))
})

test('诊断：缺少关键输入（按 class_type 的必需输入表）', () => {
  const ui = cleanUi()
  ui.nodes[1].type = 'KSampler'
  ui.nodes[1].inputs = [{ name: 'in', type: 'IMAGE', link: 10 }] // 缺 seed/steps/cfg/... 
  const parsed = parseWorkflow(ui)
  const missing = parsed.diagnostics.filter((d) => d.code === 'MISSING_REQUIRED_INPUT')
  assert.ok(missing.length >= 4, `缺关键输入诊断太少：${missing.length}`)
  assert.ok(missing.some((d) => d.message.includes('seed')))
})

test('诊断：跨 scope 同号节点 ID 不误报（top 与子图各算一域）', () => {
  const ui = cleanUi()
  ui.nodes[0].type = 'sub-xyz'
  ui.definitions = {
    subgraphs: [{
      id: 'sub-xyz', name: 'Sub', nodes: [{ id: 1, type: 'FooSource', inputs: [], outputs: [], widgets_values: [] }],
      links: [], inputs: [], outputs: [], inputNode: {}, outputNode: {},
    }],
  }
  const parsed = parseWorkflow(ui)
  const dup = parsed.diagnostics.filter((d) => d.code === 'DUPLICATE_NODE_ID')
  assert.equal(dup.length, 0, `跨 scope 不该报重复：${JSON.stringify(dup)}`)
})

test('子图识别：边界 / 节点数 / 端口 / 实例节点；内部节点不进顶层参数', () => {
  const ui = {
    nodes: [
      { id: 85, type: 'sub-123', title: '子图实例', inputs: [], outputs: [], widgets_values: [] },
    ],
    links: [],
    definitions: {
      subgraphs: [{
        id: 'sub-123', name: 'My Sub',
        nodes: [
          {
            id: 1, type: 'CLIPLoader',
            inputs: [
              { name: 'clip_name', type: 'COMBO', widget: { name: 'clip_name' }, link: null },
              { name: 'type', type: 'COMBO', widget: { name: 'type' }, link: null },
              { name: 'device', type: 'COMBO', widget: { name: 'device' }, link: null },
            ],
            outputs: [{ name: 'CLIP', type: 'CLIP', links: [] }],
            widgets_values: ['qwen.safetensors', 'lumina2', 'default'],
          },
          { id: 2, type: 'Foo', inputs: [], outputs: [], widgets_values: [] },
        ],
        links: [],
        inputs: [
          { name: 'image', type: 'IMAGE', label: 'control_image', linkIds: [65, 80] },
          { name: 'text', type: 'STRING', linkIds: [81] },
        ],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', linkIds: [45] }],
        inputNode: { bounding: [-500, 620, 120, 180] },
        outputNode: { bounding: [1390, 1100, 120, 60] },
      }],
    },
  }
  const parsed = parseWorkflow(ui)
  assert.equal(parsed.subgraphs.length, 1)
  const sub = parsed.subgraphs[0]
  assert.equal(sub.name, 'My Sub')
  assert.equal(sub.nodeCount, 2)
  assert.equal(sub.linkCount, 0)
  assert.deepEqual(sub.inputs.map((p) => p.name), ['image', 'text'])
  assert.deepEqual(sub.outputs.map((p) => p.name), ['IMAGE'])
  assert.deepEqual(sub.instances, ['85'])
  assert.deepEqual(sub.bounds.input, [-500, 620, 120, 180])
  assert.match(parsed.warnings.join('\n'), /子图/)

  const result = inspectWorkflow(parsed.graph)
  // 顶层只有实例节点，子图内部的 CLIPLoader 参数没有混进来
  assert.equal(result.editable.length, 0)
})

test('子图内部对象格式 links + IO 边界锚点（-10/-20）不误报', () => {
  // 真实 ComfyUI 子图：links 是对象数组 {id, origin_id, origin_slot, target_id, target_slot, type}
  //（顶层则是数组元组）；连到 inputNode/outputNode 虚拟锚点（常见 -10/-20）的 link 是合法的
  // 子图外部输入输出，不是断链。两种都要正常对账，不能刷「非标准行 / 指向不存在的节点」。
  const ui = {
    nodes: [{ id: 85, type: 'sub-obj', inputs: [], outputs: [], widgets_values: [] }],
    links: [],
    definitions: {
      subgraphs: [{
        id: 'sub-obj', name: 'ObjectLinks',
        nodes: [
          { id: 1, type: 'FooSource', inputs: [], outputs: [{ name: 'OUT', type: 'IMAGE', links: [10, 11] }], widgets_values: [] },
          {
            id: 2, type: 'BarSink',
            inputs: [
              { name: 'in', type: 'IMAGE', link: 10 },
              { name: 'from_io', type: 'IMAGE', link: 12 },
            ],
            outputs: [], widgets_values: [],
          },
        ],
        links: [
          { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'IMAGE' },
          { id: 11, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' }, // → outputNode
          { id: 12, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 1, type: 'IMAGE' }, // inputNode →
        ],
        inputs: [{ name: 'enc', type: 'IMAGE', linkIds: [12] }],
        outputs: [{ name: 'IMG', type: 'IMAGE', linkIds: [11] }],
        inputNode: { id: -10, bounding: [-500, 620, 120, 180] },
        outputNode: { id: -20, bounding: [1390, 1100, 120, 60] },
      }],
    },
  }
  const parsed = parseWorkflow(ui)
  const nonStandard = parsed.diagnostics.filter((d) => /非标准行/.test(d.message))
  assert.equal(nonStandard.length, 0, `对象格式 link 不该报非标准行：${JSON.stringify(nonStandard)}`)
  assert.ok(parsed.diagnostics.every((d) => d.code !== 'LINK_TABLE_MISMATCH'),
    `对象格式 link 与 IO 锚点三处一致，不该有对账错误：${JSON.stringify(parsed.diagnostics)}`)
  assert.equal(codesOf(parsed).length, 0, `干净子图不该有任何诊断：${JSON.stringify(parsed.diagnostics)}`)
})

test('uiStructureToApi 不修改原图（只读）', () => {
  const ui = cleanUi()
  const before = JSON.stringify(ui)
  const parsed = parseWorkflow(ui)
  uiStructureToApi(parsed)
  assert.equal(JSON.stringify(ui), before)
})

test('空 UI 图 / 坏结构报错', () => {
  assert.throws(() => parseWorkflow({ nodes: [], links: [] }), /没有节点/)
  assert.throws(() => parseWorkflow(42), /必须是 JSON 对象/)
})
