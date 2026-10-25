import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { RUNS_DIR, makeRunId, runWorkflow, workflowCatalog } from './run.js'
import { RunStore } from './core/logger.js'
import { diffStats, diffLines } from './core/diff.js'
import { buildReport } from './report.js'
import { loadStats } from './analytics.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = path.join(ROOT, 'web')
const STORE = new RunStore({ root: RUNS_DIR })
const PORT = Number(process.env.PORT ?? 3000)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/** runId → { events: [{seq, ...event}], listeners: Set<fn>, record } */
const liveRuns = new Map()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    await serveStatic(res, url.pathname)
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, () => {
  console.log(`\n可视化界面已启动： http://localhost:${PORT}\n（Ctrl+C 停止）\n`)
})

async function serveStatic(res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end()
    return
  }

  const filePath = path.normalize(path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname))
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const data = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
}

async function handleApi(req, res, url) {
  const { pathname } = url

  if (req.method === 'GET' && pathname === '/api/workflows') {
    sendJson(res, 200, workflowCatalog())
    return
  }

  if (req.method === 'GET' && pathname === '/api/samples') {
    const [buggy, clean, vulnerable] = await Promise.all([
      readFile(path.join(ROOT, 'src', 'samples', 'buggy-user-service.js'), 'utf8'),
      readFile(path.join(ROOT, 'src', 'samples', 'clean-user-service.js'), 'utf8'),
      readFile(path.join(ROOT, 'src', 'samples', 'vulnerable-auth-service.js'), 'utf8'),
    ])
    sendJson(res, 200, { buggy, clean, vulnerable })
    return
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    sendJson(res, 200, loadStats())
    return
  }

  if (pathname === '/api/runs' && req.method === 'GET') {
    sendJson(res, 200, STORE.list(20))
    return
  }

  if (pathname === '/api/runs' && req.method === 'POST') {
    const body = await readBody(req)
    const workflowName = body.workflow || 'code-review'
    const meta = workflowCatalog().find((item) => item.name === workflowName)
    if (!meta) {
      sendJson(res, 400, { error: `未知 Workflow：${workflowName}` })
      return
    }

    const runId = makeRunId()
    /** @type {{events: any[], listeners: Set<Function>, record: any}} */
    const buffer = { events: [], listeners: new Set(), record: null }
    liveRuns.set(runId, buffer)

    sendJson(res, 200, { runId, workflow: meta })

    const onEvent = (event) => {
      const withSeq = { seq: buffer.events.length, ...event }
      buffer.events.push(withSeq)
      for (const listener of buffer.listeners) listener(withSeq)
    }

    runWorkflow({
      runId,
      workflow: workflowName,
      requirement: body.requirement,
      code: body.code ?? '',
      maxRounds: Number(body.maxRounds) || 3,
      faultInject: body.faultInject || null,
      llm: body.llm || 'mock',
      onEvent,
    })
      .then((record) => {
        buffer.record = record
      })
      .catch((err) => {
        onEvent({ type: 'run.error', reason: err instanceof Error ? err.message : String(err) })
        buffer.record = { runId, status: 'failed', error: String(err) }
      })

    return
  }

  const runMatch = pathname.match(/^\/api\/runs\/([\w-]+)$/)
  if (req.method === 'GET' && runMatch) {
    const runId = runMatch[1]
    if (runId === 'undefined') {
      sendJson(res, 400, { error: '缺少 runId' })
      return
    }
    const record = liveRuns.get(runId)?.record ?? STORE.read(runId)
    if (!record) {
      sendJson(res, 404, { error: '运行记录不存在' })
      return
    }
    sendJson(res, 200, record)
    return
  }

  const diffMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/diff$/)
  if (req.method === 'GET' && diffMatch) {
    const record = liveRuns.get(diffMatch[1])?.record ?? STORE.read(diffMatch[1])
    const versions = record?.state?.versions ?? []
    if (!versions.length) {
      sendJson(res, 404, { error: '没有可对比的代码版本' })
      return
    }
    const from = Number(url.searchParams.get('from') ?? versions.at(-2)?.version ?? versions[0].version)
    const to = Number(url.searchParams.get('to') ?? versions.at(-1).version)
    const oldVersion = versions.find((item) => item.version === from) ?? versions[0]
    const newVersion = versions.find((item) => item.version === to) ?? versions.at(-1)
    const rows = diffLines(oldVersion.code, newVersion.code)
    sendJson(res, 200, {
      from: { version: oldVersion.version, author: oldVersion.author },
      to: { version: newVersion.version, author: newVersion.author },
      rows,
      stats: diffStats(rows),
    })
    return
  }

  const reportMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/report$/)
  if (req.method === 'GET' && reportMatch) {
    const record = liveRuns.get(reportMatch[1])?.record ?? STORE.read(reportMatch[1])
    if (!record) {
      sendJson(res, 404, { error: '运行记录不存在' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${record.runId}.md"`,
    })
    res.end(buildReport(record))
    return
  }

  const sseMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/events$/)
  if (req.method === 'GET' && sseMatch) {
    streamEvents(req, res, sseMatch[1])
    return
  }

  sendJson(res, 404, { error: 'Not Found' })
}

function streamEvents(req, res, runId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
  const cleanup = () => {
    clearInterval(heartbeat)
    liveRuns.get(runId)?.listeners.delete(send)
  }

  const buffer = liveRuns.get(runId)
  if (buffer) {
    buffer.events.forEach(send)
    buffer.listeners.add(send)
    req.on('close', cleanup)
    return
  }

  // 历史运行：一次性回放后关闭
  const record = STORE.read(runId)
  if (!record) {
    send({ type: 'run.error', reason: '运行记录不存在' })
    clearInterval(heartbeat)
    res.end()
    return
  }
  record.events.forEach((event, index) => send({ seq: index, ...event }))
  clearInterval(heartbeat)
  req.on('close', cleanup)
  res.end()
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 5 * 1024 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
