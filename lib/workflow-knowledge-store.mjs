/**
 * lib/workflow-knowledge-store.mjs —— comfy_learn 的持久化知识库
 * ============================================================================
 * 职责（Host 侧，零 @deepseek-ai/* 依赖）：
 *   createWorkflowKnowledgeStore({ getRoot }) —— 管理独立的工作流知识档案。
 *
 * 存储约定（与 workspace-store 的 prompt-index.jsonl 完全分开）：
 *   <ComfyUI output>/_dsh_meta/workflow-knowledge/
 *     ├── index.json                 目录（每个档案一条摘要，可重建）
 *     └── records/
 *         ├── wf_xxx.json            单份完整档案
 *         └── wf_yyy.json
 *
 * 立场：
 *   · root 必须能解析（复用 resolvedOutputRoot）；解析不到就明确报错，
 *     绝不在 process.cwd() 或插件源码目录造一个「假的知识库」冒充成功。
 *   · 单份档案损坏只跳过它，不影响整个知识库读取。
 *   · index 损坏 / 缺条目时，从 records 重建 index。
 *   · 写入原子化：临时文件写成功后 rename；Windows 目标占用时先删再移。
 *   · 进程内写入串行化（Promise 链），防并发更新丢失；不宣称跨进程锁。
 *   · 单档案大小、experiences 数量都设上限，长期跑不会无限膨胀。
 * ============================================================================
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { applyExperienceToStatus, normalizeRecord } from './learning.mjs'

const META_DIR = '_dsh_meta'
const KB_DIR = 'workflow-knowledge'
const INDEX_NAME = 'index.json'
const RECORDS_DIR = 'records'
const TMP_DIR = '.tmp'

/** 单份档案最大字节数（超过就拒写，保护磁盘与读取） */
export const MAX_RECORD_BYTES = 2 * 1024 * 1024
/** 档案里最多保留多少条独立反馈事件（超出丢弃最旧的） */
export const MAX_EXPERIENCES = 500
/** 稳定 workflow_id 的文件名白名单：只允许 wf_ + 小写字母数字下划线/短横 */
const WF_ID_RE = /^wf_[A-Za-z0-9_-]+$/

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asId = (v) => (v === undefined || v === null ? '' : String(v))

/** 摘要条目：index.json 里只放这些，读取列表时不必打开每个档案。 */
function summarize(record) {
  const meta = isPlainObject(record?.metadata) ? record.metadata : {}
  const fp = isPlainObject(record?.fingerprints) ? record.fingerprints : {}
  const src = isPlainObject(record?.source) ? record.source : {}
  const status = isPlainObject(record?.learning_status) ? record.learning_status : {}
  return {
    workflow_id: asId(record?.workflow_id),
    name: typeof record?.name === 'string' ? record.name : '',
    description: typeof record?.description === 'string' ? record.description : '',
    tags: Array.isArray(record?.tags) ? record.tags.filter((t) => typeof t === 'string') : [],
    source_hash: asId(fp.source_hash),
    structure_hash: asId(fp.structure_hash),
    source: {
      type: asId(src.type),
      prompt_id: asId(src.prompt_id),
      created_at: asId(src.created_at),
    },
    analysis_status: asId(status.analysis_status) || 'discovered',
    execution_status: asId(status.execution_status) || 'never_executed',
    quality_status: asId(status.quality_status) || 'unreviewed',
    experience_count: Array.isArray(record?.experiences) ? record.experiences.length : 0,
    created_at: asId(meta.created_at),
    updated_at: asId(meta.updated_at),
  }
}

/**
 * 创建知识库存储。root 可以是字符串，也可以是 async () => string
 * （输出根要问一次 ComfyUI /system_stats 才知道，apply() 里传异步 getter）。
 */
