const $ = (id) => document.getElementById(id)
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

const ui = {
  running: false,
  runId: null,
  meta: null,
  es: null,
  lastSeq: -1,
  nodeStatus: {},
  state: {},
  review: null,
  versions: [],
  activeVersion: null,
  followLatest: true,
  messages: 0,
  logs: 0,
  manualTab: false,
  samples: null,
  diffMode: false,
  replaying: false,
}

init()

function init() {
  $('runBtn').addEventListener('click', startRun)
  $('sample').addEventListener('change', onSampleChange)
  $('exportBtn').addEventListener('click', () => {
    if (ui.runId) window.open(`/api/runs/${ui.runId}/report`, '_blank')
  })
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab, false))
  })
  $('runId').textContent = '未运行'

  // 扩展：深链回放 ?run=<runId>&tab=<tab>
  const params = new URLSearchParams(location.search)
  loadHistory()
  const deepRun = params.get('run')
  if (deepRun) loadRun(deepRun, params.get('tab') ?? 'code')
}

/* ---------------- 运行与事件 ---------------- */

async function startRun() {
  if (ui.running) return

  resetUi()
  ui.running = true
  setChip('running', '运行中')
  $('runBtn').disabled = true
  $('runBtn').textContent = '运行中…'

  const payload = {
    requirement: $('requirement').value.trim(),
    code: $('code').value,
    maxRounds: Number($('maxRounds').value) || 3,
    faultInject: $('fault').checked ? 'reviewer' : null,
    workflow: 'code-review',
  }

  try {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error ?? `请求失败：${response.status}`)
    }

    const data = await response.json()
    ui.runId = data.runId
    ui.meta = data.workflow
    $('runId').textContent = data.runId
    $('exportBtn').disabled = false
    history.replaceState({}, '', `?run=${data.runId}`)
    renderGraph()
    renderRoutes()

    const es = new EventSource(`/api/runs/${data.runId}/events`)
    ui.es = es
    es.onmessage = (event) => {
      try {
        handleEvent(JSON.parse(event.data))
      } catch (err) {
        console.error('事件解析失败', err)
      }
    }
  } catch (err) {
    finishFailed(err instanceof Error ? err.message : String(err))
  }
}

function handleEvent(event) {
  if (typeof event.seq === 'number') {
    if (event.seq <= ui.lastSeq) return
    ui.lastSeq = event.seq
  }

  appendLog(event)

  switch (event.type) {
    case 'node.start':
      setNodeStatus(event.nodeId, 'running')
      break

    case 'node.end':
      setNodeStatus(event.nodeId, event.status === 'ok' ? 'ok' : 'error')
      break

    case 'state.update':
      applyState(event.state)
      break

    case 'message':
      appendMessage(event.message)
      break

    case 'run.end':
      applyState(event.state)
      finish(event)
      break

    case 'run.error':
      finishFailed(event.reason)
      break

    default:
      break
  }
}

function finish(event) {
  ui.running = false
  closeStream()
  $('runBtn').disabled = false
  $('runBtn').textContent = '▶ 运行 Workflow'

  const result = event.result ?? {}
  const passed = Boolean(result.passed)

  setChip(passed ? 'ok' : 'fail', passed ? '通过' : '未通过')

  const verdict = $('verdict')
  verdict.className = `verdict show ${passed ? 'ok' : 'fail'}`
  verdict.innerHTML = `
    <strong>${passed ? '审查通过' : '未通过'}</strong>
    <div class="summary">${esc(result.summary ?? '')}</div>
    <div class="summary">审查 ${result.reviewRounds ?? '—'} 轮 · 修复 ${result.fixRounds ?? '—'} 轮 · 最终得分 ${result.finalScore ?? '—'}</div>
  `

  if (!ui.manualTab) switchTab('code', true)
  loadHistory()
}

function finishFailed(reason) {
  ui.running = false
  closeStream()
  $('runBtn').disabled = false
  $('runBtn').textContent = '▶ 运行 Workflow'
  setChip('fail', '运行失败')
  const verdict = $('verdict')
  verdict.className = 'verdict show fail'
  verdict.innerHTML = `<strong>运行失败</strong><div class="summary">${esc(reason)}</div>`
}

function closeStream() {
  if (ui.es) {
    ui.es.close()
    ui.es = null
  }
}

