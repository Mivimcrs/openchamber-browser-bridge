// 浏览器管理器：拉起本机 Chromium（独立持久 profile）并经 CDP 驱动。
// 纯 Node 实现（Node 24 自带全局 WebSocket），无 npm 依赖。
//
// 关键口径（来自本机实测经验）：
// - Chromium 136+ 禁止 --remote-debugging-port 配默认 profile，必须独立 user-data-dir。
// - 端口避开 9333（browser-use 的 Edge 自动化实例）与 43290-43299（旧桥）。
//   用 --remote-debugging-port=0 让 Chromium 自选端口，再读 DevToolsActivePort。
// - 窗口是用户的：spawn detached，服务停止不杀浏览器；重启后按 profile 复连。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const LAUNCH_TIMEOUT_MS = 12_000
const NAVIGATE_TIMEOUT_MS = 15_000
const CDP_TIMEOUT_MS = 10_000

/** 服务数据目录下的浏览器状态文件：重启服务后可复连同一浏览器 */
function stateFilePath(profileDir) {
  return path.join(profileDir, '..', 'browser-state.json')
}

export class BrowserManager {
  constructor({ exePath, profileDir }) {
    this.exePath = exePath
    this.profileDir = profileDir
    this.child = null
    this.ws = null
    this.wsUrl = null
    this.debugPort = null
    this.msgId = 0
    this.pending = new Map() // id → {resolve, reject, timer}
    this.sessions = new Map() // sessionId → {sessionId, targetId, url, title}
    this.activeSessionId = null // 最近一次被使用的受控页
    this.listeners = []
    this.consoleProblems = []
  }

  onChange(fn) {
    this.listeners.push(fn)
  }

  notify() {
    for (const fn of this.listeners) {
      try { fn(this.describe()) } catch { /* 监听器异常不影响主流程 */ }
    }
  }

  describe() {
    return {
      running: Boolean(this.ws && this.wsUrl),
      pid: this.child ? this.child.pid : null,
      exePath: this.exePath,
      profileDir: this.profileDir,
      debugPort: this.debugPort,
      pages: [...this.sessions.values()].map((s) => ({ id: s.sessionId, url: s.url, title: s.title || '' })),
    }
  }

