/**
 * 共享状态：所有 Agent 通过同一个 state 对象读写上下文，实现「状态共享」。
 * 字段会在运行过程中被不同 Agent 更新，快照用于日志、UI 展示与复盘。
 */
export function createState(initial = {}) {
  return {
    status: 'running',
    input: {
      requirement: '',
      language: 'javascript',
      code: '',
    },
    /** 当前版本代码（审查/修复的对象） */
    code: '',
    /** 代码版本历史：{ version, author, note, code } */
    versions: [],
    /** 最近一次审查结果：{ round, passed, score, issues } */
    review: null,
    /** 审查轮次（ReviewAgent 每执行一次 +1） */
    reviewRound: 0,
    /** 修复轮次（FixAgent 每执行一次 +1） */
    fixRounds: 0,
    /** 最大修复轮次，达到后强制进入汇总 */
    maxRounds: 3,
    /** 每个节点的输出，key = nodeId */
    outputs: {},
    /** 最终结果 */
    result: null,
    ...initial,
  }
}

/** 深拷贝快照，避免日志/UI 引用被后续修改 */
export function snapshot(state) {
  return JSON.parse(JSON.stringify(state))
}
