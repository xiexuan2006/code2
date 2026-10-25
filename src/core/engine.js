import { snapshot } from './state.js'

export const END = 'END'
const MAX_HOPS = 100

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轻量 Workflow 引擎。
 *
 * 支持的能力：
 *  - 顺序执行（next 指向下一个节点）
 *  - 条件分支（next 为函数，根据共享状态决定下一个节点）
 *  - 循环（节点回边 + 状态计数 + maxVisits 兜底保护）
 *  - 并行（type = 'parallel'，并发执行多个 Agent 分支）
 *  - 错误处理与恢复（retry.attempts 重试；onError = 'end' | 'continue'）
 *
 * 事件流（onEvent）用于 CLI 实时打印、SSE 推送和日志落盘。
 */
export class WorkflowEngine {
  constructor({ workflow, agents, bus, state, llm, onEvent, faultInject = null }) {
    this.workflow = workflow
    this.agents = agents
    this.bus = bus
    this.state = state
    this.llm = llm
    this.onEvent = onEvent
    this.faults = new Set(faultInject ? [faultInject] : [])
    this.visits = {}
    this.nodeRuns = []
    this.ctx = {
      state,
      bus,
      llm,
      engine: this,
      /** 故障注入：每个 Agent 最多失败一次，用于演示重试恢复 */
      injectFault: (agentId) => {
        if (!this.faults.has(agentId)) return false
        this.faults.delete(agentId)
        return true
      },
    }
  }

  emit(type, data = {}) {
    this.onEvent?.({ type, timestamp: new Date().toISOString(), ...data })
  }

  async run() {
    let currentId = this.workflow.entry
    let hops = 0

    this.emit('run.start', {
      workflow: { name: this.workflow.name, title: this.workflow.title },
      state: snapshot(this.state),
    })

    while (currentId && currentId !== END) {
      if (++hops > MAX_HOPS) {
        this.emit('run.error', { reason: `执行步数超过 ${MAX_HOPS}，已中止（可能存在死循环）` })
        this.state.status = 'failed'
        break
      }

      const node = this.workflow.nodes[currentId]
      if (!node) {
        this.emit('run.error', { reason: `未找到节点：${currentId}` })
        this.state.status = 'failed'
        break
      }

      // 循环保护：节点执行次数达到上限后走 overflow 出口
      if (node.maxVisits && (this.visits[currentId] ?? 0) >= node.maxVisits) {
        const to = node.overflow ?? END
        this.emit('node.overflow', {
          nodeId: currentId,
          reason: `节点 ${currentId} 已达最大执行次数 ${node.maxVisits}`,
          to,
        })
        currentId = to
        continue
      }
      this.visits[currentId] = (this.visits[currentId] ?? 0) + 1

      const startedAt = Date.now()
      this.emit('node.start', {
        nodeId: currentId,
        label: node.label,
        nodeType: node.type,
        visit: this.visits[currentId],
        round: this.state.reviewRound,
      })

      const result = await this.executeNode(node, currentId)
      const durationMs = Date.now() - startedAt

      this.nodeRuns.push({
        nodeId: currentId,
        label: node.label,
        agent: node.agent ?? null,
        status: result.ok ? 'ok' : 'error',
        attempts: result.attempts,
        durationMs,
        error: result.error ?? null,
      })

      this.emit('node.end', {
        nodeId: currentId,
        label: node.label,
        status: result.ok ? 'ok' : 'error',
        output: result.output,
        error: result.error,
        attempts: result.attempts,
        durationMs,
      })
      this.emit('state.update', { state: snapshot(this.state) })

      if (!result.ok && (node.onError ?? 'end') === 'end') {
        this.state.status = 'failed'
        this.state.result = { passed: false, failedAt: currentId, error: result.error }
        break
      }

      const nextId = this.resolveNext(node)
      this.emit('route', {
        from: currentId,
        to: nextId,
        reason: typeof node.routeLabel === 'function' ? node.routeLabel(this.ctx) : null,
      })
      currentId = nextId
    }

    if (this.state.status === 'running') this.state.status = 'completed'
    this.emit('run.end', {
      status: this.state.status,
      state: snapshot(this.state),
      result: this.state.result,
      nodeRuns: this.nodeRuns,
    })
    return this.state
  }

  resolveNext(node) {
    if (node.next == null) return END
    return typeof node.next === 'function' ? node.next(this.ctx) : node.next
  }

  /** 带重试的节点执行 */
  async executeNode(node, nodeId) {
    const maxAttempts = node.retry?.attempts ?? 1
    let lastError = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const output = await this.runOnce(node, nodeId)
        return { ok: true, output, attempts: attempt }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        this.emit('node.retry', { nodeId, attempt, maxAttempts, error: lastError })
        if (attempt < maxAttempts) await delay(150 * attempt)
      }
    }

    this.emit('node.error', { nodeId, error: lastError })
    return { ok: false, error: lastError, attempts: maxAttempts }
  }

  async runOnce(node, nodeId) {
    const buildEnvelope = (target, type, payload) => ({
      from: 'engine',
      to: target,
      type,
      round: this.state.reviewRound,
      payload,
    })

    if (node.type === 'agent') {
      const agent = this.agents[node.agent]
      if (!agent) throw new Error(`未注册 Agent：${node.agent}`)
      const payload = typeof node.input === 'function' ? node.input(this.ctx) : node.input ?? {}
      const output = await agent.process(this.ctx, buildEnvelope(agent.id, node.messageType ?? 'task', payload))
      this.state.outputs[nodeId] = output
      return output
    }

    if (node.type === 'function') {
      const output = await node.run(this.ctx)
      this.state.outputs[nodeId] = output
      return output
    }

    if (node.type === 'parallel') {
      const branches = node.branches ?? []
      const results = await Promise.all(
        branches.map(async (branch) => {
          const agent = this.agents[branch.agent]
          if (!agent) throw new Error(`未注册 Agent：${branch.agent}`)
          const startedAt = Date.now()
          this.emit('branch.start', { nodeId, branchId: branch.id, agent: branch.agent })
          try {
            const payload = typeof branch.input === 'function' ? branch.input(this.ctx) : {}
            const output = await agent.process(
              this.ctx,
              buildEnvelope(agent.id, branch.messageType ?? 'task', payload),
            )
            this.emit('branch.end', {
              nodeId,
              branchId: branch.id,
              agent: branch.agent,
              status: 'ok',
              durationMs: Date.now() - startedAt,
            })
            return { branchId: branch.id, ok: true, output }
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            this.emit('branch.end', {
              nodeId,
              branchId: branch.id,
              agent: branch.agent,
              status: 'error',
              error,
              durationMs: Date.now() - startedAt,
            })
            return { branchId: branch.id, ok: false, error }
          }
        }),
      )
      const output = { branches: results }
      this.state.outputs[nodeId] = output
      return output
    }

    throw new Error(`未知节点类型：${node.type}`)
  }
}
