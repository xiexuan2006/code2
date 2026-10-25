/**
 * 扩展能力：运行历史统计。
 *
 * 作业要求里只有「执行日志与状态追踪」，这里把它再往前推一步，
 * 让日志变成可观察指标：通过率、平均轮次、规则命中排行、工作流分布。
 */
import { RUNS_DIR } from './run.js'
import { RunStore } from './core/logger.js'

const RULE_TITLES = {
  OFF_BY_ONE: '循环边界可能越界',
  LOOSE_EQUAL: '使用了宽松相等比较',
  VAR_USAGE: '使用了 var 声明',
  CONSOLE_LOG: '代码中直接输出调试日志',
  EVAL_USAGE: '使用了 eval 动态执行字符串',
  HARDCODED_SECRET: '疑似硬编码凭据',
  INNER_HTML: '直接赋值 innerHTML',
}

export function summarize(records) {
  const total = records.length
  const passed = records.filter((record) => record.result?.passed).length
  const failed = records.filter((record) => record.status === 'failed').length
  const withResult = records.filter((record) => typeof record.result?.finalScore === 'number')

  const ruleCount = new Map()
  for (const record of records) {
    // 每轮审查的问题都统计，用于观察「最常出现的缺陷」
    for (const event of record.events ?? []) {
      if (event.type !== 'node.end' || event.nodeId !== 'review') continue
      for (const issue of event.output?.issues ?? []) {
        ruleCount.set(issue.ruleId, (ruleCount.get(issue.ruleId) ?? 0) + 1)
      }
    }
  }

  const byWorkflow = new Map()
  for (const record of records) {
    const name = record.workflow?.name ?? 'unknown'
    byWorkflow.set(name, (byWorkflow.get(name) ?? 0) + 1)
  }

  const average = (values) =>
    values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : 0

  return {
    total,
    passed,
    failed,
    passRate: total ? Math.round((passed / total) * 1000) / 10 : 0,
    avgScore: average(withResult.map((record) => record.result.finalScore)),
    avgReviewRounds: average(records.map((record) => record.result?.reviewRounds ?? 0)),
    avgFixRounds: average(records.map((record) => record.result?.fixRounds ?? 0)),
    avgDurationMs: average(records.map((record) => record.durationMs ?? 0)),
    totalMessages: records.reduce((sum, record) => sum + (record.messages?.length ?? 0), 0),
    byWorkflow: [...byWorkflow]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    rules: [...ruleCount]
      .map(([ruleId, count]) => ({ ruleId, count, title: RULE_TITLES[ruleId] ?? ruleId }))
      .sort((a, b) => b.count - a.count),
    latest: records
      .slice(-8)
      .reverse()
      .map((record) => ({
        runId: record.runId,
        workflow: record.workflow?.name ?? 'unknown',
        passed: record.result?.passed ?? null,
        score: record.result?.finalScore ?? null,
        startedAt: record.startedAt,
        durationMs: record.durationMs ?? null,
      })),
  }
}

export function loadStats() {
  const store = new RunStore({ root: RUNS_DIR })
  return summarize(store.readAll())
}
