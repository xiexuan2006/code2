/**
 * 扩展示例：并行审查 Workflow
 * 说明同一套引擎与 Agent 可以拼装出不同拓扑：两个审查 Agent 并发执行，再汇总结果。
 * 运行：npm run demo:parallel
 */
import { DEFAULT_REQUIREMENT } from './code-review.js'

export const parallelDemoWorkflow = {
  name: 'parallel-demo',
  title: '并行双审 → 汇总',
  description: 'CodingAgent 产出代码后，逻辑审查与风格审查两个 Agent 并行执行，最后汇总两路结果。',
  entry: 'intake',
  agents: [
    { id: 'coder', label: 'CodingAgent', role: '生成初始代码' },
    { id: 'reviewer-logic', label: 'LogicReviewer', role: '并行分支：只审查 high/medium 逻辑问题' },
    { id: 'reviewer-style', label: 'StyleReviewer', role: '并行分支：只审查 low 风格问题' },
  ],
  edges: [
    { from: 'intake', to: 'code' },
    { from: 'code', to: 'fan-out' },
    { from: 'fan-out', to: 'reviewer-logic', label: '并行' },
    { from: 'fan-out', to: 'reviewer-style', label: '并行' },
    { from: 'fan-out', to: 'merge', label: '汇总' },
    { from: 'merge', to: 'report' },
    { from: 'report', to: 'END' },
  ],
  nodes: {
    intake: {
      type: 'function',
      label: '初始化上下文',
      run: async (ctx) => {
        ctx.state.input.requirement = (ctx.state.input.requirement || DEFAULT_REQUIREMENT).trim()
        return { requirement: ctx.state.input.requirement }
      },
      next: 'code',
    },

    code: {
      type: 'agent',
      agent: 'coder',
      label: '编码 Agent',
      retry: { attempts: 2 },
      next: 'fan-out',
    },

    'fan-out': {
      type: 'parallel',
      label: '并行双审',
      branches: [
        { id: 'logic', agent: 'reviewer-logic', messageType: 'review.requested' },
        { id: 'style', agent: 'reviewer-style', messageType: 'review.requested' },
      ],
      next: 'merge',
    },

    merge: {
      type: 'function',
      label: '合并双路结果',
      run: async (ctx) => {
        const branches = ctx.state.outputs['fan-out']?.branches ?? []
        const logic = branches.find((b) => b.branchId === 'logic')
        const style = branches.find((b) => b.branchId === 'style')
        const merged = {
          logic: logic?.ok ? logic.output : { error: logic?.error },
          style: style?.ok ? style.output : { error: style?.error },
        }
        ctx.state.parallel = merged
        return merged
      },
      next: 'report',
    },

    report: {
      type: 'function',
      label: '汇总报告',
      run: async (ctx) => {
        const state = ctx.state
        const logic = state.parallel?.logic ?? {}
        const style = state.parallel?.style ?? {}
        const logicCount = logic.issues?.length ?? 0
        const styleCount = style.issues?.length ?? 0

        state.result = {
          passed: Boolean(logic.passed),
          finalScore: logic.score ?? 0,
          logicIssues: logicCount,
          styleIssues: styleCount,
          summary: `并行审查完成：逻辑问题 ${logicCount} 个（得分 ${logic.score ?? 0}），风格建议 ${styleCount} 个；两条分支由引擎并发执行后合并。`,
        }
        return state.result
      },
      next: 'END',
    },
  },
}
