#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DEFAULT_REQUIREMENT, RUNS_DIR, runWorkflow } from './run.js'
import { RunStore } from './core/logger.js'
import { toUnifiedDiff } from './core/diff.js'
import { writeReport } from './report.js'
import { loadStats } from './analytics.js'

const COLOR_ENABLED = process.stdout.isTTY && !process.env.NO_COLOR
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
}

const paint = (text, color) => (COLOR_ENABLED ? `${C[color] ?? ''}${text}${C.reset}` : String(text))
const SEVERITY_COLOR = { high: 'red', medium: 'yellow', low: 'blue' }
const SEVERITY_LABEL = { high: 'high  ', medium: 'medium', low: 'low   ' }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    requirement: { type: 'string', short: 'r' },
    code: { type: 'string', short: 'c' },
    'max-rounds': { type: 'string' },
    llm: { type: 'string' },
    workflow: { type: 'string', short: 'w' },
    'fault-inject': { type: 'string' },
    'no-save': { type: 'boolean' },
    'print-code': { type: 'boolean' },
    diff: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const command = positionals[0] ?? 'run'

if (values.help || command === 'help') {
  printHelp()
  process.exit(0)
}

if (command === 'ui') {
  await import('./server.js')
} else if (command === 'runs') {
  printRuns()
} else if (command === 'report') {
  printReport(positionals[1])
} else if (command === 'stats') {
  printStats()
} else if (command === 'run') {
  await runCli()
} else {
  console.error(paint(`未知命令：${command}`, 'red'))
  printHelp()
  process.exit(1)
}

function printHelp() {
  console.log(`
${paint('Code Review Workflow', 'bold')} · 多 Agent 协作 MVP

用法：
  node src/cli.js run [选项]        运行工作流
  node src/cli.js runs              查看历史运行
  node src/cli.js report [runId]    导出 Markdown 审查报告（默认最近一次）
  node src/cli.js stats             查看历史运行统计
  node src/cli.js ui                启动可视化界面（http://localhost:3000）

选项：
  -r, --requirement <文本>   需求描述（不填则使用内置示例需求）
  -c, --code <文件路径>      直接审查外部代码文件（不填则由 CodingAgent 生成）
      --max-rounds <数字>    最大修复轮次，默认 3
      --llm <mock|openai>    LLM 模式，默认 mock（离线可运行）
  -w, --workflow <名称>      工作流：code-review（默认）| parallel-demo
      --fault-inject <名称>  注入一次故障演示重试（如 reviewer）
      --diff                 结束时打印 v1 → 最终版本的差异
      --no-save              不写入 runs/ 日志
      --print-code           结束时打印最终代码

示例：
  npm run demo
  npm run demo:buggy
  npm run demo:clean
  npm run demo:fault
  npm run demo:parallel
  npm run demo:security
  npm run report
  npm run stats
  node src/cli.js run -r "实现订单金额校验函数" --max-rounds 2 --print-code --diff
`)
}

async function runCli() {
  const codePath = values.code
  const code = codePath ? await readFile(path.resolve(process.cwd(), codePath), 'utf8') : ''
  const requirement = values.requirement || DEFAULT_REQUIREMENT
  const maxRounds = Number(values['max-rounds'] ?? 3)
  const workflow = values.workflow || 'code-review'
  const llm = values.llm || 'mock'

  printBanner({ workflow, llm, requirement, code: codePath ?? null, maxRounds })

  let issueHeaderPrinted = false
  const onEvent = (event) => {
    switch (event.type) {
      case 'run.init':
        console.log(`${paint('runId', 'gray')}  ${event.runId}`)
        console.log(`${paint('开始', 'gray')}   ${event.startedAt}`)
        console.log('')
        break

      case 'node.start':
        console.log(
          `${paint('▶', 'cyan')} ${paint(event.nodeId, 'bold')} ${paint(event.label ?? '', 'gray')} · 第 ${event.visit} 次执行`,
        )
        break

      case 'node.end':
        printNodeEnd(event)
        if (event.nodeId === 'review' && event.output && event.output.issues) {
          printIssues(event.output)
          issueHeaderPrinted = true
        }
        break

      case 'message':
        console.log(`  ${paint('⇢', 'magenta')} ${formatMessage(event.message)}`)
        break

      case 'route':
        console.log(
          `  ${paint('↳', 'gray')} 路由 ${event.from} → ${event.to}${event.reason ? `（${event.reason}）` : ''}`,
        )
        console.log('')
        break

      case 'node.retry':
        console.log(
          `  ${paint('⚠', 'yellow')} ${event.nodeId} 第 ${event.attempt}/${event.maxAttempts} 次尝试失败：${event.error}，准备重试`,
        )
        break

      case 'node.overflow':
        console.log(`  ${paint('⤵', 'yellow')} ${event.reason}，跳转 ${event.to}`)
        break

      case 'node.error':
        console.log(`  ${paint('✖', 'red')} ${event.nodeId} 执行失败：${event.error}`)
        break

      case 'run.error':
        console.log(`  ${paint('✖', 'red')} ${event.reason}`)
        break

      case 'run.end':
        printResult(event)
        break

      default:
        break
    }
  }

  const record = await runWorkflow({
    requirement,
    code,
    maxRounds,
    llm,
    workflow,
    faultInject: values['fault-inject'] || null,
    onEvent,
    save: !values['no-save'],
  })

  if (values['print-code'] || process.env.PRINT_CODE === '1') {
    console.log('')
    console.log(paint('最终代码', 'bold'))
    printCode(record.state.code)
  }

  if (values.diff) {
    printDiff(record)
  }

  if (issueHeaderPrinted) {
    const lowIssues = (record.state.review?.issues ?? []).filter((issue) => issue.severity === 'low')
    if (lowIssues.length) {
      console.log(paint(`\n另有 ${lowIssues.length} 个低优先级风格建议未自动修复。`, 'gray'))
    }
  }
}