function resetUi() {
  closeStream()
  Object.assign(ui, {
    runId: null,
    meta: null,
    lastSeq: -1,
    nodeStatus: {},
    state: {},
    review: null,
    versions: [],
    activeVersion: null,
    followLatest: true,
    messages: 0,
    logs: 0,
    manualTab: false,
    diffMode: false,
  })

  $('runId').textContent = '未运行'
  $('exportBtn').disabled = true
  setChip('idle', '待运行')
  $('graph').innerHTML = '<div class="empty small">正在启动工作流…</div>'
  $('stats').innerHTML = ''
  $('verdict').className = 'verdict'
  $('verdict').innerHTML = ''
  $('routes').innerHTML = ''
  $('tab-messages').innerHTML = '<div class="empty">运行中，等待 Agent 消息…</div>'
  $('tab-issues').innerHTML = '<div class="empty">暂无审查结果。</div>'
  $('tab-code').innerHTML = '<div class="empty">暂无代码版本。</div>'
  $('tab-logs').innerHTML = '<div class="empty">暂无执行事件。</div>'
  switchTab('messages', true)
  $('runBtn').disabled = false
  $('runBtn').textContent = '▶ 运行 Workflow'
}

/* ---------------- 状态与渲染 ---------------- */

function setChip(kind, text) {
  const chip = $('statusChip')
  chip.className = `chip ${kind}`
  chip.textContent = text
}

function setNodeStatus(nodeId, status) {
  const current = ui.nodeStatus[nodeId] ?? { status: 'idle', visits: 0 }
  current.status = status
  if (status === 'running') current.visits += 1
  ui.nodeStatus[nodeId] = current
  applyNodeStatuses()
}

function applyNodeStatuses() {
  for (const [nodeId, info] of Object.entries(ui.nodeStatus)) {
    const node = $(`node-${nodeId}`)
    if (!node) continue
    node.classList.remove('running', 'ok', 'error')
    if (info.status !== 'idle') node.classList.add(info.status)
    const text = node.querySelector('.visit-text')
    if (text) {
      if (info.status === 'running') text.textContent = `第 ${info.visits} 次执行`
      else if (info.status === 'ok') text.textContent = `完成 · ${info.visits} 次`
      else if (info.status === 'error') text.textContent = '执行失败'
      else text.textContent = '等待'
    }
  }
}

function renderGraph() {
  const nodes = ui.meta?.nodes ?? []
  if (!nodes.length) return

  $('graph').innerHTML = nodes
    .map((node, index) => {
      const agentLabel = node.agent
        ? node.agent
        : node.branches
          ? node.branches.map((branch) => branch.agent).join(' ‖ ')
          : 'engine'
      return `
        <div class="node" id="node-${esc(node.id)}">
          <div class="node-head">
            <span class="node-order">${String(index + 1).padStart(2, '0')}</span>
            <span class="node-title">${esc(node.label)}</span>
            <span class="node-type">${esc(node.type)}</span>
          </div>
          <div class="node-meta">
            <span>${esc(agentLabel)}</span>
            <span class="node-status"><span class="dot"></span><span class="visit-text">等待</span></span>
          </div>
        </div>
        ${index < nodes.length - 1 ? '<div class="connector"></div>' : ''}
      `
    })
    .join('')
}

function renderRoutes() {
  const edges = (ui.meta?.edges ?? []).filter((edge) => edge.to !== 'END')
  $('routes').innerHTML = edges
    .map((edge) => `<span class="route">${esc(edge.from)} → ${esc(edge.to)}${edge.label ? ` · ${esc(edge.label)}` : ''}</span>`)
    .join('')
}

function applyState(state) {
  if (!state) return
  ui.state = state
  ui.review = state.review ?? null
  ui.versions = state.versions ?? []

  if (ui.followLatest && ui.versions.length) {
    ui.activeVersion = ui.versions.at(-1).version
  } else if (!ui.versions.some((version) => version.version === ui.activeVersion) && ui.versions.length) {
    ui.activeVersion = ui.versions.at(-1).version
  }

  renderStats()
  renderIssues()
  renderCode()
}

