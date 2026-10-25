import test from 'node:test'
import assert from 'node:assert/strict'
import { diffLines, diffStats, toUnifiedDiff } from '../src/core/diff.js'

test('Diff：相同内容只产生 equal 行', () => {
  const rows = diffLines('a\nb', 'a\nb')
  assert.equal(rows.length, 2)
  assert.equal(rows.every((row) => row.type === 'equal'), true)
})

test('Diff：识别新增与删除的行', () => {
  const rows = diffLines('a\nb\nc', 'a\nc\nd')
  const stats = diffStats(rows)
  assert.equal(stats.add, 1)
  assert.equal(stats.remove, 1)
  assert.deepEqual(
    rows.filter((row) => row.type !== 'equal').map((row) => `${row.type}:${row.text}`),
    ['remove:b', 'add:d'],
  )
})

test('Diff：统一格式包含文件头与统计', () => {
  const { text, stats } = toUnifiedDiff('a\nb', 'a\nc', { oldLabel: 'v1', newLabel: 'v2' })
  assert.equal(stats.add, 1)
  assert.equal(stats.remove, 1)
  assert.match(text, /^--- v1/)
  assert.match(text, /\+\+\+ v2/)
  assert.match(text, /-b/)
  assert.match(text, /\+c/)
})
