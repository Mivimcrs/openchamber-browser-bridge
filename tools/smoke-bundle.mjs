// 直接起打包后的 service/bundle.js（与宿主同一条入口），跑授权门 + 真浏览器动作。
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const skipBrowser = process.argv.includes('skip-browser')

const dataDir = path.join(ROOT, 'tmp-test-data')
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(path.join(dataDir, 'browser-profile'), { recursive: true })
rmSync(path.join(ROOT, '.state'), { recursive: true, force: true })

const PORT = 45733
const TOKEN = 'smoke-bundle'
const ENTRY = path.join(ROOT, 'service/bundle.js')

const child = spawn(process.execPath, [ENTRY], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(PORT),
    OPENCHAMBER_SERVICE_TOKEN: TOKEN,
    OPENCHAMBER_SERVICE_DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => console.log('SVC-ERR', String(d)))

const BASE = `http://127.0.0.1:${PORT}`
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
async function get(p) {
  const res = await fetch(BASE + p, { headers })
  return { status: res.status, data: await res.json() }
}

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log(`PASS ${name}`)
  else { failures++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ctx = { directory: 'D:\\test', sessionId: 'ses-bundle-1' }

async function main() {
  let ready = false
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/health', { headers }); if (r.ok) { ready = true; break } } catch { /* 未就绪 */ }
    await sleep(150)
  }
  check('health (bundle)', ready)
  check('401', (await fetch(BASE + '/health')).status === 401)

  const denied = await post('/browser-control', { requestId: 'r1', context: ctx, action: 'browser.open', parameters: { url: 'https://example.com' } })
  check('auth gate blocks', denied.data.ok === false && /授权/.test(denied.data.error))

  if (skipBrowser) { child.kill(); process.exit(failures ? 1 : 0) }

  await post('/ui/authorize', { sessionId: ctx.sessionId })
  const open = await post('/browser-control', { requestId: 'r2', context: ctx, action: 'browser.open', parameters: { url: 'https://example.com' } })
  check('browser.open', open.data.ok === true, JSON.stringify(open.data).slice(0, 200))
  const tabId = open.data.ok ? open.data.data.tabId : null
  check('open returns tabId', typeof tabId === 'string' && tabId.length > 0)

  const snap = await post('/browser-control', { requestId: 'r3', context: ctx, action: 'browser.snapshot', parameters: { tabId } })
  check('snapshot text', snap.data.ok === true && snap.data.data.text.length > 0)
  check('snapshot tabs', Array.isArray(snap.data.data.tabs) && snap.data.data.tabs.length >= 1)

  const st = await get('/ui/status')
  check('status authorized', st.data.authorization.authorized === true)
  check('status running', st.data.browser.running === true)

  await post('/ui/authorize', { revoke: true })
  const denied2 = await post('/browser-control', { requestId: 'r4', context: ctx, action: 'browser.snapshot', parameters: {} })
  check('gate after revoke', denied2.data.ok === false && /授权/.test(denied2.data.error))

  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS (bundle)')
  child.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('ERROR', e); child.kill(); process.exit(1) })