function renderStats() {
  const state = ui.state ?? {}
  const review = state.review
  const versionCount = state.versions?.length ?? 0

  const cards = [
    ['代码版本', versionCount ? `v${versionCount}` : '—', ''],
    ['审查轮次', state.reviewRound ?? 0, ''],
    ['修复轮次', `${state.fixRounds ?? 0}/${state.maxRounds ?? '—'}`, ''],
    ['最终得分', review ? review.score : '—', review ? (review.passed ? 'ok' : 'fail') : ''],
    ['判定', review ? (review.passed ? '通过' : '未通过') : '—', review ? (review.passed ? 'ok' : 'fail') : ''],
    ['待修复问题', review ? review.blocking : '—', ''],
  ]

  $('stats').innerHTML = cards
    .map(
      ([label, value, kind]) => `
      <div class="stat">
        <div class="stat-label">${label}</div>
        <div class="stat-value ${kind}">${esc(value)}</div>
      </div>`,
    )
    .join('')
}

function renderIssues() {
  const review = ui.review
  const pane = $('tab-issues')

  if (!review) {
    pane.innerHTML = '<div class="empty">暂无审查结果。</div>'
    return
  }

  const issues = review.issues ?? []
  const count = (severity) => issues.filter((issue) => issue.severity === severity).length

  const head = `
    <div class="review-head">
      <span class="round">第 ${review.round} 轮审查</span>
      <span class="badge ${review.passed ? 'pass' : 'reject'}">${review.passed ? '通过' : '未通过'}</span>
      <span class="score">得分 ${review.score}</span>
      <span class="score">问题 ${issues.length} 个 · high ${count('high')} / medium ${count('medium')} / low ${count('low')}</span>
    </div>
  `

  if (!issues.length) {
    pane.innerHTML = `${head}<div class="empty">本轮没有发现问题。</div>`
    return
  }

  pane.innerHTML =
    head +
    issues
      .map(
        (issue) => `
      <div class="issue ${esc(issue.severity)}">
        <div class="issue-head">
          <span class="sev ${esc(issue.severity)}">${esc(issue.severity)}</span>
          <span class="issue-rule">${esc(issue.ruleId)}</span>
          <span class="issue-line">L${issue.line}</span>
          ${issue.fixable ? '<span class="issue-fixable">可由 FixAgent 自动修复</span>' : ''}
        </div>
        <div class="issue-title">${esc(issue.title)}</div>
        <div class="issue-desc">${esc(issue.message)} 建议：${esc(issue.suggestion)}</div>
        <div class="issue-snippet">${esc(issue.snippet)}</div>
      </div>`,
      )
      .join('')
}

function renderCode() {
  const pane = $('tab-code')
  const versions = ui.versions
  if (!versions.length) {
    pane.innerHTML = '<div class="empty">暂无代码版本。</div>'
    return
  }

  const active = versions.find((version) => version.version === ui.activeVersion) ?? versions.at(-1)
  const isLatest = active.version === versions.at(-1).version

  const issueLines = new Map()
  if (isLatest) {
    for (const issue of ui.review?.issues ?? []) {
      if (!issueLines.has(issue.line)) issueLines.set(issue.line, issue.severity)
    }
  }

  const pills = versions
    .map(
      (version) =>
        `<button class="vpill ${version.version === active.version ? 'active' : ''}" data-version="${version.version}">v${version.version} · ${esc(version.author)}</button>`,
    )
    .join('')

  const codeLines = String(active.code ?? '')
    .split(/\r?\n/)
    .map((line, index) => {
      const severity = issueLines.get(index + 1)
      return `<div class="code-line ${severity ? esc(severity) : ''}"><span class="ln">${index + 1}</span><span class="src">${esc(line) || ' '}</span></div>`
    })
    .join('')

  pane.innerHTML = `
    <div class="versions">
      ${pills}
      <button class="vpill diff-toggle ${ui.diffMode ? 'active' : ''}" id="diffToggle">对比 v1 → v${active.version}</button>
    </div>
    <div class="version-note">v${active.version} · ${esc(active.author)} · ${esc(active.note)}${isLatest && issueLines.size && !ui.diffMode ? ' · 高亮为当前审查命中行' : ''}</div>
    <div id="codeBody" class="code-wrap">${codeLines}</div>
  `

  pane.querySelectorAll('.vpill[data-version]').forEach((pill) => {
    pill.addEventListener('click', () => {
      ui.followLatest = false
      ui.activeVersion = Number(pill.dataset.version)
      renderCode()
    })
  })

  $('diffToggle').addEventListener('click', () => {
    ui.diffMode = !ui.diffMode
    renderCode()
  })

  if (ui.diffMode) renderDiff(active.version)
}

