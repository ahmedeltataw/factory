import { createServer } from 'node:http'
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
let portFile = null
let logFile = null
let controlFile = null
let nonce = null

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--port-file') portFile = args[++i]
  else if (arg === '--log-file') logFile = args[++i]
  else if (arg === '--control-file') controlFile = args[++i]
  else if (arg === '--nonce') nonce = args[++i]
}

if (!portFile || !logFile) {
  process.stderr.write('Usage: fake-github.mjs --port-file <path> --log-file <path> [--control-file <path>] [--nonce <nonce>]\n')
  process.exit(1)
}

const memoryState = {
  repos: new Map(),
  requests: [],
}

function getRepoConfig(repoName) {
  const normRepo = repoName.toLowerCase()
  if (controlFile && existsSync(controlFile)) {
    try {
      const raw = readFileSync(controlFile, 'utf8')
      const data = JSON.parse(raw)
      if (data && typeof data === 'object') {
        if (data.repos && typeof data.repos === 'object') {
          for (const key of Object.keys(data.repos)) {
            if (key.toLowerCase() === normRepo) {
              return data.repos[key]
            }
          }
        }
        if (Array.isArray(data.events)) {
          return data
        }
      }
    } catch {
      // transient read error (e.g. concurrent write); fallback to in-memory config
    }
  }
  return memoryState.repos.get(normRepo) || { events: [] }
}

function recordRequest(req, url) {
  const auth = req.headers['authorization']
  const hasBearer = typeof auth === 'string' && /^Bearer\s+/i.test(auth)
  const ifNoneMatch = req.headers['if-none-match'] || null

  const record = {
    timestamp: new Date().toISOString(),
    method: req.method ?? '',
    url: req.url ?? '',
    path: url?.pathname ?? '',
    query: url?.search ?? '',
    hasBearer,
    authScheme: hasBearer ? 'Bearer' : (typeof auth === 'string' ? auth.split(' ')[0] : null),
    ifNoneMatch,
    headers: Object.keys(req.headers),
  }

  memoryState.requests.push(record)
  if (logFile) {
    try {
      appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8')
    } catch (err) {
      process.stderr.write(`Failed to append to request log: ${err instanceof Error ? err.message : String(err)}\n`)
      throw err
    }
  }
  return record
}

const server = createServer((req, res) => {
  let url
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    url = { pathname: req.url ?? '/', search: '' }
    recordRequest(req, url)
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Bad Request' }))
    return
  }

  // Handle control endpoints
  if (url.pathname === '/__control' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      try {
        const payload = body.trim() ? JSON.parse(body) : {}
        if (payload.clearLog) {
          memoryState.requests = []
          if (logFile && existsSync(logFile)) {
            writeFileSync(logFile, '', 'utf8')
          }
        }
        if (payload.repo) {
          const norm = String(payload.repo).toLowerCase()
          memoryState.repos.set(norm, {
            events: Array.isArray(payload.events) ? payload.events : [],
            etag: payload.etag ? String(payload.etag) : null,
          })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    })
    return
  }

  if (url.pathname === '/__control/requests' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(memoryState.requests))
    return
  }

  // Log incoming request before processing
  recordRequest(req, url)

  // Match /repos/:owner/:repo/events
  const eventsMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/events$/)
  if (eventsMatch) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Method Not Allowed' }))
      return
    }

    const owner = eventsMatch[1]
    const name = eventsMatch[2]
    const repoName = `${owner}/${name}`.toLowerCase()
    const config = getRepoConfig(repoName)
    const events = Array.isArray(config.events) ? config.events : []

    const rawEtag = config.etag ? String(config.etag) : `e${events.length}`
    const cleanEtag = rawEtag.replace(/^W\//, '').replace(/^"|"$/g, '')
    const responseEtag = `"${cleanEtag}"`

    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch) {
      const clientClean = String(ifNoneMatch).replace(/^W\//, '').replace(/^"|"$/g, '')
      if (clientClean === cleanEtag) {
        res.writeHead(304, {
          'ETag': responseEtag,
          'x-poll-interval': '60',
        })
        res.end()
        return
      }
    }

    res.writeHead(200, {
      'Content-Type': 'application/vnd.github+json',
      'ETag': responseEtag,
      'x-poll-interval': '60',
    })
    res.end(JSON.stringify(events))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ message: 'Not Found' }))
})

server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    process.stderr.write('Failed to bind server address\n')
    process.exit(1)
  }
  const url = `http://127.0.0.1:${addr.port}`
  writeFileSync(portFile, `${url}\n`, 'utf8')
  process.stdout.write(`FAKE_GITHUB_READY ${url}\n`)
})

server.on('error', (err) => {
  process.stderr.write(`Fake GitHub server error: ${err.message}\n`)
  process.exit(1)
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
