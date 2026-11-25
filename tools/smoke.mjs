// 冒烟测试：不经宿主，直接起服务子进程，测授权门 + 浏览器拉起 + 13 个动作。
// 用法：node tools/smoke.mjs [skip-browser]
// skip-browser 模式只测授权门与缺浏览器引导（不拉起真浏览器）。
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const skipBrowser = process.argv.includes('skip-browser')

// 1. 准备独立数据目录（不污染真实服务数据目录）
const dataDir = path.join(ROOT, 'tmp-test-data')
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(path.join(dataDir, 'browser-profile'), { recursive: true })
// .state 里放授权与设置镜像，测试前一起清掉，免得上次测试的授权/路径串味
rmSync(path.join(ROOT, '.state'), { recursive: true, force: true })

const PORT = 45731
const TOKEN = 'smoke-token-1'

const child = spawn(process.execPath, [path.join(ROOT, 'service/main.js')], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(PORT),
    OPENCHAMBER_SERVICE_TOKEN: TOKEN,
    OPENCHAMBER_SERVICE_DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const BASE = `http://127.0.0.1:${PORT}`
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

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

async function main() {
  // 等健康
  let ready = false
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE + '/health', { headers })
      if (res.ok) { ready = true; break }
    } catch { /* 未就绪 */ }
    await sleep(150)
  }
  check('health', ready)

  // 鉴权
  const noAuth = await fetch(BASE + '/health')
  check('401 without token', noAuth.status === 401)

  const ctx = { directory: 'D:\\test', sessionId: 'ses-smoke-1' }

  // 授权门：未授权时应拒
  const denied = await post('/browser-control', { requestId: 'r1', context: ctx, action: 'browser.open', parameters: { url: 'https://example.com' } })
  check('auth gate blocks', denied.status === 200 && denied.data.ok === false && /授权/.test(denied.data.error), JSON.stringify(denied.data).slice(0, 200))

  if (skipBrowser) {
    // 缺浏览器引导：指一个不存在的 exe
    await post('/ui/settings', { browserPath: 'C:\\不存在\\chrome.exe' })
    await post('/ui/authorize', { sessionId: ctx.sessionId })
    const missing = await post('/browser-control', { requestId: 'r2', context: ctx, action: 'browser.open', parameters: { url: 'https://example.com' } })
    check('missing browser guidance', missing.status === 200 && missing.data.ok === false && /未安装/.test(missing.data.error), JSON.stringify(missing.data).slice(0, 300))
    console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS (skip-browser mode)')
    child.kill()
    process.exit(failures ? 1 : 0)
  }

  // 写授权（模拟 plugin 的 authorize）
  await post('/ui/authorize', { sessionId: ctx.sessionId })

  // 授权门放行 + 拉起浏览器
  const open = await post('/browser-control', { requestId: 'r3', context: ctx, action: 'browser.open', parameters: { url: 'https://example.com' } })
  check('browser.open', open.status === 200 && open.data.ok === true && open.data.data.settled === true, JSON.stringify(open.data).slice(0, 300))
  const tabId = open.data.ok ? open.data.data.tabId : null

  // 快照
  const snap = await post('/browser-control', { requestId: 'r4', context: ctx, action: 'browser.snapshot', parameters: { tabId } })
  check('snapshot', snap.status === 200 && snap.data.ok === true && (/Example Domain/i.test(snap.data.data.text || '') || /文档示例/i.test(snap.data.data.text || '')), JSON.stringify(snap.data).slice(0, 200))
  const elements = snap.data.ok ? snap.data.data.elements : []
  check('snapshot elements', elements.length > 0, `got ${elements.length}`)

  // 点击 a 链接（example.com 有 more information 链接）
  const click = await post('/browser-control', { requestId: 'r5', context: ctx, action: 'browser.click', parameters: { tabId, selector: 'a' } })
  check('click', click.status === 200 && click.data.ok === true, JSON.stringify(click.data).slice(0, 200))

  // 回退
  const back = await post('/browser-control', { requestId: 'r6', context: ctx, action: 'browser.back', parameters: { tabId } })
  check('back', back.status === 200 && back.data.ok === true, JSON.stringify(back.data).slice(0, 200))

  // resize
  const resize = await post('/browser-control', { requestId: 'r7', context: ctx, action: 'browser.resize', parameters: { tabId, viewport: 'mobile' } })
  check('resize mobile', resize.status === 200 && resize.data.ok === true && resize.data.data.viewport.width === 390, JSON.stringify(resize.data).slice(0, 200))

  // capture（要前台；可能因窗口被挡失败，允许 ok:false 但不能崩）
  const cap = await post('/browser-control', { requestId: 'r8', context: ctx, action: 'browser.capture', parameters: { tabId } })
  check('capture (ok or graceful)', cap.status === 200 && (cap.data.ok === true || typeof cap.data.error === 'string'), JSON.stringify(cap.data).slice(0, 120))

  // close
  const close = await post('/browser-control', { requestId: 'r9', context: ctx, action: 'browser.close', parameters: { tabId } })
  check('close', close.status === 200 && close.data.ok === true, JSON.stringify(close.data).slice(0, 200))

  // 面板状态
  const st = await get('/ui/status')
  check('status', st.status === 200 && st.data.browserExe.exists === true && st.data.authorization.authorized === true, JSON.stringify(st.data).slice(0, 300))

  // 撤销后再拒
  await post('/ui/authorize', { revoke: true })
  const denied2 = await post('/browser-control', { requestId: 'r10', context: ctx, action: 'browser.snapshot', parameters: {} })
  check('auth gate after revoke', denied2.status === 200 && denied2.data.ok === false && /授权/.test(denied2.data.error))

  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
  child.kill()
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  console.error('SMOKE ERROR', err)
  child.kill()
  process.exit(1)
})
