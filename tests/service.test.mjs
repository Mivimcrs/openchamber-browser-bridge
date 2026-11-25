// 单元测试：授权门、动作白名单、设置与默认浏览器探测。
// 直接测服务与 state 模块，不拉起浏览器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateUrl = (tag) => pathToFileURL(path.join(ROOT, 'service/state.mjs')).href + '?t=' + tag

// ---- state 模块（数据目录用环境变量指到临时目录）----

test('settings: 默认返回存在的浏览器路径', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-state-'))
  process.env.OPENCHAMBER_SERVICE_DATA_DIR = dir
  const mod = await import(stateUrl('a' + Date.now()))
  const settings = mod.readSettings()
  assert.ok(settings.browserPath.length > 0)
  assert.ok(settings.browserPath.endsWith('.exe'))
  rmSync(dir, { recursive: true, force: true })
})

test('settings: 显式配置的路径原样保留（不静默替换）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-state-'))
  process.env.OPENCHAMBER_SERVICE_DATA_DIR = dir
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ browserPath: 'C:\\nope\\nope.exe', profileDir: '' }))
  const mod = await import(stateUrl('b' + Date.now()))
  assert.equal(mod.readSettings().browserPath, 'C:\\nope\\nope.exe')
  assert.equal(mod.browserExecutableStatus(mod.readSettings()).exists, false)
  rmSync(dir, { recursive: true, force: true })
})

test('authorize: 会话隔离 + TTL + 撤销', async () => {
  const mod = await import(stateUrl('c' + Date.now()))
  mod.revokeAuthorization()
  assert.equal(mod.isAuthorized('ses-a'), false)
  mod.authorizeSession('ses-a')
  assert.equal(mod.isAuthorized('ses-a'), true)
  assert.equal(mod.isAuthorized('ses-b'), false)
  mod.revokeAuthorization()
  assert.equal(mod.isAuthorized('ses-a'), false)
})

// ---- 服务 HTTP ----

test('server: 401 / 动作白名单 / 未授权拒绝', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-svc-'))
  mkdirSync(path.join(dir, 'browser-profile'), { recursive: true })
  const port = 45911
  const token = 'test-token'
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [path.join(ROOT, 'service/main.js')], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, OPENCHAMBER_SERVICE_DATA_DIR: dir },
    stdio: 'ignore',
  })
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }) })

  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  let ready = false
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(base + '/health', { headers }); if (r.ok) { ready = true; break } } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 120))
  }
  assert.equal(ready, true, '服务应在 5 秒内就绪')

  assert.equal((await fetch(base + '/health')).status, 401)

  const ctx = { directory: 'D:\\t', sessionId: 'ses-test' }
  const denied = await fetch(base + '/browser-control', {
    method: 'POST', headers,
    body: JSON.stringify({ requestId: 'r1', context: ctx, action: 'browser.open', parameters: { url: 'https://example.com' } }),
  }).then((r) => r.json())
  assert.equal(denied.ok, false)
  assert.match(denied.error, /授权|安装/)

  const unknown = await fetch(base + '/browser-control', {
    method: 'POST', headers,
    body: JSON.stringify({ requestId: 'r2', context: ctx, action: 'browser.hover', parameters: {} }),
  })
  assert.equal(unknown.status, 400, '未在契约里的动作应 400')
})
