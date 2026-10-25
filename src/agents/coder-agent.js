import { readFile } from 'node:fs/promises'
import { BaseAgent } from '../core/agent.js'

const BUGGY_TEMPLATE_URL = new URL('../samples/buggy-user-service.js', import.meta.url)

/**
 * CodingAgent：根据需求生成初始代码；若用户提供了代码，则直接接收并纳入版本管理。
 * 生成的模板故意保留了若干典型问题，用于演示后续审查与修复闭环。
 */
export class CoderAgent extends BaseAgent {
  async handle(ctx) {
    const state = ctx.state

    if (state.input.code && state.input.code.trim()) {
      state.code = state.input.code
      const version = 1
      state.versions.push({
        version,
        author: this.id,
        note: '接收外部输入代码',
        code: state.code,
      })
      this.sendMessage({
        to: 'reviewer',
        type: 'code.submitted',
        round: 0,
        payload: { version, source: 'input', lines: countLines(state.code) },
      })
      return { version, source: 'input', lines: countLines(state.code) }
    }

    const code = await this.generate(ctx)
    state.code = code
    const version = 1
    state.versions.push({ version, author: this.id, note: '根据需求生成初始实现', code })
    this.sendMessage({
      to: 'reviewer',
      type: 'code.submitted',
      round: 0,
      payload: { version, source: 'generated', lines: countLines(code) },
    })

    return { version, source: 'generated', lines: countLines(code) }
  }

  async generate(ctx) {
    const { requirement, language } = ctx.state.input
    const template = await readFile(BUGGY_TEMPLATE_URL, 'utf8')

    if (ctx.llm.mode === 'openai') {
      const text = await ctx.llm.complete({
        system: `你是资深 ${language} 工程师。根据需求实现代码，只输出代码，不要解释。`,
        user: requirement,
        maxTokens: 900,
        fallback: '',
      })
      const code = stripCodeFence(text)
      if (/function\s+\w+/.test(code)) return code
    }

    return `// 需求：${requirement}\n// 由 CodingAgent 生成的初始实现（MVP 演示模板）\n\n${template}`
  }
}

function stripCodeFence(text) {
  const match = String(text ?? '').match(/```(?:js|javascript|ts|typescript)?\n([\s\S]*?)```/)
  return (match ? match[1] : text).trim()
}

function countLines(code) {
  return String(code ?? '').split(/\r?\n/).length
}
