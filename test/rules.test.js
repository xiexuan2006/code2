import test from 'node:test'
import assert from 'node:assert/strict'
import { analyze, applyFixes, metricsOf, passedOf, pickFixTarget, scoreOf } from '../src/rules/review-rules.js'

const BUGGY = `function findUser(users, id) {
  for (var i = 0; i <= users.length; i++) {
    if (users[i].id == id) {
      console.log('found')
      return users[i]
    }
  }
}`

test('规则引擎：识别缺陷样例中的全部问题', () => {
  const issues = analyze(BUGGY)
  const ruleIds = issues.map((issue) => issue.ruleId)
  assert.deepEqual(ruleIds, ['OFF_BY_ONE', 'VAR_USAGE', 'LOOSE_EQUAL', 'CONSOLE_LOG'])
})

test('规则引擎：评分与通过判定符合权重规则', () => {
  const issues = analyze(BUGGY)
  // high 30 + medium 15 + medium 15 + low 5 = 65 分
  assert.equal(scoreOf(issues), 35)
  assert.equal(passedOf(issues), false)
  assert.equal(passedOf([]), true)
})

test('规则引擎：分级修复只处理 high 层级且可收敛', () => {
  const first = analyze(BUGGY)
  assert.equal(pickFixTarget(first), 'high')

  const step1 = applyFixes(BUGGY, first, 'high')
  const after1 = analyze(step1.code)
  assert.equal(after1.some((issue) => issue.severity === 'high'), false)
  assert.equal(pickFixTarget(after1), 'medium')

  const step2 = applyFixes(step1.code, after1, 'medium')
  const after2 = analyze(step2.code)
  assert.equal(after2.some((issue) => ['high', 'medium'].includes(issue.severity)), false)
  // 最终审查仍可能有 low 级建议，但不阻塞通过
  assert.equal(passedOf(after2), true)
})

test('规则引擎：安全规则不提供自动修复（转人工）', () => {
  const code = ['const token = "sk-live-123456"', 'eval(input)', 'el.innerHTML = html'].join('\n')
  const issues = analyze(code)
  assert.deepEqual(
    issues.map((issue) => issue.ruleId).sort(),
    ['EVAL_USAGE', 'HARDCODED_SECRET', 'INNER_HTML'],
  )
  assert.equal(issues.every((issue) => issue.fixable === false), true)
  assert.equal(passedOf(issues), false)
})

test('代码度量：统计行数、函数与分支', () => {
  const metrics = metricsOf(BUGGY)
  assert.equal(metrics.totalLines, 8)
  assert.equal(metrics.functions, 1)
  assert.equal(metrics.branches, 1)
  assert.equal(metrics.commentLines, 0)
})
