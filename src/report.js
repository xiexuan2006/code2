/**
 * 扩展能力：把一次运行导出为 Markdown 审查报告。
 *
 * 报告覆盖：结论 → 轮次轨迹 → 遗留问题 → 代码差异 → 消息链路 → 代码度量。
 * 目的：让「Agent 协作过程」不仅存在于终端和网页里，也能进入评审文档 / 邮件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNS_DIR } from './run.js'
import { RunStore } from './core/logger.js'
import { toUnifiedDiff } from './core/diff.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPORTS_DIR = path.join(ROOT, 'reports')

const severityZh = { high: '高', medium: '中', low: '低' }

export function buildReport(record) {
  const result = record.result ?? {}
  const state = record.state ?? {}
  const versions = state.versions ?? []
  const finalCode = state.code ?? versions.at(-1)?.code ?? ''
  const firstCode = versions[0]?.code ?? ''
  const rounds = collectRounds(record.events ?? [])
  const lines = []

  lines.push(`# 代码审查报告 · ${record.workflow?.title ?? 'Code Review Workflow'}`)
  lines.push('')
  lines.push(`> 由 Code Review Workflow 自动生成（CodingAgent → ReviewAgent → FixAgent 协作）`)
  lines.push('')
  lines.push('## 1. 运行概要')
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('| --- | --- |')
  lines.push(`| 运行 ID | \`${record.runId}\` |`)
  lines.push(`| 工作流 | ${record.workflow?.title ?? '—'}（\`${record.workflow?.name ?? '—'}\`） |`)
  lines.push(`| 开始时间 | ${record.startedAt ?? '—'} |`)
  lines.push(`| 耗时 | ${record.durationMs ?? '—'} ms |`)
  lines.push(`| 需求 | ${escapeCell(record.input?.requirement ?? '—')} |`)
  lines.push(`| 代码来源 | ${record.input?.code ? '外部输入' : 'CodingAgent 生成'} |`)
  lines.push(`| 审查 / 修复轮次 | ${result.reviewRounds ?? '—'} / ${result.fixRounds ?? '—'} |`)
  lines.push(`| 最终得分 | ${result.finalScore ?? '—'} |`)
  lines.push(`| 判定 | ${result.passed ? '✅ 通过' : '❌ 未通过'} |`)
  lines.push(`| 代码版本 | ${versions.length} 个（v1 → v${versions.length}） |`)
  lines.push('')
  lines.push(`**结论**：${result.summary ?? '—'}`)
  lines.push('')

  lines.push('## 2. 审查 / 修复轨迹')
  lines.push('')
  if (rounds.length) {
    lines.push('| # | 阶段 | 结果 | 说明 |')
    lines.push('| --- | --- | --- | --- |')
    rounds.forEach((round, index) => {
      lines.push(`| ${index + 1} | ${round.stage} | ${round.verdict} | ${escapeCell(round.detail)} |`)
    })
  } else {
    lines.push('_本次运行没有产生审查节点记录。_')
  }
  lines.push('')

  const remaining = result.remainingIssues ?? []
  lines.push('## 3. 遗留问题')
  lines.push('')
  if (remaining.length) {
    lines.push('| 行号 | 级别 | 规则 | 问题 |')
    lines.push('| --- | --- | --- | --- |')
    for (const issue of remaining) {
      lines.push(`| L${issue.line} | ${severityZh[issue.severity] ?? issue.severity} | \`${issue.ruleId}\` | ${escapeCell(issue.title)} |`)
    }
    lines.push('')
    lines.push('> 以上问题未在自动修复轮次内解决，需要人工介入。')
  } else {
    lines.push('无：最终审查未发现 high / medium 级别问题。')
  }
  lines.push('')

  lines.push('## 4. 代码差异（v1 → 最终版本）')
  lines.push('')
  if (firstCode && finalCode && firstCode !== finalCode) {
    const { text, stats } = toUnifiedDiff(firstCode, finalCode, {
      oldLabel: 'v1',
      newLabel: `v${versions.at(-1)?.version ?? versions.length}`,
    })
    lines.push(`新增 ${stats.add} 行，删除 ${stats.remove} 行。`)
    lines.push('')
    lines.push('```diff')
    lines.push(text)
    lines.push('```')
  } else if (firstCode === finalCode) {
    lines.push('代码在本次运行中没有发生变化。')
  } else {
    lines.push('_缺少可比对的代码版本。_')
  }
  lines.push('')

  lines.push('## 5. Agent 消息链路')
  lines.push('')
  const messages = record.messages ?? []
  if (messages.length) {
    lines.push('| # | 轮次 | 发送方 | 接收方 | 类型 | 摘要 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    messages.forEach((message, index) => {
      lines.push(
        `| ${index + 1} | R${message.round ?? 0} | ${message.from} | ${message.to} | \`${message.type}\` | ${escapeCell(summaryOf(message))} |`,
      )
    })
  } else {
    lines.push('_没有记录到 Agent 消息。_')
  }
  lines.push('')

  const metrics = state.review?.metrics
  lines.push('## 6. 代码度量（最终版本）')
  lines.push('')
  if (metrics) {
    lines.push('| 指标 | 数值 |')
    lines.push('| --- | --- |')
    lines.push(`| 总行数 | ${metrics.totalLines} |`)
    lines.push(`| 有效代码行 | ${metrics.codeLines} |`)
    lines.push(`| 注释行 | ${metrics.commentLines} |`)
    lines.push(`| 最长行 | ${metrics.maxLineLength} 字符 |`)
    lines.push(`| 函数 / 分支 | ${metrics.functions} / ${metrics.branches} |`)
  } else {
    lines.push('_本次运行没有记录度量信息。_')
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`生成时间：${new Date().toISOString()}`)

  return lines.join('\n')
}

function collectRounds(events) {
  const rounds = []
  for (const event of events) {
    if (event.type !== 'node.end') continue
    const output = event.output ?? {}

    if (event.nodeId === 'review') {
      rounds.push({
        stage: `ReviewAgent · 第 ${output.round ?? '?'} 轮`,
        verdict: output.passed ? '✅ 通过' : '❌ 未通过',
        detail: `得分 ${output.score}，high ${count(output.issues, 'high')} / medium ${count(output.issues, 'medium')} / low ${count(output.issues, 'low')}`,
      })
    } else if (event.nodeId === 'fix') {
      const fixed = output.fixed ?? []
      rounds.push({
        stage: 'FixAgent',
        verdict: output.version ? `v${output.version}` : '无变更',
        detail: fixed.length ? fixed.map((item) => `L${item.line} ${item.title}`).join('；') : output.reason ?? '没有可自动修复项',
      })
    }
  }
  return rounds
}

function count(issues, severity) {
  return (issues ?? []).filter((issue) => issue.severity === severity).length
}

function summaryOf(message) {
  const payload = message.payload ?? {}
  switch (message.type) {
    case 'code.submitted':
      return `v${payload.version}，${payload.lines} 行`
    case 'review.rejected':
      return `得分 ${payload.score}，${payload.issues?.length ?? 0} 个问题`
    case 'review.passed':
      return `得分 ${payload.score}，审查通过`
    case 'review.parallel':
      return `${payload.mode} 分支，得分 ${payload.score}`
    case 'code.revised':
      return `v${payload.version}，修复 ${payload.fixed?.length ?? 0} 个 ${payload.targetSeverity} 问题`
    case 'code.unchanged':
      return payload.reason ?? '代码无变更'
    default:
      return Object.keys(payload).length ? JSON.stringify(payload) : ''
  }
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** 写入 reports/<runId>.md，返回文件路径 */
export function writeReport(runId) {
  const store = new RunStore({ root: RUNS_DIR })
  const record = runId ? store.read(runId) : store.readAll().at(-1)
  if (!record) throw new Error('没有可导出的运行记录，请先运行一次工作流')

  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  const file = path.join(REPORTS_DIR, `${record.runId}.md`)
  fs.writeFileSync(file, buildReport(record), 'utf8')
  return file
}
