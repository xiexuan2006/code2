/**
 * 消息总线：Agent 之间以及 Agent 与引擎之间传递结构化消息。
 * 每条消息都会被记录，用于执行日志、UI 消息流与复盘。
 */
export class MessageBus {
  constructor({ onMessage } = {}) {
    this.history = []
    this.onMessage = onMessage
  }

  send({ from, to, type, payload = {}, round = 0, correlationId = null }) {
    const message = {
      id: `msg-${String(this.history.length + 1).padStart(3, '0')}`,
      from,
      to,
      type,
      round,
      correlationId,
      payload,
      timestamp: new Date().toISOString(),
    }
    this.history.push(message)
    this.onMessage?.(message)
    return message
  }
}
