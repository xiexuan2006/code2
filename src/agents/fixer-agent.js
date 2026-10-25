import { BaseAgent } from '../core/agent.js'
import { applyFixes, pickFixTarget } from '../rules/review-rules.js'

/**
 * FixAgent：读取 ReviewAgent 的问题列表，按严重级别分批自动修复，产出新版本代码。
 * 每次只处理一个严重级别（先 high 再 medium），从而形成「审查 → 修复 → 再审查」的循环。
 */
export class FixerAgent extends BaseAgent {
  async handle(ctx) {
    const state = ctx.state
    const issues = state.review?.issues ?? []
    const target = pickFixTarget(issues)

    // 无论是否真的改动了代码，都记一次修复轮次，保证循环有明确上界
    state.fixRounds += 1

    if (!target) {
      this.sendMessage({
        to: 'reviewer',
        type: 'code.unchanged',
        round: state.reviewRound,
        payload: { reason: '没有可自动修复的 high/medium 问题', version: state.versions.length },
      })
      return { targetSeverity: null, fixed: [], version: state.versions.length }
    }

    const { code, fixed } = applyFixes(state.code, issues, target)
    const version = state.versions.length + 1
    state.code = code
    state.versions.push({
      version,
      author: this.id,
      note: `修复 ${target} 级问题：${fixed.map((item) => item.title).join('、') || '无变更'}`,
      code,
    })

    this.sendMessage({
      to: 'reviewer',
      type: 'code.revised',
      round: state.reviewRound,
      payload: {
        version,
        targetSeverity: target,
        fixed: fixed.map(({ ruleId, line, title }) => ({ ruleId, line, title })),
      },
    })

    return { targetSeverity: target, fixed, version }
  }
}
