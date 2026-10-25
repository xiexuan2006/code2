import { BaseAgent } from '../core/agent.js'
import { analyze, metricsOf, passedOf, scoreOf } from '../rules/review-rules.js'

/**
 * ReviewAgent：对当前代码做静态审查，给出问题列表、分数与是否通过的判定。
 *
 * config.mode:
 *  - all    ：全部规则（主流程使用）
 *  - logic  ：只关注 high/medium 逻辑问题（并行演示分支）
 *  - style  ：只关注 low 风格问题（并行演示分支）
 * config.persist: 是否写入共享状态（并行分支不写，避免互相覆盖）
 */
export class ReviewerAgent extends BaseAgent {
  constructor(options) {
    super(options)
    this.mode = options.mode ?? 'all'
    this.persist = options.persist ?? true
  }

  async handle(ctx) {
    // 演示错误恢复：reviewer 首次执行时主动抛出一次异常，由引擎重试
    if (ctx.injectFault?.(this.id)) {
      throw new Error('模拟审查服务超时（用于演示重试与错误恢复）')
    }

    const state = ctx.state
    const issues = analyze(state.code, this.mode)
    const score = scoreOf(issues)
    const passed = passedOf(issues)
    const blocking = issues.filter((i) => i.severity !== 'low').length
    // 扩展：附带代码度量，报告中可看到规模变化
    const metrics = metricsOf(state.code)

    if (!this.persist) {
      this.sendMessage({
        to: 'engine',
        type: 'review.parallel',
        round: state.reviewRound,
        payload: { mode: this.mode, score, passed, blocking, metrics, issues: brief(issues) },
      })
      return { mode: this.mode, score, passed, blocking, metrics, issues }
    }

    state.reviewRound += 1
    const review = {
      round: state.reviewRound,
      mode: this.mode,
      passed,
      score,
      blocking,
      metrics,
      issues,
    }
    state.review = review

    this.sendMessage({
      to: passed ? 'reporter' : 'fixer',
      type: passed ? 'review.passed' : 'review.rejected',
      round: state.reviewRound,
      payload: { score, passed, blocking, issues: brief(issues) },
    })

    return review
  }
}

function brief(issues) {
  return issues.map(({ id, ruleId, severity, line, title }) => ({ id, ruleId, severity, line, title }))
}