export function createWorkflowKnowledgeStore({ root = '', getRoot = null } = {}) {
  const rootValue = typeof root === 'string' ? root.trim() : ''
  const resolveRoot = async () => {
    if (typeof getRoot === 'function') {
      const r = await getRoot()
      return typeof r === 'string' ? r.trim() : ''
    }
    return rootValue
  }
  /** 返回知识库目录；解析不到根时抛错（调用方决定怎么对用户说）。 */
  const kbDir = async () => {
    const r = await resolveRoot()
    if (!r) throw new Error('认不出 ComfyUI 的 output 目录，知识库没法落盘。请在配置里设 outputRoot，或先让插件能解析 ComfyUI 输出目录。')
    return join(r, META_DIR, KB_DIR)
  }
  const indexPath = async () => join(await kbDir(), INDEX_NAME)
  const recordsDir = async () => join(await kbDir(), RECORDS_DIR)
  const recordPath = async (workflowId) => join(await recordsDir(), `${workflowId}.json`)

  // 进程内写队列（全局）：用于共享的 index.json 与目录级操作。
  // 只在单进程内成立 —— 不冒充跨进程锁。
  let queue = Promise.resolve()
  const serialize = (task) => {
    const result = queue.then(task, task)
    queue = result.then(() => {}, () => {})
    return result
  }
  // P1：按 workflow 分锁 —— 同一档案的读改写串行，不同档案可并行处理各自的记录。
  // index.json 是共享文件，仍走上面的全局 serialize 串行合并，避免丢更新。
  const workflowQueues = new Map()
  const serializeWorkflow = (id, task) => {
    const key = asId(id) || '_'
    const prev = workflowQueues.get(key) ?? Promise.resolve()
    const result = prev.then(task, task)
    workflowQueues.set(key, result.then(() => {}, () => {}))
    return result
  }
  /** 在全局锁里更新 index 中的一条摘要（读最新 → 改 → 写）。 */
  const updateIndexEntry = (summary) => serialize(async () => {
    const index = await readIndex() ?? { entries: [] }
    const id = asId(summary?.workflow_id)
    const next = index.entries.filter((e) => asId(e?.workflow_id) !== id)
    next.push(summary)
    await writeIndex(next)
  })

  /** 原子写：同目录临时文件 + flush + rename。Windows 目标占用用重试，不一上来删目标。 */
  async function atomicWrite(file, body) {
    const dir = join(file, '..')
    await mkdir(dir, { recursive: true })
    let handle = null
    let tmp = ''
    try {
      // 临时文件必须和目标同盘同目录，rename 才是原子；独立 .tmp 子目录避免被 readAllRecords 扫到。
      const tmpDir = join(dir, TMP_DIR)
      await mkdir(tmpDir, { recursive: true })
      tmp = join(tmpDir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`)
      handle = await open(tmp, 'wx', 0o600)
      await handle.writeFile(body, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      // Windows 上 rename 到已存在文件可能是 EPERM/EEXIST；短暂重试比「先删目标再移」安全得多。
      let lastError
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await rename(tmp, file)
          return file
        } catch (error) {
          lastError = error
          if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) break
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
        }
      }
      throw lastError
    } catch (error) {
      if (handle) { try { await handle.close() } catch { /* 忽略 */ } }
      if (tmp) { try { await unlink(tmp) } catch { /* 忽略 */ } }
      throw error
    }
  }

  /** 读单个档案；损坏 / 不存在返回 null，不抛。 */
  async function readRecord(workflowId) {
    const id = asId(workflowId)
    if (!WF_ID_RE.test(id)) return null
    let text
    try {
      text = await readFile(await recordPath(id), 'utf8')
    } catch {
      return null
    }
    try {
      const record = JSON.parse(text.replace(/^\uFEFF/, ''))
      if (!isPlainObject(record) || typeof record.workflow_id !== 'string') return null
      // P1：旧档案在读取时补齐新增字段，不改动磁盘原文（兼容旧知识记录）。
      return normalizeRecord(record)
    } catch {
      return null
    }
  }

  /** 遍历 records 目录，返回所有能解析的档案；坏档案记入 skipped。 */
  async function readAllRecords() {
    let names
    try {
      names = await readdir(await recordsDir())
    } catch (error) {
      if (error?.code === 'ENOENT') return { records: [], skipped: [] }
      throw error
    }
    const records = []
    const skipped = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!WF_ID_RE.test(id)) {
        skipped.push({ name, reason: '文件名不是合法的 workflow_id' })
        continue
      }
      const record = await readRecord(id)
      if (record) records.push(record)
      else skipped.push({ name, reason: '档案损坏或不是合法 JSON 对象' })
    }
    return { records, skipped }
  }

  /** 读 index.json；损坏 / 不存在返回 null。 */
  async function readIndex() {
    let text
    try {
      text = await readFile(await indexPath(), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      return null
    }
    try {
      const data = JSON.parse(text.replace(/^\uFEFF/, ''))
      if (!isPlainObject(data) || !Array.isArray(data.entries)) return null
      return data
    } catch {
      return null
    }
  }

  async function writeIndex(entries) {
    const body = JSON.stringify({
      schema_version: 1,
      updated_at: new Date().toISOString(),
      entries,
    }, null, 2) + '\n'
    await atomicWrite(await indexPath(), body)
  }

  /** 从 records 重建 index。返回重建后的条目数。 */
  async function rebuildIndex() {
    return serialize(async () => {
      const { records } = await readAllRecords()
      const entries = records.map(summarize)
      await writeIndex(entries)
      return entries.length
    })
  }

  /** 初始化：确保目录存在，index 不存在或损坏就重建。 */
  // rebuildIndex 的「不加锁」版本，仅供 init 在已持有队列锁时内部调用
  async function rebuildIndexUnsafe() {
    const { records } = await readAllRecords()
    await writeIndex(records.map(summarize))
  }

  async function init() {
    return serialize(async () => {
      await mkdir(await recordsDir(), { recursive: true })
      const index = await readIndex()
      if (!index) await rebuildIndexUnsafe()
      return { ok: true }
    })
  }

  /**
   * 列出全部档案摘要。P2：index 与 records 不一致时自动修复（写回 index），
   * 不再因为 index 能解析就盲信它；索引仍坏时从 records 兜底。
   */
  async function list() {
    const index = await readIndex()
    const { records, skipped } = await readAllRecords()
    if (index) {
      const expected = new Map(records.map((r) => [asId(r.workflow_id), summarize(r)]))
      const actual = new Map(index.entries.filter((e) => asId(e?.workflow_id)).map((e) => [asId(e.workflow_id), e]))
      let dirty = expected.size !== actual.size
      for (const [id, exp] of expected) {
        if (!actual.has(id) || JSON.stringify(actual.get(id)) !== JSON.stringify(exp)) { dirty = true; break }
      }
      if (!dirty) return { entries: index.entries, source: 'index', skipped }
      // 自动修复：以 records 为准重建，并把修复结果告诉调用方
      const entries = records.map(summarize)
      try {
        await serialize(() => writeIndex(entries))
        return { entries, source: 'repaired', skipped }
      } catch {
        return { entries, source: 'records', skipped }
      }
    }
    return { entries: records.map(summarize), source: 'records', skipped }
  }

  /** 读完整档案。 */
  async function get(workflowId) {
    return readRecord(workflowId)
  }

  /** 按 source_hash 找已学过的档案（兼容旧调用）。 */
  async function findBySourceHash(sourceHash) {
    const hash = asId(sourceHash)
    if (!hash) return null
    const { records } = await readAllRecords()
    for (const record of records) {
      if (asId(record?.fingerprints?.source_hash) === hash) return record
    }
    return null
  }

  /** P2：跨来源同图去重 —— 按 structure_hash 找。 */
  async function findByStructureHash(structureHash) {
    const hash = asId(structureHash)
    if (!hash) return null
    const { records } = await readAllRecords()
    for (const record of records) {
      if (asId(record?.fingerprints?.structure_hash) === hash) return record
    }
    return null
  }

  /** upsert 一份档案，保持 index 与 records 一致。返回写入后的档案。 */
  async function upsert(record) {
    if (!isPlainObject(record)) throw new Error('档案必须是对象')
    const id = asId(record.workflow_id)
    if (!WF_ID_RE.test(id)) throw new Error(`workflow_id 不合法：${id}`)
    return serializeWorkflow(id, async () => {
      const body = JSON.stringify(record, null, 2) + '\n'
      if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) {
        throw new Error(`档案 ${id} 超过 ${Math.round(MAX_RECORD_BYTES / 1024 / 1024)} MiB 上限，拒写`)
      }
      await atomicWrite(await recordPath(id), body)
      // 共享 index 在全局锁里读最新再改，避免并发 upsert 互相覆盖摘要。
      await updateIndexEntry(summarize(record))
      return record
    })
  }

  /** 追加一条反馈事件；不覆盖旧记录，超出上限丢弃最旧的。 */
  async function appendExperience(workflowId, event) {
    const id = asId(workflowId)
    if (!WF_ID_RE.test(id)) throw new Error(`workflow_id 不合法：${id}`)
    return serializeWorkflow(id, async () => {
      const record = await readRecord(id)
      if (!record) throw new Error(`找不到知识档案 ${id}`)
      if (!isPlainObject(event)) throw new Error('反馈事件必须是对象')
      const experiences = Array.isArray(record.experiences) ? record.experiences.slice() : []
      experiences.push({ ...event, at: event.at ?? new Date().toISOString() })
      while (experiences.length > MAX_EXPERIENCES) experiences.shift()
      record.experiences = experiences
      const body = JSON.stringify(record, null, 2) + '\n'
      if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) {
        throw new Error(`档案 ${id} 追加反馈后超过上限，拒写`)
      }
      await atomicWrite(await recordPath(id), body)
      // 同步 index 里的 experience_count / 状态 / 更新时间（全局锁读最新）
      await updateIndexEntry(summarize(record))
      return record
    })
  }

  /**
   * P1：feedback 原子事务 —— 在同一把锁内完成「状态/统计更新 + 事件追加」，
   * 不再由调用方分两次 upsert/appendExperience（那样会在中途失败时留下半成品）。
   * 同一 workflow 串行；其它 workflow 的写也共用同一把进程内队列（不宣称跨进程锁）。
   */
  async function recordFeedback(workflowId, event) {
    const id = asId(workflowId)
    if (!WF_ID_RE.test(id)) throw new Error(`workflow_id 不合法：${id}`)
    return serializeWorkflow(id, async () => {
      const record = await readRecord(id)
      if (!record) throw new Error(`找不到知识档案 ${id}`)
      if (!isPlainObject(event)) throw new Error('反馈事件必须是对象')
      const updated = applyExperienceToStatus(record, event)
      const experiences = Array.isArray(updated.experiences) ? updated.experiences.slice() : []
      experiences.push({ ...event, at: event.at ?? new Date().toISOString() })
      while (experiences.length > MAX_EXPERIENCES) experiences.shift()
      updated.experiences = experiences
      const body = JSON.stringify(updated, null, 2) + '\n'
      if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) {
        throw new Error(`档案 ${id} 追加反馈后超过上限，拒写`)
      }
      await atomicWrite(await recordPath(id), body)
      await updateIndexEntry(summarize(updated))
      return updated
    })
  }

  /**
   * 删除一条知识档案（ Records + index 一起）。仅在学习系统明确调用时使用，
   * 本插件的任何自动流程都不会调用它 —— 没有用户确认就不删。
   */
  async function remove(workflowId) {
    return serialize(async () => {
      const id = asId(workflowId)
      if (!WF_ID_RE.test(id)) throw new Error(`workflow_id 不合法：${id}`)
      try {
        await unlink(await recordPath(id))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const index = await readIndex() ?? { entries: [] }
      await writeIndex(index.entries.filter((e) => asId(e?.workflow_id) !== id))
      return true
    })
  }

  return {
    kbDir,
    indexPath,
    recordsDir,
    recordPath,
    init,
    list,
    get,
    findBySourceHash,
    findByStructureHash,
    upsert,
    appendExperience,
    recordFeedback,
    rebuildIndex,
    remove,
  }
}
