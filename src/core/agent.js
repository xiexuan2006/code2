/**
 * Agent 基类：统一 process() 契约，子类只需实现 handle()。
 * - ctx: 引擎上下文（共享状态、消息总线、LLM、故障注入等）
 * - envelope: 引擎投递的任务消息
 */
export class BaseAgent {
  constructor({ id, label, description = '', bus, llm }) {
    this.id = id
    this.label = label
    this.description = description
    this.bus = bus
    this.llm = llm
  }

  async process(ctx, envelope) {
    return this.handle(ctx, envelope)
  }

  /* eslint-disable-next-line no-unused-vars */
  async handle(ctx, envelope) {
    throw new Error(`Agent ${this.id} 未实现 handle()`)
  }

  /** 向其他 Agent（或引擎）发送消息 */
  sendMessage(message) {
    return this.bus.send({ from: this.id, ...message })
  }
}
