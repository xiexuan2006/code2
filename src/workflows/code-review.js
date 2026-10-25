/**
 * 主流程：代码审查 Workflow
 *
 * intake（初始化）
 *   → code（CodingAgent 生成/接收代码）
 *   → review（ReviewAgent 审查）
 *       ├─ 通过 ─────────────→ report
 *       ├─ 未通过且未达上限 ─→ fix（FixAgent 修复）
 *       └─ 未通过但达到上限 ─→ report（转人工）
 *   fix → review（循环再审查）
 */

export const DEFAULT_REQUIREMENT =
  '实现一个用户查询服务：根据 id 在用户数组中查找并返回用户名 name，同时提供一个记录用户信息的日志方法。'

export const codeReviewWorkflow = {
  name: 'code-review',
  title: '编码 → 审查 → 修复',
  description: '三个 Agent 顺序协作，审查不通过时进入修复并循环复审，直到通过或达到修复上限。',
  entry: 'intake',
  agents: [
    { id: 'coder', label: 'CodingAgent', role: '根据需求生成初始代码，或接收外部输入代码' },
    { id: 'reviewer', label: 'ReviewAgent', role: '静态审查代码，输出问题列表、得分与通过判定' },
    { id: 'fixer', label: 'FixAgent', role: '按严重级别自动修复问题，产出新版本代码' },
  ],
  edges: [
    { from: 'intake', to: 'code' },
    { from: 'code', to: 'review' },
    { from: 'review', to: 'fix', label: '未通过' },
    { from: 'review', to: 'report', label: '通过 / 达到修复上限' },
    { from: 'fix', to: 'review', label: '循环复审' },
    { from: 'report', to: 'END' },
  ],
  nodes: {
    intake: {
      type: 'function',
      label: '初始化上下文',
      run: async (ctx) => {
        const state = ctx.state
        state.input.requirement = (state.input.requirement || DEFAULT_REQUIREMENT).trim()
        const rounds = Number(state.maxRounds)
        state.maxRounds = Number.isFinite(rounds) ? Math.min(Math.max(rounds, 1), 5) : 3
        return { requirement: state.input.requirement, maxRounds: state.maxRounds }
      },
      next: 'code',
    },

    code: {
      type: 'agent',
      agent: 'coder',
      label: '编码 Agent',
      retry: { attempts: 2 },
      next: 'review',
    },

    review: {
      type: 'agent',
      agent: 'reviewer',
      label: '审查 Agent',
      retry: { attempts: 2 },
      maxVisits: 6,
      overflow: 'report',
      next: (ctx) => {
        const state = ctx.state
        if (state.review?.passed) return 'report'
        if (state.fixRounds >= state.maxRounds) return 'report'
        return 'fix'
      },
      routeLabel: (ctx) => {
        const state = ctx.state
        if (state.review?.passed) return `审查通过 · 得分 ${state.review.score}`
        if (state.fixRounds >= state.maxRounds) return `达到修复上限 ${state.maxRounds} 轮，转人工`
        return '未通过 · 进入修复'
      },
    },

    fix: {
      type: 'agent',
      agent: 'fixer',
      label: '修复 Agent',
      retry: { attempts: 2 },
      maxVisits: 5,
      overflow: 'report',
      next: 'review',
      routeLabel: (ctx) => `循环回到审查 · 第 ${ctx.state.reviewRound + 1} 轮`,
    },

    report: {
      type: 'function',
      label: '汇总报告',
      run: async (ctx) => {
        const state = ctx.state
        const review = state.review ?? { passed: false, score: 0, issues: [] }
        const remaining = review.issues.filter((issue) => issue.severity !== 'low')
        const facts = `是否通过：${review.passed ? '通过' : '未通过'}；审查 ${state.reviewRound} 轮，修复 ${state.fixRounds} 轮；最终得分 ${review.score}；剩余 high/medium 问题 ${remaining.length} 个。`

        const summary = await ctx.llm.complete({
          system: '你是代码审查工作流的总结助手，用中文给出不超过两句话的结论与下一步建议。',
          user: facts,
          fallback: review.passed
            ? `第 ${state.reviewRound} 轮审查通过（得分 ${review.score}），仍有 ${review.issues.length} 个低优先级风格建议可后续处理。`
            : `${state.fixRounds} 轮修复后仍未通过（得分 ${review.score}），剩余 ${remaining.length} 个问题需人工介入。`,
        })

        state.result = {
          passed: review.passed,
          reviewRounds: state.reviewRound,
          fixRounds: state.fixRounds,
          finalScore: review.score,
          finalVersion: state.versions.at(-1)?.version ?? 0,
          remainingIssues: remaining.map(({ severity, line, title }) => ({ severity, line, title })),
          summary,
        }
        return state.result
      },
      next: 'END',
    },
  },
}
