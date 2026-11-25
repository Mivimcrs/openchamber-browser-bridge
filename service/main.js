// 服务主入口：OpenChamber 宿主拉起的本机回环服务。
// 契约：绑 127.0.0.1 的 OPENCHAMBER_SERVICE_PORT，每个请求验 Bearer OPENCHAMBER_SERVICE_TOKEN，
// GET /health 200 即就绪。宿主把 openchamber_web 的 browser.* 动作 POST 到 /browser-control。
import http from 'node:http'
import { readSettings, writeSettings, resolveProfileDir, isAuthorized, authorizeSession, revokeAuthorization, browserExecutableStatus, readAuthorization, AUTH_TTL_MS } from './state.mjs'
import { BrowserManager } from './browser.mjs'
import { runAction } from './provider.mjs'

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0)
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? ''

if (!PORT || !TOKEN) {
  console.error('[browser-bridge] missing OPENCHAMBER_SERVICE_PORT or OPENCHAMBER_SERVICE_TOKEN')
  process.exit(1)
}

const BROWSER_ACTIONS = new Set([
  'browser.open', 'browser.snapshot', 'browser.click', 'browser.type', 'browser.select',
  'browser.scroll', 'browser.back', 'browser.forward', 'browser.inspect',
  'browser.capture', 'browser.resize', 'browser.close',
])

let manager = null

function getManager() {
  if (!manager) {
    const settings = readSettings()
    manager = new BrowserManager({ exePath: settings.browserPath, profileDir: resolveProfileDir(settings) })
    manager.onChange(() => { /* 状态变化：面板轮询拿 */ })
  }
  return manager
}

function ensureAuthorized(context) {
  const sessionId = context && context.sessionId ? String(context.sessionId) : ''
  return isAuthorized(sessionId || null)
}

function statusPayload() {
  const settings = readSettings()
  const exeStatus = browserExecutableStatus(settings)
  const auth = readAuthorization()
  const authorized = auth ? Date.now() - auth.at <= AUTH_TTL_MS : false
  const m = manager ? manager.describe() : { running: false, pages: [] }
  return {
    settings: { browserPath: settings.browserPath, profileDir: resolveProfileDir(settings), defaultBrowser: exeStatus.isDefault },
    browserExe: exeStatus,
    authorization: { authorized, sessionId: auth ? auth.sessionId : null, at: auth ? auth.at : null },
    browser: m,
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers['authorization']
  if (auth !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  try {
    // ---- 浏览器提供者：宿主转发 openchamber_web 动作 ----
    if (req.method === 'POST' && url.pathname === '/browser-control') {
      const body = await readBody(req)
      let parsed
      try { parsed = JSON.parse(body) } catch { sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }); return }
      if (!parsed || typeof parsed.action !== 'string' || !BROWSER_ACTIONS.has(parsed.action)) {
        sendJson(res, 400, { ok: false, error: '不是合法的 browser.* 动作' })
        return
      }
      const result = await runAction(getManager(), parsed, { exeStatus: browserExecutableStatus(readSettings()) }, { ensureAuthorized })
      sendJson(res, 200, result)
      return
    }

    // ---- 面板路由 ----
    if (url.pathname === '/ui/status' && req.method === 'GET') {
      sendJson(res, 200, statusPayload())
      return
    }
    if (url.pathname === '/ui/settings' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'GET') {
        const settings = readSettings()
        sendJson(res, 200, { browserPath: settings.browserPath, profileDir: settings.profileDir })
        return
      }
      const body = await readBody(req)
      let parsed
      try { parsed = JSON.parse(body) } catch { sendJson(res, 400, { error: '请求体不是 JSON' }); return }
      const patch = {}
      if (typeof parsed.browserPath === 'string') patch.browserPath = parsed.browserPath.trim()
      if (typeof parsed.profileDir === 'string') patch.profileDir = parsed.profileDir.trim()
      writeSettings(patch)
      // 路径变了要换浏览器实例
      if (manager && (patch.browserPath !== undefined || patch.profileDir !== undefined)) {
        await manager.close()
        manager = null
      }
      const settings = readSettings()
      sendJson(res, 200, { saved: true, settings: { browserPath: settings.browserPath, profileDir: settings.profileDir } })
      return
    }
    // 授权动作（面板撤销用；写入走 plugin 的 browser_bridge_authorize 工具）
    if (url.pathname === '/ui/authorize' && req.method === 'POST') {
      const body = await readBody(req)
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* 空 body 视为撤销 */ }
      if (parsed && parsed.revoke) {
        revokeAuthorization()
        sendJson(res, 200, { revoked: true })
      } else {
        const record = authorizeSession(parsed.sessionId || null)
        sendJson(res, 200, { authorized: true, at: record.at })
      }
      return
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: err.message || '服务内部错误' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[browser-bridge] service listening on 127.0.0.1:${PORT}`)
})

process.on('SIGTERM', () => {
  // 不杀浏览器：窗口与持久 profile 是用户的
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
})