  /** 拉起浏览器（或复连已在跑的实例）并建立 CDP WebSocket */
  async start() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    // 复连：上次拉起的实例还在（同 profile + 记录的端口）
    if (await this.tryReconnect()) return
    await this.launch()
  }

  async tryReconnect() {
    const candidates = []
    // 1) 上次记录过的端口
    try {
      const st = JSON.parse(readFileSync(stateFilePath(this.profileDir), 'utf8'))
      if (st.port) candidates.push(Number(st.port))
    } catch { /* 没有记录 */ }
    // 2) profile 里浏览器自己写的 DevToolsActivePort（复用已在跑的实例）
    try {
      const text = readFileSync(path.join(this.profileDir, 'DevToolsActivePort'), 'utf8').trim()
      const p = Number(text.split('\n')[0])
      if (Number.isFinite(p) && p > 0) candidates.push(p)
    } catch { /* 没有 */ }

    for (const port of [...new Set(candidates)]) {
      try {
        const info = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }).then(r => r.json())
        if (!info.webSocketDebuggerUrl) continue
        await this.connectWs(info.webSocketDebuggerUrl, port)
        this.rememberPort(port, null)
        return true
      } catch { /* 试下一个候选端口 */ }
    }
    return false
  }

  rememberPort(port, pid) {
    try {
      mkdirSync(path.dirname(stateFilePath(this.profileDir)), { recursive: true })
      writeFileSync(stateFilePath(this.profileDir), JSON.stringify({ port, pid, at: Date.now() }, null, 2) + '\n', 'utf8')
    } catch { /* 记录失败只影响复连 */ }
  }

  async launch() {
    mkdirSync(this.profileDir, { recursive: true })
    const portFile = path.join(this.profileDir, 'DevToolsActivePort')
    // 关键：先删掉上次遗留的 DevToolsActivePort，否则会立刻读到旧端口然后一直等一个死端口
    try { rmSync(portFile, { force: true }) } catch { /* 没有 */ }
    const args = [
      `--user-data-dir=${this.profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,900',
      'about:blank',
    ]
    this.child = spawn(this.exePath, args, { detached: false, stdio: 'ignore' })
    this.child.unref()

    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    let connected = false
    while (Date.now() < deadline) {
      let candidate = null
      try {
        const text = readFileSync(portFile, 'utf8').trim()
        candidate = Number(text.split('\n')[0])
      } catch { /* 还没写出来 */ }
      if (Number.isFinite(candidate) && candidate > 0) {
        // 关键：端口必须真的能应答，避免读到上次实例遗留的死端口
        try {
          const info = await fetch(`http://127.0.0.1:${candidate}/json/version`, { signal: AbortSignal.timeout(1200) }).then(r => r.json())
          if (info.webSocketDebuggerUrl) {
            await this.connectWs(info.webSocketDebuggerUrl, candidate)
            this.rememberPort(candidate, this.child.pid)
            connected = true
            break
          }
        } catch { /* 端口还没就绪，继续等 */ }
      }
      await delay(120)
    }
    if (!connected) {
      // 可能浏览器把启动请求转交给了已在跑的实例（同 profile）：最后试一次复连
      if (await this.tryReconnect()) return
      throw new Error('浏览器已启动但调试端口没有应答（DevToolsActivePort 未就绪）')
    }
  }

  async connectWs(wsUrl, port) {
    this.debugPort = port
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => reject(new Error('连接浏览器 CDP 超时')), CDP_TIMEOUT_MS)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        this.ws = ws
        this.wsUrl = wsUrl
        ws.addEventListener('message', (ev) => this.onMessage(ev))
        ws.addEventListener('close', () => {
          this.ws = null
          this.wsUrl = null
          this.sessions.clear()
          this.notify()
        })
        resolve()
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('浏览器 CDP WebSocket 连接失败'))
      })
    })
    this.notify()
  }

  onMessage(ev) {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') } catch { return }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(timer)
      if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'))
      else resolve(msg.result)
    }
  }

  /** 发一条 CDP 命令到浏览器级 WebSocket */
  send(method, params = {}, sessionId, timeoutMs = CDP_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('浏览器未连接（CDP WebSocket 已断开）'))
    }
    const id = ++this.msgId
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 命令超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify(payload))
    })
  }

  /** 列出页面型目标 */
  async listPages() {
    const { targetInfos } = await this.send('Target.getTargets', {})
    return targetInfos.filter(t => t.type === 'page')
  }

  /** 找一个可复用的页面目标（url 为 about:blank 的），没有就新建 */
  async acquirePage() {
    const pages = await this.listPages()
    const blank = pages.find(p => p.url === 'about:blank' || p.url === '')
    let targetId
    if (blank) {
      targetId = blank.targetId
    } else {
      const { targetId: created } = await this.send('Target.createTarget', { url: 'about:blank' })
      targetId = created
    }
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const entry = { sessionId, targetId, url: 'about:blank', title: '' }
    this.sessions.set(sessionId, entry)
    return entry
  }

  /** 按 tabId（= CDPSession 的 flat sessionId）拿页面会话 */
  sessionFor(tabId) {
    if (tabId && this.sessions.has(tabId)) return this.sessions.get(tabId)
    return null
  }

  /** 当前活跃受控页（没传 tabId 时的默认目标） */
  activeSession() {
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      return this.sessions.get(this.activeSessionId)
    }
    const ids = [...this.sessions.keys()]
    return ids.length ? this.sessions.get(ids[ids.length - 1]) : null
  }

  markActive(entry) {
    if (entry) this.activeSessionId = entry.sessionId
  }

  /** 前台激活指定标签（截图/交互需要窗口前台） */
  async activate(entry) {
    await this.send('Target.activateTarget', { targetId: entry.targetId })
  }

  async navigate(entry, url) {
    const { frameId, errorText } = await this.send('Page.navigate', { url }, entry.sessionId, NAVIGATE_TIMEOUT_MS)
    if (errorText) throw new Error(`导航失败：${errorText}（${url}）`)
    entry.url = url
    // 等加载完成（最多 NAVIGATE_TIMEOUT；超时不视为失败，settled:false）
    let settled = false
    const deadline = Date.now() + NAVIGATE_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        const ready = await this.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, entry.sessionId, 3000)
        if (ready && ready.result && ready.result.value === 'complete') { settled = true; break }
      } catch { /* 页面还在切换 */ }
      await delay(150)
    }
    return { frameId, settled }
  }

  /** 在页面里执行 JS，返回值（对象结果统一转成 JSON 字符串，方便调用方解析） */
  async evaluate(entry, expression, timeoutMs = CDP_TIMEOUT_MS) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, entry.sessionId, timeoutMs)
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception && result.exceptionDetails.exception.description
        ? result.exceptionDetails.exception.description.split('\n')[0]
        : result.exceptionDetails.text
      throw new Error(`页面脚本执行失败：${desc}`)
    }
    const value = result.result ? result.result.value : undefined
    if (value !== null && typeof value === 'object') return JSON.stringify(value)
    return value
  }

  /** 截图（当前视口） */
  async capture(entry) {
    const data = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, entry.sessionId, 30_000)
    return Buffer.from(data.data, 'base64')
  }

  async close() {
    // 只断开连接，不杀浏览器：窗口是用户的，持久 profile 保留登录态
    if (this.ws) {
      try { this.ws.close() } catch { /* 已断开 */ }
    }
    this.ws = null
    this.wsUrl = null
    this.sessions.clear()
    this.notify()
  }
}
