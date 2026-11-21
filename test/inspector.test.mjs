/**
 * inspector.test.mjs —— 语义分析核心（lib/inspector.mjs）的单测
 * ============================================================================
 * 覆盖：
 *   · 只喂 API 图：classifyNode / buildEdges / findEditable / describeInspection
 *   · 连线：正常建边、断链、输出槽越界、类型不匹配、缺关键输入
 *   · 架构断言：核心源码不认识 UI 序列化字段（widgets_values / WIDGET_ORDER）
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  CATEGORY, buildEdges, classifyNode, describeInspection, findEditable,
  inspectWorkflow, isApiGraph,
} from '../lib/inspector.mjs'
import { buildTxt2Img } from '../lib/comfy.mjs'

const MODELS = { unet: 'u.safetensors', clip: 'c.safetensors', vae: 'v.safetensors' }

test('classifyNode 认识关键类型，未知归 other', () => {
  assert.equal(classifyNode('CheckpointLoaderSimple'), CATEGORY.CHECKPOINT)
  assert.equal(classifyNode('LoraLoader'), CATEGORY.LORA)
  assert.equal(classifyNode('KSampler'), CATEGORY.SAMPLER)
  assert.equal(classifyNode('CLIPTextEncode'), CATEGORY.PROMPT)
  assert.equal(classifyNode('EmptyLatentImage'), CATEGORY.LATENT_SIZE)
  assert.equal(classifyNode('ControlNetApplyAdvanced'), CATEGORY.CONTROLNET)
  assert.equal(classifyNode('SaveImage'), CATEGORY.OUTPUT)
  assert.equal(classifyNode('SomeRandomCustomNode'), CATEGORY.OTHER)
  assert.equal(classifyNode(''), CATEGORY.OTHER)
})

test('isApiGraph 只认 { id: { class_type, inputs:{} } }，拒绝 UI 形状', () => {
  assert.equal(isApiGraph({ 1: { class_type: 'A', inputs: {} } }), true)
  assert.equal(isApiGraph({}), false)
  assert.equal(isApiGraph({ nodes: [], links: [] }), false)
  assert.equal(isApiGraph({ 1: { class_type: 'A', inputs: [] } }), false)
})

test('buildTxt2Img 的图：8 条连线、无断链、诊断只来自 KSampler 之外的正常值', () => {
  const graph = buildTxt2Img({ ...MODELS, prompt: 'a cat', negative: 'blurry' })
  const { edges, dangling, diagnostics } = buildEdges(graph)
  assert.equal(dangling.length, 0)
  assert.ok(edges.length >= 7, `连线太少：${edges.length}`)
  const codes = diagnostics.map((d) => d.code)
  assert.ok(!codes.includes('DANGLING_LINK'))
  assert.ok(!codes.includes('TYPE_MISMATCH'))
  assert.ok(!codes.includes('OUTPUT_SLOT_OUT_OF_RANGE'))
})

test('buildEdges 检出断链、输出槽越界、类型不匹配、缺关键输入', () => {
  const graph = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['99', 0] } }, // 断链
    2: { class_type: 'KSampler', inputs: { model: ['1', 5], positive: ['1', 0], negative: ['1', 0], latent_image: ['1', 0] } }, // 槽越界 + 类型不匹配 + 缺 steps/cfg/sampler/scheduler/seed
  }
  const { edges, dangling, diagnostics } = buildEdges(graph)
  const codes = diagnostics.map((d) => d.code)
  assert.equal(dangling.length, 1)
  assert.equal(dangling[0].from, '99')
  assert.ok(codes.includes('DANGLING_LINK'))
  assert.ok(codes.includes('OUTPUT_SLOT_OUT_OF_RANGE'), codes.join(',')) // CLIPTextEncode 只有 1 个输出，引用槽 5
  assert.ok(codes.includes('TYPE_MISMATCH')) // CLIPTextEncode 输出 CONDITIONING 接到 model(期望 MODEL)
  assert.ok(codes.includes('MISSING_REQUIRED_INPUT'))
})

test('findEditable 只列具名标量，跳过连线与对象值，全部标 exact', () => {
  const graph = {
    1: { class_type: 'KSampler', inputs: { seed: 42, steps: 30, cfg: 4.9, model: ['2', 0], extra: { a: 1 } } },
    2: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
  }
  const editable = findEditable(graph)
  const byParam = Object.fromEntries(editable.map((e) => [e.nodeId + '.' + e.param, e]))
  assert.deepEqual(Object.keys(byParam).sort(), ['1.cfg', '1.seed', '1.steps', '2.ckpt_name'])
  assert.ok(Object.values(editable).every((e) => e.confidence === 'exact'))
  assert.equal(byParam['1.seed'].value, 42)
  assert.equal(byParam['1.seed'].kind, 'number')
})

test('inspectWorkflow 汇总关键节点 + 合并 adapter 透传的诊断；describeInspection 出四栏', () => {
  const graph = buildTxt2Img({ ...MODELS, prompt: 'a cat' })
  const injected = [{ code: 'DUPLICATE_LINK_ID', severity: 'error', scope: 'top', message: '重复 link 7' }]
  const result = inspectWorkflow(graph, { diagnostics: injected })
  assert.ok(result.keyNodes.length >= 5)
  assert.equal(result.diagnostics[0].code, 'DUPLICATE_LINK_ID')
  const text = describeInspection(result)
  for (const title of ['关键节点', '连接关系', '可改参数', '诊断']) {
    assert.match(text, new RegExp(title))
  }
  assert.match(text, /DUPLICATE_LINK_ID/)
})

test('架构断言：核心 inspector 不认识 UI 序列化概念', () => {
  const here = fileURLToPath(import.meta.url)
  const source = readFileSync(here.replace(/test[\\/]inspector\.test\.mjs$/, 'lib/inspector.mjs'), 'utf8')
  assert.ok(!source.includes('widgets_values'), '核心不该出现 widgets_values')
  assert.ok(!source.includes('WIDGET_ORDER'), '核心不该出现 widget 顺序表')
  assert.ok(!/\bdefinitions\s*\.\s*subgraphs/.test(source), '核心不该解析子图定义')
})
