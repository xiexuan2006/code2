import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createState, snapshot } from './core/state.js'
import { MessageBus } from './core/message-bus.js'
import { WorkflowEngine } from './core/engine.js'
import { RunStore } from './core/logger.js'
import { createLLM } from './llm/index.js'
import { CoderAgent, FixerAgent, ReviewerAgent } from './agents/index.js'
import { workflows } from './workflows/index.js'
import { DEFAULT_REQUIREMENT } from './workflows/code-review.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RUNS_DIR = path.join(ROOT, 'runs')
export { DEFAULT_REQUIREMENT }

export function makeRunId() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${randomUUID().slice(0, 4)}`
}

export function workflowCatalog() {
  return Object.values(workflows).map((workflow) => ({
    name: workflow.name,
    title: workflow.title,
    description: workflow.description,
    entry: workflow.entry,
    agents: workflow.agents ?? [],
    edges: workflow.edges ?? [],
    nodes: Object.entries(workflow.nodes).map(([id, node]) => ({
      id,
      label: node.label,
      type: node.type,
      agent: node.agent ?? null,
      branches: node.branches?.map((branch) => ({ id: branch.id, agent: branch.agent })) ?? null,
      maxVisits: node.maxVisits ?? null,
    })),
  }))
}

function buildAgents({ bus, llm }) {
  return {
    coder: new CoderAgent({
      id: 'coder',
      label: 'CodingAgent',
      description: '根据需求生成初始代码，或接收外部输入代码',
      bus,
      llm,
    }),
    reviewer: new ReviewerAgent({
      id: 'reviewer',
      label: 'ReviewAgent',
      description: '静态审查代码并给出问题列表、得分与通过判定',
      bus,
      llm,
    }),
    fixer: new FixerAgent({
      id: 'fixer',
      label: 'FixAgent',
      description: '按严重级别自动修复问题，产出新版本代码',
      bus,
      llm,
    }),
    // 并行演示工作流使用独立实例，避免两个分支同时写共享状态
    'reviewer-logic': new ReviewerAgent({
      id: 'reviewer-logic',
      label: 'LogicReviewer',
      description: '并行分支：只审查 high/medium 逻辑问题',
      mode: 'logic',
      persist: false,
      bus,
      llm,
    }),
    'reviewer-style': new ReviewerAgent({
      id: 'reviewer-style',
      label: 'StyleReviewer',
      description: '并行分支：只审查 low 风格问题',
      mode: 'style',
      persist: false,
      bus,
      llm,
    }),
  }
}

/**
 * 运行一个工作流，返回完整运行记录。
 * onEvent 用于实时消费事件（CLI 打印 / SSE 推送），所有事件同时落盘。
 */
export async function runWorkflow(options = {}) {
  const {
    requirement = DEFAULT_REQUIREMENT,
    code = '',
    language = 'javascript',
    maxRounds = 3,
    llm: llmMode = 'mock',
    faultInject = null,
    workflow: workflowName = 'code-review',
    onEvent = () => {},
    save = true,
    runId = makeRunId(),
  } = options

  const workflow = workflows[workflowName]
  if (!workflow) throw new Error(`未知 Workflow：${workflowName}（可选 ${Object.keys(workflows).join(' | ')}）`)

  const llm = createLLM(llmMode)
  const store = new RunStore({ root: RUNS_DIR })
  const events = []
  const messages = []
  const meta = workflowCatalog().find((item) => item.name === workflowName)
  const state = createState({
    input: { requirement, language, code },
    maxRounds,
  })

  const emit = (event) => {
    events.push(event)
    onEvent(event)
    if (save) store.appendEvent(runId, event)
  }

  const bus = new MessageBus({
    onMessage: (message) => {
      messages.push(message)
      emit({ type: 'message', message })
    },
  })

  const agents = buildAgents({ bus, llm })
  const engine = new WorkflowEngine({
    workflow,
    agents,
    bus,
    state,
    llm,
    faultInject,
    onEvent: emit,
  })

  if (save) store.init(runId)

  const startedAt = new Date().toISOString()
  emit({
    type: 'run.init',
    runId,
    workflow: meta,
    input: state.input,
    maxRounds: state.maxRounds,
    llmMode: llm.mode,
    startedAt,
  })

  try {
    await engine.run()
  } catch (err) {
    state.status = 'failed'
    state.result = { passed: false, error: err instanceof Error ? err.message : String(err) }
    emit({ type: 'run.error', reason: state.result.error })
  }

  const finishedAt = new Date().toISOString()
  const record = {
    runId,
    workflow: meta,
    input: state.input,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    status: state.status,
    result: state.result,
    state: snapshot(state),
    events,
    messages,
    nodeRuns: engine.nodeRuns,
    llmMode: llm.mode,
  }

  if (save) store.saveRecord(runId, record)
  return record
}
