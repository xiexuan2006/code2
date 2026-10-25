/**
 * 轻量行级 Diff（LCS），用于 CLI / 报告 / Web 版本对比。
 * 返回 [{ type: 'equal'|'add'|'remove', oldLine, newLine, text }]
 */
export function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split(/\r?\n/)
  const b = String(newText ?? '').split(/\r?\n/)
  const n = a.length
  const m = b.length

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows = []
  let i = 0
  let j = 0
  let oldLine = 1
  let newLine = 1

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'equal', oldLine: oldLine++, newLine: newLine++, text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'remove', oldLine: oldLine++, newLine: null, text: a[i] })
      i += 1
    } else {
      rows.push({ type: 'add', oldLine: null, newLine: newLine++, text: b[j] })
      j += 1
    }
  }
  while (i < n) rows.push({ type: 'remove', oldLine: oldLine++, newLine: null, text: a[i++] })
  while (j < m) rows.push({ type: 'add', oldLine: null, newLine: newLine++, text: b[j++] })

  return rows
}

export function diffStats(rows) {
  return rows.reduce(
    (acc, row) => {
      acc[row.type] += 1
      return acc
    },
    { equal: 0, add: 0, remove: 0 },
  )
}

/** 生成统一格式的文本 diff，便于粘贴到 Markdown / 终端 */
export function toUnifiedDiff(oldText, newText, { oldLabel = 'v1', newLabel = 'final' } = {}) {
  const rows = diffLines(oldText, newText)
  const stats = diffStats(rows)
  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`, `@@ +${stats.add} -${stats.remove} @@`]

  for (const row of rows) {
    if (row.type === 'equal') continue
    const prefix = row.type === 'add' ? '+' : '-'
    lines.push(`${prefix}${row.text}`)
  }

  return { text: lines.join('\n'), stats }
}