/** 扩展：调用后端 LCS diff 接口，渲染 v1 → 当前版本的行级差异 */
async function renderDiff(toVersion) {
  const body = $('codeBody')
  if (!body) return

  if (toVersion <= 1) {
    body.innerHTML = '<div class="empty">只有 v1 一个版本，暂无可对比的差异。</div>'
    return
  }

  body.innerHTML = '<div class="empty">正在计算差异…</div>'
  try {
    const response = await fetch(`/api/runs/${ui.runId}/diff?from=1&to=${toVersion}`)
    if (!response.ok) throw new Error('没有可对比的版本')
    const data = await response.json()
    const changes = (data.rows ?? []).filter((row) => row.type !== 'equal')

    body.innerHTML =
      `<div class="diff-stat">v${data.from.version} → v${data.to.version} · <span class="add">+${data.stats.add}</span> / <span class="remove">-${data.stats.remove}</span> 行</div>` +
      (changes.length
        ? changes
            .map(
              (row) => `
        <div class="diff-line ${row.type}">
          <span class="sign">${row.type === 'add' ? '+' : '-'}</span>
          <span class="src">${esc(row.text) || ' '}</span>
        </div>`,
            )
            .join('')
        : '<div class="empty">两个版本内容一致。</div>')
  } catch (err) {
    body.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : String(err))}</div>`
  }
}

/* ---------------- 消息、日志 ---------------- */

function appendMessage(message) {
  if (ui.messages === 0) $('tab-messages').innerHTML = ''
  ui.messages += 1

  const payload = message.payload ?? {}
  let summary = ''
  switch (message.type) {
    case 'code.submitted':
      summary = `v${payload.version} · ${payload.source === 'input' ? '外部输入' : 'CodingAgent 生成'} · ${payload.lines} 行`
      break
    case 'review.rejected':
      summary = `得分 ${payload.score} · ${payload.issues?.length ?? 0} 个问题未通过`
      break
    case 'review.passed':
      summary = `得分 ${payload.score} · 审查通过`
      break
    case 'review.parallel':
      summary = `${payload.mode} 分支 · 得分 ${payload.score} · ${payload.issues?.length ?? 0} 个问题`
      break
    case 'code.revised':
      summary = `v${payload.version} · 修复 ${payload.fixed?.length ?? 0} 个 ${payload.targetSeverity} 问题`
      break
    case 'code.unchanged':
      summary = payload.reason ?? '代码无变更'
      break
    default:
      summary = Object.keys(payload).length ? JSON.stringify(payload) : ''
  }

  const div = document.createElement('div')
  div.className = 'msg'
  div.innerHTML = `
    <div class="msg-head">
      <span class="from">${esc(message.from)}</span>
      <span class="arrow">→</span>
      <span class="to">${esc(message.to)}</span>
      <span class="msg-type">${esc(message.type)}</span>
      <span class="msg-round">R${message.round ?? 0}</span>
    </div>
    <div class="msg-body">${esc(summary)}</div>
  `
  $('tab-messages').appendChild(div)
  autoScroll()
}

function appendLog(event) {
  if (ui.logs === 0) $('tab-logs').innerHTML = ''
  ui.logs += 1

  const line = logText(event)
  if (!line) return

  const time = new Date(event.timestamp ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false })
  const div = document.createElement('div')
  div.className = 'log-line'
  div.innerHTML = `<span class="t">${esc(time)}</span><span class="tag">${esc(event.type)}</span><span>${esc(line)}</span>`
  $('tab-logs').appendChild(div)
  autoScroll()
}

function logText(event) {
  switch (event.type) {
    case 'run.init':
      return `运行开始 · ${event.runId} · ${event.llmMode} 模式`
    case 'run.start':
      return `工作流启动 · ${event.workflow?.title ?? ''}`
    case 'node.start':
      return `▶ ${event.nodeId} · ${event.label ?? ''} · 第 ${event.visit} 次`
    case 'node.end':
      return `${event.status === 'ok' ? '✔' : '✖'} ${event.nodeId} 完成 · ${event.durationMs}ms${event.error ? ` · ${event.error}` : ''}`
    case 'node.retry':
      return `⚠ ${event.nodeId} 重试 ${event.attempt}/${event.maxAttempts} · ${event.error}`
    case 'node.overflow':
      return `⤵ ${event.reason} · 跳转 ${event.to}`
    case 'node.error':
      return `✖ ${event.nodeId} · ${event.error}`
    case 'route':
      return `↳ ${event.from} → ${event.to}${event.reason ? ` · ${event.reason}` : ''}`
    case 'message':
      return `⇢ ${event.message.from} → ${event.message.to} · ${event.message.type}`
    case 'branch.start':
      return `⑂ 并行分支开始 · ${event.branchId}`
    case 'branch.end':
      return `⑂ 并行分支结束 · ${event.branchId} · ${event.status}`
    case 'run.end':
      return `■ 运行结束 · ${event.status}`
    case 'run.error':
      return `✖ ${event.reason}`
    default:
      return ''
  }
}

function autoScroll() {
  const body = document.querySelector('.tab-body')
  if (!body) return
  requestAnimationFrame(() => {
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 120) {
      body.scrollTop = body.scrollHeight
    }
  })
}

/* ---------------- 扩展：运行历史与回放 ---------------- */

async function loadHistory() {
  const pane = $('history')
  if (!pane) return
  try {
    const response = await fetch('/api/runs')
    const runs = await response.json()
    if (!runs.length) {
      pane.innerHTML = '<div class="empty small">暂无历史运行，先点上方运行一次</div>'
      return
    }
    pane.innerHTML = runs
      .slice(0, 8)
      .map(
        (run) => `
      <button class="hitem ${run.runId === ui.runId ? 'active' : ''}" data-run="${esc(run.runId)}">
        <span class="hdot ${run.passed ? 'ok' : 'fail'}"></span>
        <span class="hname">${esc(run.runId)}</span>
        <span class="hmeta">${esc(run.workflow ?? '')} · ${run.durationMs ?? '?'}ms</span>
      </button>`,
      )
      .join('')

    pane.querySelectorAll('.hitem').forEach((item) => {
      item.addEventListener('click', () => loadRun(item.dataset.run, 'code'))
    })
  } catch {
    pane.innerHTML = '<div class="empty small">历史记录读取失败</div>'
  }
}

async function loadRun(runId, tab) {
  if (ui.running) return
  try {
    const response = await fetch(`/api/runs/${runId}`)
    if (!response.ok) throw new Error('运行记录不存在')
    const record = await response.json()

    resetUi()
    ui.runId = record.runId
    ui.meta = record.workflow
    ui.replaying = true
    $('runId').textContent = record.runId
    $('exportBtn').disabled = false
    history.replaceState({}, '', `?run=${record.runId}`)

    renderGraph()
    renderRoutes()
    replay(record)
    loadHistory()
    switchTab(tab, true)
    setChip(record.result?.passed ? 'ok' : 'fail', record.result?.passed ? '通过' : '未通过')
  } catch (err) {
    finishFailed(err instanceof Error ? err.message : String(err))
  }
}

/** 用落盘事件把一次历史运行完整重演到界面上（不依赖网络流） */
function replay(record) {
  for (const event of record.events ?? []) {
    appendLog(event)

    if (event.type === 'node.start') {
      const visits = (ui.nodeStatus[event.nodeId]?.visits ?? 0) + 1
      ui.nodeStatus[event.nodeId] = { status: 'running', visits }
    } else if (event.type === 'node.end') {
      ui.nodeStatus[event.nodeId] = {
        status: event.status === 'ok' ? 'ok' : 'error',
        visits: ui.nodeStatus[event.nodeId]?.visits ?? 1,
      }
    } else if (event.type === 'message') {
      appendMessage(event.message)
    } else if (event.type === 'state.update') {
      applyState(event.state)
    }
  }

  applyNodeStatuses()
  if (record.state) applyState(record.state)
  finish({ result: record.result ?? {}, state: record.state, status: record.status })
  ui.replaying = false
}

/* ---------------- tabs 与样例 ---------------- */

function switchTab(name, isAuto) {
  if (!isAuto) ui.manualTab = true
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name)
  })
  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `tab-${name}`)
  })
}

async function onSampleChange(event) {
  const value = event.target.value
  if (value === 'auto') {
    $('code').value = ''
    return
  }

  try {
    if (!ui.samples) {
      const response = await fetch('/api/samples')
      ui.samples = await response.json()
    }
    $('code').value = ui.samples[value] ?? ''
  } catch {
    $('code').value = ''
  }
}
