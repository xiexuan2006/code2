import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow } from '../src/run.js'

test('工作流：缺陷代码经过多轮审查+修复后通过', async () => {
  const record = await runWorkflow({ save: false, maxRounds: 3 })

  assert.equal(record.status, 'completed')
  assert.equal(record.result.passed, true)
  assert.equal(record.result.finalScore, 95)
  // 3 轮审查：初审 → 修复 high 后 → 修复 medium 后
  assert.equal(record.result.reviewRounds, 3)
  assert.equal(record.result.fixRounds, 2)
  // 版本：v1 生成 + 2 次修复
  assert.equal(record.state.versions.length, 3)
  // Agent 间存在结构化消息
  assert.equal(record.messages.length >= 6, true)
  const types = record.messages.map((message) => message.type)
  assert.equal(types.includes('code.submitted'), true)
  assert.equal(types.includes('review.rejected'), true)
  assert.equal(types.includes('review.passed'), true)
  assert.equal(types.includes('code.revised'), true)
})

test('工作流：正确代码一轮通过', async () => {
  const { readFile } = await import('node:fs/promises')
  const code = await readFile(new URL('../src/samples/clean-user-service.js', import.meta.url), 'utf8')
  const record = await runWorkflow({ code, save: false, maxRounds: 3 })

  assert.equal(record.result.passed, true)
  assert.equal(record.result.finalScore, 100)
  assert.equal(record.result.reviewRounds, 1)
  assert.equal(record.result.fixRounds, 0)
})

test('工作流：安全风险代码达到修复上限后转人工', async () => {
  const { readFile } = await import('node:fs/promises')
  const code = await readFile(new URL('../src/samples/vulnerable-auth-service.js', import.meta.url), 'utf8')
  const record = await runWorkflow({ code, save: false, maxRounds: 2 })

  assert.equal(record.result.passed, false)
  assert.equal(record.result.reviewRounds, 3) // 初审 + 2 次修复后的复审
  assert.equal(record.result.fixRounds, 2)
  assert.equal(record.result.remainingIssues.length > 0, true)
  assert.match(record.result.summary, /人工/)
})

test('工作流：注入故障后由引擎重试并恢复', async () => {
  const record = await runWorkflow({ save: false, maxRounds: 3, faultInject: 'reviewer' })
  const retries = record.events.filter((event) => event.type === 'node.retry')
  assert.equal(retries.length, 1)
  assert.equal(record.result.passed, true)
})

test('工作流：并行双审分支都产生消息', async () => {
  const record = await runWorkflow({ workflow: 'parallel-demo', save: false })
  const parallel = record.messages.filter((message) => message.type === 'review.parallel')
  assert.equal(parallel.length, 2)
  assert.equal(record.status, 'completed')
})
