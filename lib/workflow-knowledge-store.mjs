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
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const META_DIR = '_dsh_meta'
const KB_DIR = 'workflow-knowledge'
const INDEX_NAME = 'index.json'
const RECORDS_DIR = 'records'

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

  // 进程内写队列：所有写操作排成一条 Promise 链，避免并发丢更新。
  // 只在单进程内成立 —— 不冒充跨进程锁。
  let queue = Promise.resolve()
  const serialize = (task) => {
    const result = queue.then(task, task)
    queue = result.then(() => {}, () => {})
    return result
  }

  /** 原子写：临时文件写成功再 rename。返回实际写入的文件路径。 */
  async function atomicWrite(file, body) {
    const dir = join(file, '..')
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${INDEX_NAME}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
    await writeFile(tmp, body, 'utf8')
    try {
      await rename(tmp, file)
    } catch (error) {
      // Windows 上偶发目标占用：先删再移；仍失败就删除临时文件并抛出
      if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
        try { await unlink(file) } catch { /* 可能本来就不存在 */ }
        try {
          await rename(tmp, file)
        } catch (second) {
          try { await unlink(tmp) } catch { /* 忽略 */ }
          throw second
        }
      } else {
        try { await unlink(tmp) } catch { /* 忽略 */ }
        throw error
      }
    }
    return file
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
      return isPlainObject(record) && typeof record.workflow_id === 'string' ? record : null
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

  /** 列出全部档案摘要；可选 filter（keyword/tag/status）在 learning 层做，这里只给原始列表。 */
  async function list() {
    const index = await readIndex()
    if (index) return { entries: index.entries, source: 'index', skipped: [] }
    // index 坏了也要能列出东西：从 records 兜底，并报告跳过的坏档案
    const { records, skipped } = await readAllRecords()
    return { entries: records.map(summarize), source: 'records', skipped }
  }

  /** 读完整档案。 */
  async function get(workflowId) {
    return readRecord(workflowId)
  }

  /** 按 source_hash 找已学过的档案（去重用）。 */
  async function findBySourceHash(sourceHash) {
    const hash = asId(sourceHash)
    if (!hash) return null
    const { records } = await readAllRecords()
    for (const record of records) {
      if (asId(record?.fingerprints?.source_hash) === hash) return record
    }
    return null
  }

  /** upsert 一份档案，保持 index 与 records 一致。返回写入后的档案。 */
  async function upsert(record) {
    return serialize(async () => {
      if (!isPlainObject(record)) throw new Error('档案必须是对象')
      const id = asId(record.workflow_id)
      if (!WF_ID_RE.test(id)) throw new Error(`workflow_id 不合法：${id}`)
      const body = JSON.stringify(record, null, 2) + '\n'
      if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) {
        throw new Error(`档案 ${id} 超过 ${Math.round(MAX_RECORD_BYTES / 1024 / 1024)} MiB 上限，拒写`)
      }
      await atomicWrite(await recordPath(id), body)
      // index 与 records 一起更新：读现有 index（坏了就当空），upsert 这一条
      const index = await readIndex() ?? { entries: [] }
      const summary = summarize(record)
      const next = index.entries.filter((e) => asId(e?.workflow_id) !== id)
      next.push(summary)
      await writeIndex(next)
      return record
    })
  }

  /** 追加一条反馈事件；不覆盖旧记录，超出上限丢弃最旧的。 */
  async function appendExperience(workflowId, event) {
    return serialize(async () => {
      const id = asId(workflowId)
      if (!WF_ID_RE.test(id)) throw new Error(`workflow_id 不合法：${id}`)
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
      // 同步 index 里的 experience_count / 状态 / 更新时间
      const index = await readIndex() ?? { entries: [] }
      const summary = summarize(record)
      const next = index.entries.filter((e) => asId(e?.workflow_id) !== id)
      next.push(summary)
      await writeIndex(next)
      return record
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
    upsert,
    appendExperience,
    rebuildIndex,
    remove,
  }
}
