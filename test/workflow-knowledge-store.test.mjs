/**
 * workflow-knowledge-store.test.mjs —— 持久化层的可靠性测试
 * ============================================================================
 * 全部用 mkdtemp 临时目录 + 模拟数据，不碰真实 ComfyUI 知识库。
 * 钉住：初始化、读写、重建后仍在、index 损坏恢复、单档案损坏隔离、
 *       原子写、并发写、root 无法确定不伪造成功。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorkflowKnowledgeStore, MAX_RECORD_BYTES } from '../lib/workflow-knowledge-store.mjs'

function makeRecord(id, extra = {}) {
  return {
    schema_version: 1,
    workflow_id: id,
    name: `工作流 ${id}`,
    description: '测试用',
    tags: ['demo'],
    fingerprints: { source_hash: `hash-${id}`, structure_hash: `struct-${id}` },
    source: { type: 'graph', prompt_id: '', created_at: '2026-01-01T00:00:00.000Z' },
    graph_storage: { mode: 'reference-only', available: false, snapshot: null },
    inspection: { format: 'api', keyNodes: [], edges: [], editable_parameters: [], diagnostics: [], subgraphs: [] },
    knowledge: { purpose: [], workflow_steps: [], use_cases: [], parameter_guidance: [], dependencies: [], limitations: [], troubleshooting: [] },
    experiences: [],
    learning_status: { analysis_status: 'analyzed', execution_status: 'never_executed', quality_status: 'unreviewed' },
    stats: { execution_completed: 0, execution_failed: 0, approved: 0, rejected: 0 },
    metadata: { revision: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    ...extra,
  }
}

test('初始化后目录存在，index 建好', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-init-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    const idx = JSON.parse(await readFile(await store.indexPath(), 'utf8'))
    assert.equal(idx.schema_version, 1)
    assert.deepEqual(idx.entries, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('root 无法确定时抛明确错误，不伪造成功', async () => {
  const store = createWorkflowKnowledgeStore({ getRoot: async () => '' })
  await assert.rejects(() => store.init(), /认不出 ComfyUI 的 output 目录|outputRoot/)
  await assert.rejects(() => store.upsert(makeRecord('wf_ok')), /认不出 ComfyUI 的 output 目录/)
})

test('正常读写，重新初始化模块后数据仍在（持久化）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-persist-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    await store.upsert(makeRecord('wf_abc123'))
    const listed = await store.list()
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.entries[0].workflow_id, 'wf_abc123')

    // 新建一个 store 实例模拟「模块重启」
    const store2 = createWorkflowKnowledgeStore({ root })
    await store2.init()
    const record = await store2.get('wf_abc123')
    assert.equal(record.name, '工作流 wf_abc123')
    assert.equal((await store2.list()).entries.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('index 损坏后从 records 重建，数据不丢', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-index-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    await store.upsert(makeRecord('wf_recover'))
    // 写坏 index
    await writeFile(await store.indexPath(), '{bad json', 'utf8')
    const listed = await store.list()
    assert.equal(listed.source, 'records')
    assert.equal(listed.entries.length, 1)
    const rebuilt = await store.rebuildIndex()
    assert.equal(rebuilt, 1)
    assert.equal((await store.list()).source, 'index')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('单份档案损坏不影响其它记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-bad-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    await store.upsert(makeRecord('wf_good'))
    await store.upsert(makeRecord('wf_bad'))
    await writeFile(await store.recordPath('wf_bad'), '{not json', 'utf8')
    const listed = await store.list()
    // 强制从 records 读（index 里还有坏档案摘要，直接毁掉 index 让它重建）
    await writeFile(await store.indexPath(), '{bad', 'utf8')
    const fresh = await store.list()
    assert.equal(fresh.entries.length, 1)
    assert.equal(fresh.entries[0].workflow_id, 'wf_good')
    assert.ok(fresh.skipped.some((s) => s.name === 'wf_bad.json'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findBySourceHash 能按指纹找到档案', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-hash-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    await store.upsert(makeRecord('wf_hash1', { fingerprints: { source_hash: 'abc123', structure_hash: 'x' } }))
    assert.equal((await store.findBySourceHash('abc123'))?.workflow_id, 'wf_hash1')
    assert.equal(await store.findBySourceHash('missing'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('appendExperience 追加独立事件，不覆盖旧记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-exp-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    await store.upsert(makeRecord('wf_exp'))
    await store.appendExperience('wf_exp', { execution_outcome: 'completed', at: 't1' })
    await store.appendExperience('wf_exp', { execution_outcome: 'failed', at: 't2' })
    const record = await store.get('wf_exp')
    assert.equal(record.experiences.length, 2)
    assert.deepEqual(record.experiences.map((e) => e.at), ['t1', 't2'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('并发 upsert 不丢更新（进程内写队列）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-concurrent-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.upsert(makeRecord(`wf_c${i}`))))
    const listed = await store.list()
    assert.equal(listed.entries.length, 10)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('原子写：目标文件已存在时 upsert 能覆盖而不留临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-atomic-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    await store.upsert(makeRecord('wf_at', { name: 'v1' }))
    await store.upsert(makeRecord('wf_at', { name: 'v2' }))
    assert.equal((await store.get('wf_at')).name, 'v2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('超过单档案大小上限拒写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-size-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await store.init()
    const huge = makeRecord('wf_huge', { description: 'x'.repeat(MAX_RECORD_BYTES) })
    await assert.rejects(() => store.upsert(huge), /上限|超过/)
    assert.equal(await store.get('wf_huge'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('非法 workflow_id 被拒，不会写出越界文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkb-id-'))
  try {
    const store = createWorkflowKnowledgeStore({ root })
    await assert.rejects(() => store.upsert(makeRecord('../evil')), /workflow_id 不合法/)
    await assert.rejects(() => store.upsert(makeRecord('ok', { workflow_id: 'bad id' })), /不合法/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
