import fs from 'node:fs'
import path from 'node:path'

/**
 * 运行日志存储：每次运行生成 runs/<runId>/ 目录
 *  - events.jsonl：逐条事件（实时写入，便于观察长流程）
 *  - run.json：完整运行记录（工作流、Agent、消息、状态、结果）
 */
export class RunStore {
  constructor({ root }) {
    this.root = root
  }

  runDir(runId) {
    return path.join(this.root, runId)
  }

  init(runId) {
    fs.mkdirSync(this.runDir(runId), { recursive: true })
    fs.writeFileSync(path.join(this.runDir(runId), 'events.jsonl'), '', 'utf8')
  }

  appendEvent(runId, event) {
    try {
      fs.appendFileSync(path.join(this.runDir(runId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 日志写入失败不应中断工作流
    }
  }

  saveRecord(runId, record) {
    fs.writeFileSync(path.join(this.runDir(runId), 'run.json'), JSON.stringify(record, null, 2), 'utf8')
  }

  read(runId) {
    const file = path.join(this.runDir(runId), 'run.json')
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  /** 扩展：读取全部历史运行记录（用于统计与报告批量导出） */
  readAll() {
    if (!fs.existsSync(this.root)) return []
    return fs
      .readdirSync(this.root)
      .filter((name) => fs.existsSync(path.join(this.runDir(name), 'run.json')))
      .map((runId) => {
        try {
          return this.read(runId)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  }

  list(limit = 20) {
    if (!fs.existsSync(this.root)) return []
    return fs
      .readdirSync(this.root)
      .filter((name) => fs.existsSync(path.join(this.runDir(name), 'run.json')))
      .map((runId) => {
        try {
          const record = this.read(runId)
          return {
            runId,
            status: record.status,
            workflow: record.workflow?.title ?? record.workflow?.name,
            startedAt: record.startedAt,
            durationMs: record.durationMs,
            passed: record.result?.passed ?? null,
          }
        } catch {
          return { runId, status: 'unknown' }
        }
      })
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit)
  }
}
