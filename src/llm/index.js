/**
 * LLM 适配层（可选）。
 *
 * mock：完全离线，返回调用方提供的 fallback 文本，保证流程可复现；
 * openai：调用任意 OpenAI 兼容的 /chat/completions 接口。
 *   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
 *   （也支持 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）
 */
class MockLLM {
  get mode() {
    return 'mock'
  }

  async complete({ fallback = '' }) {
    return fallback
  }
}

class OpenAILLM {
  constructor({ apiKey, baseUrl, model, timeoutMs = 30000 }) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.model = model
    this.timeoutMs = timeoutMs
  }

  get mode() {
    return 'openai'
  }

  async complete({ system = '', user = '', fallback = '', maxTokens = 1200 }) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`LLM 请求失败 ${response.status}: ${text.slice(0, 200)}`)
    }

    const data = await response.json()
    return data.choices?.[0]?.message?.content?.trim() || fallback
  }
}

export function createLLM(mode = 'mock') {
  if (mode === 'mock') return new MockLLM()

  if (mode === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY
    if (!apiKey) {
      throw new Error('未配置 OPENAI_API_KEY / LLM_API_KEY，无法使用真实 LLM（默认 mock 模式无需密钥）')
    }
    return new OpenAILLM({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
    })
  }

  throw new Error(`未知 LLM 模式：${mode}（可选 mock | openai）`)
}