function printBanner({ workflow, llm, requirement, code, maxRounds }) {
  console.log('')
  console.log(paint('╭──────────────────────────────────────────────────────╮', 'cyan'))
  console.log(paint('│', 'cyan') + paint('  Code Review Workflow · 多 Agent 协作 MVP            ', 'bold') + paint('│', 'cyan'))
  console.log(paint('╰──────────────────────────────────────────────────────╯', 'cyan'))
  console.log(`${paint('工作流', 'gray')}  ${workflow}`)
  console.log(`${paint('LLM', 'gray')}     ${llm}${llm === 'mock' ? '（离线确定性模式）' : ''}`)
  console.log(`${paint('需求', 'gray')}    ${requirement}`)
  console.log(`${paint('代码', 'gray')}    ${code ?? '由 CodingAgent 生成初始实现'}`)
  console.log(`${paint('上限', 'gray')}    最多修复 ${maxRounds} 轮`)
  console.log('')
}

function printNodeEnd(event) {
  const output = event.output ?? {}
  let detail = ''

  if (event.nodeId === 'code') {
    detail = `生成 v${output.version ?? 1} 代码（${output.lines ?? '?'} 行，${output.source === 'input' ? '外部输入' : '自动生成'}）`
  } else if (event.nodeId === 'review') {
    const level = { high: 0, medium: 0, low: 0 }
    for (const issue of output.issues ?? []) level[issue.severity] += 1
    detail = `${output.passed ? paint('通过', 'green') : paint('未通过', 'red')} · 得分 ${output.score} · 问题 ${output.issues?.length ?? 0} 个（high ${level.high} / medium ${level.medium} / low ${level.low}）`
  } else if (event.nodeId === 'fix') {
    if (!output.fixed?.length) {
      detail = '没有可自动修复的 high/medium 问题'
    } else {
      detail = `修复 ${output.fixed.length} 个 ${output.targetSeverity} 问题 → v${output.version}：${output.fixed
        .map((item) => item.title)
        .join('、')}`
    }
  } else if (event.nodeId === 'report') {
    detail = '已生成汇总报告'
  } else {
    detail = '节点完成'
  }

  const status = event.status === 'ok' ? paint('✔', 'green') : paint('✖', 'red')
  console.log(`  ${status} ${detail} ${paint(`(${event.durationMs}ms)`, 'gray')}`)
}

function printIssues(review) {
  const issues = review.issues ?? []
  if (!issues.length) return
  console.log('')
  console.log(`   ${paint('行号', 'gray')}  ${paint('级别', 'gray')}   ${paint('规则', 'gray')}                  说明`)
  for (const issue of issues) {
    const line = String(issue.line).padStart(4, ' ')
    const severity = paint(SEVERITY_LABEL[issue.severity], SEVERITY_COLOR[issue.severity])
    console.log(`   ${line}  ${severity}  ${issue.ruleId.padEnd(18, ' ')}  ${issue.title}`)
  }
}

function formatMessage(message) {
  const payload = message.payload ?? {}
  let summary = ''

  switch (message.type) {
    case 'code.submitted':
      summary = `v${payload.version} · ${payload.source === 'input' ? '外部输入' : 'CodingAgent 生成'} · ${payload.lines} 行`
      break
    case 'review.rejected':
      summary = `得分 ${payload.score} · ${payload.issues?.length ?? 0} 个问题未通过`
      break
    case 'review.passed':
      summary = `得分 ${payload.score} · 审查通过`
      break
    case 'review.parallel':
      summary = `${payload.mode} 分支 · 得分 ${payload.score} · ${payload.issues?.length ?? 0} 个问题`
      break
    case 'code.revised':
      summary = `v${payload.version} · 修复 ${payload.fixed?.length ?? 0} 个 ${payload.targetSeverity} 问题`
      break
    case 'code.unchanged':
      summary = payload.reason
      break
    default:
      summary = Object.keys(payload).length ? JSON.stringify(payload) : ''
  }

  const type = message.type.padEnd(18, ' ')
  return `${paint(message.from, 'cyan')} → ${paint(message.to, 'cyan')}  ${paint(type, 'gray')} ${summary}`
}

