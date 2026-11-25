// 设置与授权的共享模块（service 与 plugin 各自拷贝一份，避免跨目录 import）。
//
// 授权文件必须落在两个进程都能算出的同一路径：扩展包根目录下的 .state/。
// service 与 plugin 都用「本模块所在目录的上一级」作为包根，天然一致。
// 设置与浏览器 profile 优先放在宿主给的服务数据目录（OPENCHAMBER_SERVICE_DATA_DIR），
// 没有该环境变量时退回 .state/（插件进程拿不到服务数据目录，也能读镜像）。
import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const EXT_ROOT = path.resolve(HERE, '..')

const DEFAULT_EXE = 'C:\\UserProgram\\ungoogled-chromium\\chrome.exe'
/** 候选默认浏览器：按顺序找第一个存在的 Chromium 内核浏览器 */
const CANDIDATE_EXES = [
  'C:\\UserProgram\\ungoogled-chromium\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Vivaldi\\Application\\vivaldi.exe'),
]
/** 授权有效期：每个会话授权后 12 小时内免再问；会话结束后自然失效 */
export const AUTH_TTL_MS = 12 * 60 * 60 * 1000

function stateDir() {
  return path.join(EXT_ROOT, '.state')
}

function ensureStateDir() {
  mkdirSync(stateDir(), { recursive: true })
}

/** 隐私数据目录：优先宿主给的服务数据目录，否则 .state/ */
function dataDir() {
  const dir = process.env.OPENCHAMBER_SERVICE_DATA_DIR
  if (dir && dir.trim()) return dir
  return stateDir()
}

// ---- 设置 ----

function settingsPath() {
  return path.join(dataDir(), 'settings.json')
}
/** 镜像：给拿不到服务数据目录的插件进程读 */
function settingsMirrorPath() {
  return path.join(stateDir(), 'settings.json')
}

export function readSettings() {
  for (const p of [settingsPath(), settingsMirrorPath()]) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'))
      const configured = typeof parsed.browserPath === 'string' && parsed.browserPath.trim() ? parsed.browserPath.trim() : ''
      // 用户显式配置的路径原样返回（不存在也让上层报"未安装"并给引导）
      if (configured) {
        const profileDir = typeof parsed.profileDir === 'string' ? parsed.profileDir : ''
        return { browserPath: configured, profileDir }
      }
      return { browserPath: pickDefaultBrowser(), profileDir: typeof parsed.profileDir === 'string' ? parsed.profileDir : '' }
    } catch { /* 试下一个位置 */ }
  }
  return { browserPath: pickDefaultBrowser(), profileDir: '' }
}

/** 没配置路径时，按候选顺序找第一个存在的 Chromium 内核浏览器 */
function pickDefaultBrowser() {
  for (const candidate of CANDIDATE_EXES) {
    try { if (statSync(candidate).isFile()) return candidate } catch { /* 下一个 */ }
  }
  return DEFAULT_EXE
}

export function writeSettings(patch) {
  const current = readSettings()
  const next = { ...current, ...patch }
  const text = JSON.stringify(next, null, 2) + '\n'
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(settingsPath(), text, 'utf8')
  ensureStateDir()
  writeFileSync(settingsMirrorPath(), text, 'utf8')
  return next
}

/** 桥拉起浏览器用的 profile 目录：默认在服务数据目录下 */
export function resolveProfileDir(settings) {
  if (settings.profileDir && settings.profileDir.trim()) return settings.profileDir
  return path.join(dataDir(), 'browser-profile')
}

export const DEFAULT_BROWSER_EXE = DEFAULT_EXE

// ---- 授权（每会话一次）----

function authPath() {
  return path.join(stateDir(), 'authorization.json')
}

/**
 * 读授权：返回 { sessionId, at } 或 null。
 */
export function readAuthorization() {
  try {
    const parsed = JSON.parse(readFileSync(authPath(), 'utf8'))
    if (typeof parsed.sessionId !== 'string' || typeof parsed.at !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function isAuthorized(sessionId) {
  const auth = readAuthorization()
  if (!auth) return false
  if (sessionId && auth.sessionId !== sessionId) return false
  return Date.now() - auth.at <= AUTH_TTL_MS
}

export function authorizeSession(sessionId) {
  const record = { sessionId: String(sessionId || ''), at: Date.now() }
  ensureStateDir()
  writeFileSync(authPath(), JSON.stringify(record, null, 2) + '\n', 'utf8')
  return record
}

export function revokeAuthorization() {
  try {
    rmSync(authPath(), { force: true })
  } catch { /* 文件不存在就算已撤销 */ }
}

// ---- 浏览器存在性 ----

export function browserExecutableStatus(settings) {
  const s = settings || readSettings()
  const exe = s.browserPath
  let exists = false
  try {
    exists = statSync(exe).isFile()
  } catch { /* 不存在 */ }
  return { path: exe, exists, isDefault: exe === DEFAULT_EXE }
}