function printResult(event) {
  const state = event.state ?? {}
  const result = event.result ?? {}
  const ok = result.passed

  console.log('')
  console.log(paint('════════════════ Workflow 完成 ════════════════', ok ? 'green' : 'yellow'))
  console.log(`状态      ${event.status === 'completed' ? paint('完成', 'green') : paint('失败', 'red')}`)
  if (result.passed !== undefined) {
    console.log(`判定      ${ok ? paint('通过', 'green') : paint('未通过', 'yellow')}`)
  }
  if (result.finalScore !== undefined) {
    console.log(`得分      ${result.finalScore}`)
  }
  if (result.reviewRounds !== undefined) {
    console.log(`审查/修复 ${result.reviewRounds} 轮 / ${result.fixRounds} 轮`)
  }
  if (result.finalVersion !== undefined) {
    console.log(`最终版本  v${result.finalVersion}（共 ${state.versions?.length ?? 0} 个版本）`)
  }
  if (result.summary) {
    console.log(`摘要      ${result.summary}`)
  }
  if (Array.isArray(result.remainingIssues) && result.remainingIssues.length) {
    console.log(`待处理    ${result.remainingIssues.map((i) => `L${i.line} ${i.title}`).join('；')}`)
  }
  console.log('')
}

function printCode(code) {
  String(code ?? '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      console.log(`${paint(String(index + 1).padStart(3, ' '), 'gray')} │ ${line}`)
    })
  console.log('')
}

function printRuns() {
  const store = new RunStore({ root: RUNS_DIR })
  const runs = store.list(15)
  if (!runs.length) {
    console.log(paint('暂无历史运行记录，先执行 npm run demo。', 'gray'))
    return
  }
  console.log(paint('\n最近运行记录：', 'bold'))
  for (const run of runs) {
    const verdict =
      run.passed === null ? paint('—', 'gray') : run.passed ? paint('通过', 'green') : paint('未通过', 'yellow')
    console.log(`  ${run.runId}  ${String(run.workflow).padEnd(18, ' ')} ${verdict}  ${run.durationMs ?? '?'}ms`)
  }
  console.log('')
}

/* ---------------- 扩展命令：diff / report / stats ---------------- */

function printDiff(record) {
  const versions = record.state?.versions ?? []
  const first = versions[0]
  const last = versions.at(-1)
  if (!first || !last) {
    console.log(paint('\n没有可对比的代码版本。', 'gray'))
    return
  }

  const { text, stats } = toUnifiedDiff(first.code, last.code, {
    oldLabel: `v${first.version}·${first.author}`,
    newLabel: `v${last.version}·${last.author}`,
  })

  console.log('')
  console.log(paint('版本差异', 'bold') + paint(`  +${stats.add} / -${stats.remove}`, 'gray'))
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) console.log(paint(line, 'gray'))
    else if (line.startsWith('@@')) console.log(paint(line, 'cyan'))
    else if (line.startsWith('+')) console.log(paint(line, 'green'))
    else if (line.startsWith('-')) console.log(paint(line, 'red'))
    else console.log(line)
  }
  console.log('')
}

function printReport(runId) {
  try {
    const file = writeReport(runId)
    console.log('')
    console.log(`${paint('✔', 'green')} 报告已导出：${file}`)
    console.log('')
  } catch (err) {
    console.error(paint(`✖ ${err instanceof Error ? err.message : String(err)}`, 'red'))
    process.exit(1)
  }
}

function printStats() {
  const stats = loadStats()
  if (!stats.total) {
    console.log(paint('暂无历史运行记录，先执行 npm run demo。', 'gray'))
    return
  }

  console.log('')
  console.log(paint('运行统计', 'bold'))
  console.log(`  ${paint('运行总数', 'gray')}      ${stats.total}`)
  console.log(`  ${paint('通过 / 失败', 'gray')}   ${paint(String(stats.passed), 'green')} / ${paint(String(stats.failed), 'red')}`)
  console.log(`  ${paint('通过率', 'gray')}        ${stats.passRate}%`)
  console.log(`  ${paint('平均得分', 'gray')}      ${stats.avgScore}`)
  console.log(`  ${paint('平均审查 / 修复', 'gray')} ${stats.avgReviewRounds} / ${stats.avgFixRounds} 轮`)
  console.log(`  ${paint('平均耗时', 'gray')}      ${stats.avgDurationMs}ms`)
  console.log(`  ${paint('消息总数', 'gray')}      ${stats.totalMessages}`)

  if (stats.rules.length) {
    console.log('')
    console.log(paint('高频规则命中', 'bold'))
    for (const rule of stats.rules.slice(0, 6)) {
      console.log(`  ${String(rule.count).padStart(3, ' ')}  ${rule.ruleId.padEnd(18, ' ')} ${rule.title}`)
    }
  }

  console.log('')
  console.log(paint('最近运行', 'bold'))
  for (const run of stats.latest) {
    const verdict = run.passed === null ? paint('—', 'gray') : run.passed ? paint('通过', 'green') : paint('未通过', 'yellow')
    console.log(`  ${run.runId}  ${String(run.workflow).padEnd(14, ' ')} ${verdict}  得分 ${run.score ?? '—'}`)
  }
  console.log('')
}
