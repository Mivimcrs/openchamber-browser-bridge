// service/main.js
import http from "node:http";

// service/state.mjs
import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync as rmSync2 } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var HERE = path.dirname(fileURLToPath(import.meta.url));
var EXT_ROOT = path.resolve(HERE, "..");
var DEFAULT_EXE = "C:\\UserProgram\\ungoogled-chromium\\chrome.exe";
var CANDIDATE_EXES = [
  "C:\\UserProgram\\ungoogled-chromium\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(process.env.LOCALAPPDATA || "", "Vivaldi\\Application\\vivaldi.exe")
];
var AUTH_TTL_MS = 12 * 60 * 60 * 1e3;
function stateDir() {
  return path.join(EXT_ROOT, ".state");
}
function ensureStateDir() {
  mkdirSync(stateDir(), { recursive: true });
}
function dataDir() {
  const dir = process.env.OPENCHAMBER_SERVICE_DATA_DIR;
  if (dir && dir.trim()) return dir;
  return stateDir();
}
function settingsPath() {
  return path.join(dataDir(), "settings.json");
}
function settingsMirrorPath() {
  return path.join(stateDir(), "settings.json");
}
function readSettings() {
  for (const p of [settingsPath(), settingsMirrorPath()]) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      const configured = typeof parsed.browserPath === "string" && parsed.browserPath.trim() ? parsed.browserPath.trim() : "";
      if (configured) {
        const profileDir = typeof parsed.profileDir === "string" ? parsed.profileDir : "";
        return { browserPath: configured, profileDir };
      }
      return { browserPath: pickDefaultBrowser(), profileDir: typeof parsed.profileDir === "string" ? parsed.profileDir : "" };
    } catch {
    }
  }
  return { browserPath: pickDefaultBrowser(), profileDir: "" };
}
function pickDefaultBrowser() {
  for (const candidate of CANDIDATE_EXES) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
    }
  }
  return DEFAULT_EXE;
}
function writeSettings(patch) {
  const current = readSettings();
  const next = { ...current, ...patch };
  const text = JSON.stringify(next, null, 2) + "\n";
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsPath(), text, "utf8");
  ensureStateDir();
  writeFileSync(settingsMirrorPath(), text, "utf8");
  return next;
}
function resolveProfileDir(settings) {
  if (settings.profileDir && settings.profileDir.trim()) return settings.profileDir;
  return path.join(dataDir(), "browser-profile");
}
function authPath() {
  return path.join(stateDir(), "authorization.json");
}
function readAuthorization() {
  try {
    const parsed = JSON.parse(readFileSync(authPath(), "utf8"));
    if (typeof parsed.sessionId !== "string" || typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}
function isAuthorized(sessionId) {
  const auth = readAuthorization();
  if (!auth) return false;
  if (sessionId && auth.sessionId !== sessionId) return false;
  return Date.now() - auth.at <= AUTH_TTL_MS;
}
function authorizeSession(sessionId) {
  const record = { sessionId: String(sessionId || ""), at: Date.now() };
  ensureStateDir();
  writeFileSync(authPath(), JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}
function revokeAuthorization() {
  try {
    rmSync2(authPath(), { force: true });
  } catch {
  }
}
function browserExecutableStatus(settings) {
  const s = settings || readSettings();
  const exe = s.browserPath;
  let exists = false;
  try {
    exists = statSync(exe).isFile();
  } catch {
  }
  return { path: exe, exists, isDefault: exe === DEFAULT_EXE };
}

// service/browser.mjs
import { spawn } from "node:child_process";
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
import path2 from "node:path";
import { setTimeout as delay } from "node:timers/promises";
var LAUNCH_TIMEOUT_MS = 12e3;
var NAVIGATE_TIMEOUT_MS = 15e3;
var CDP_TIMEOUT_MS = 1e4;
function stateFilePath(profileDir) {
  return path2.join(profileDir, "..", "browser-state.json");
}
var BrowserManager = class {
  constructor({ exePath, profileDir }) {
    this.exePath = exePath;
    this.profileDir = profileDir;
    this.child = null;
    this.ws = null;
    this.wsUrl = null;
    this.debugPort = null;
    this.msgId = 0;
    this.pending = /* @__PURE__ */ new Map();
    this.sessions = /* @__PURE__ */ new Map();
    this.activeSessionId = null;
    this.listeners = [];
    this.consoleProblems = [];
  }
  onChange(fn) {
    this.listeners.push(fn);
  }
  notify() {
    for (const fn of this.listeners) {
      try {
        fn(this.describe());
      } catch {
      }
    }
  }
  describe() {
    return {
      running: Boolean(this.ws && this.wsUrl),
      pid: this.child ? this.child.pid : null,
      exePath: this.exePath,
      profileDir: this.profileDir,
      debugPort: this.debugPort,
      pages: [...this.sessions.values()].map((s) => ({ id: s.sessionId, url: s.url, title: s.title || "" }))
    };
  }
  /** 拉起浏览器（或复连已在跑的实例）并建立 CDP WebSocket */
  async start() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (await this.tryReconnect()) return;
    await this.launch();
  }
  async tryReconnect() {
    const candidates = [];
    try {
      const st = JSON.parse(readFileSync2(stateFilePath(this.profileDir), "utf8"));
      if (st.port) candidates.push(Number(st.port));
    } catch {
    }
    try {
      const text = readFileSync2(path2.join(this.profileDir, "DevToolsActivePort"), "utf8").trim();
      const p = Number(text.split("\n")[0]);
      if (Number.isFinite(p) && p > 0) candidates.push(p);
    } catch {
    }
    for (const port of [...new Set(candidates)]) {
      try {
        const info = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2e3) }).then((r) => r.json());
        if (!info.webSocketDebuggerUrl) continue;
        await this.connectWs(info.webSocketDebuggerUrl, port);
        this.rememberPort(port, null);
        return true;
      } catch {
      }
    }
    return false;
  }
  rememberPort(port, pid) {
    try {
      mkdirSync2(path2.dirname(stateFilePath(this.profileDir)), { recursive: true });
      writeFileSync2(stateFilePath(this.profileDir), JSON.stringify({ port, pid, at: Date.now() }, null, 2) + "\n", "utf8");
    } catch {
    }
  }
  async launch() {
    mkdirSync2(this.profileDir, { recursive: true });
    const portFile = path2.join(this.profileDir, "DevToolsActivePort");
    try {
      rmSync(portFile, { force: true });
    } catch {
    }
    const args = [
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
      "about:blank"
    ];
    this.child = spawn(this.exePath, args, { detached: false, stdio: "ignore" });
    this.child.unref();
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let connected = false;
    while (Date.now() < deadline) {
      let candidate = null;
      try {
        const text = readFileSync2(portFile, "utf8").trim();
        candidate = Number(text.split("\n")[0]);
      } catch {
      }
      if (Number.isFinite(candidate) && candidate > 0) {
        try {
          const info = await fetch(`http://127.0.0.1:${candidate}/json/version`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
          if (info.webSocketDebuggerUrl) {
            await this.connectWs(info.webSocketDebuggerUrl, candidate);
            this.rememberPort(candidate, this.child.pid);
            connected = true;
            break;
          }
        } catch {
        }
      }
      await delay(120);
    }
    if (!connected) {
      if (await this.tryReconnect()) return;
      throw new Error("\u6D4F\u89C8\u5668\u5DF2\u542F\u52A8\u4F46\u8C03\u8BD5\u7AEF\u53E3\u6CA1\u6709\u5E94\u7B54\uFF08DevToolsActivePort \u672A\u5C31\u7EEA\uFF09");
    }
  }
  async connectWs(wsUrl, port) {
    this.debugPort = port;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error("\u8FDE\u63A5\u6D4F\u89C8\u5668 CDP \u8D85\u65F6")), CDP_TIMEOUT_MS);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        this.wsUrl = wsUrl;
        ws.addEventListener("message", (ev) => this.onMessage(ev));
        ws.addEventListener("close", () => {
          this.ws = null;
          this.wsUrl = null;
          this.sessions.clear();
          this.notify();
        });
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("\u6D4F\u89C8\u5668 CDP WebSocket \u8FDE\u63A5\u5931\u8D25"));
      });
    });
    this.notify();
  }
  onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || "CDP \u9519\u8BEF"));
      else resolve(msg.result);
    }
  }
  /** 发一条 CDP 命令到浏览器级 WebSocket */
  send(method, params = {}, sessionId, timeoutMs = CDP_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("\u6D4F\u89C8\u5668\u672A\u8FDE\u63A5\uFF08CDP WebSocket \u5DF2\u65AD\u5F00\uFF09"));
    }
    const id = ++this.msgId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP \u547D\u4EE4\u8D85\u65F6\uFF1A${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }
  /** 列出页面型目标 */
  async listPages() {
    const { targetInfos } = await this.send("Target.getTargets", {});
    return targetInfos.filter((t) => t.type === "page");
  }
  /** 找一个可复用的页面目标（url 为 about:blank 的），没有就新建 */
  async acquirePage() {
    const pages = await this.listPages();
    const blank = pages.find((p) => p.url === "about:blank" || p.url === "");
    let targetId;
    if (blank) {
      targetId = blank.targetId;
    } else {
      const { targetId: created } = await this.send("Target.createTarget", { url: "about:blank" });
      targetId = created;
    }
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const entry = { sessionId, targetId, url: "about:blank", title: "" };
    this.sessions.set(sessionId, entry);
    return entry;
  }
  /** 按 tabId（= CDPSession 的 flat sessionId）拿页面会话 */
  sessionFor(tabId) {
    if (tabId && this.sessions.has(tabId)) return this.sessions.get(tabId);
    return null;
  }
  /** 当前活跃受控页（没传 tabId 时的默认目标） */
  activeSession() {
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      return this.sessions.get(this.activeSessionId);
    }
    const ids = [...this.sessions.keys()];
    return ids.length ? this.sessions.get(ids[ids.length - 1]) : null;
  }
  markActive(entry) {
    if (entry) this.activeSessionId = entry.sessionId;
  }
  /** 前台激活指定标签（截图/交互需要窗口前台） */
  async activate(entry) {
    await this.send("Target.activateTarget", { targetId: entry.targetId });
  }
  async navigate(entry, url) {
    const { frameId, errorText } = await this.send("Page.navigate", { url }, entry.sessionId, NAVIGATE_TIMEOUT_MS);
    if (errorText) throw new Error(`\u5BFC\u822A\u5931\u8D25\uFF1A${errorText}\uFF08${url}\uFF09`);
    entry.url = url;
    let settled = false;
    const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const ready = await this.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, entry.sessionId, 3e3);
        if (ready && ready.result && ready.result.value === "complete") {
          settled = true;
          break;
        }
      } catch {
      }
      await delay(150);
    }
    return { frameId, settled };
  }
  /** 在页面里执行 JS，返回值（对象结果统一转成 JSON 字符串，方便调用方解析） */
  async evaluate(entry, expression, timeoutMs = CDP_TIMEOUT_MS) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, entry.sessionId, timeoutMs);
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception && result.exceptionDetails.exception.description ? result.exceptionDetails.exception.description.split("\n")[0] : result.exceptionDetails.text;
      throw new Error(`\u9875\u9762\u811A\u672C\u6267\u884C\u5931\u8D25\uFF1A${desc}`);
    }
    const value = result.result ? result.result.value : void 0;
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value;
  }
  /** 截图（当前视口） */
  async capture(entry) {
    const data = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, entry.sessionId, 3e4);
    return Buffer.from(data.data, "base64");
  }
  async close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
    }
    this.ws = null;
    this.wsUrl = null;
    this.sessions.clear();
    this.notify();
  }
};

// service/provider.mjs
var MODE_SIZES = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
  fill: null
};
var MAX_SNAPSHOT_ELEMENTS = 300;
var MAX_SNAPSHOT_TEXT = 2e4;
var MAX_LABEL = 120;
var HOST_OPEN_BUDGET_MS = 3e4;
var ActionError = class extends Error {
};
function fail(error) {
  return { ok: false, error };
}
function done(data) {
  return { ok: true, data };
}
function summarizeViewport(width, height) {
  for (const mode of Object.keys(MODE_SIZES)) {
    const size = MODE_SIZES[mode];
    if (size && size.width === width && size.height === height) return { mode, width, height };
  }
  return { mode: "custom", width, height };
}
function requireSelector(params, action) {
  if (!params.selector || !String(params.selector).trim()) {
    throw new ActionError(`${action} \u9700\u8981\u4E00\u4E2A CSS selector\uFF08\u53C2\u6570 selector\uFF09`);
  }
  return String(params.selector);
}
var PROBE_SCRIPT = `(() => {
  const INTERACTIVE = new Set(['a','button','input','select','textarea','summary','label','option','datalist']);
  const seen = new Set();
  const elements = [];
  const labelOf = (el) => {
    const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
    if (aria) return aria;
    const id = el.id;
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    if (el instanceof HTMLInputElement && ['submit','button','reset'].includes(el.type)) return el.value || el.type;
    return (el.textContent || '').trim().replace(/\\s+/g, ' ');
  };
  const all = document.querySelectorAll('a,button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="option"],[onclick]');
  for (const el of all) {
    if (elements.length >= ${MAX_SNAPSHOT_ELEMENTS}) break;
    if (seen.has(el)) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && !el.textContent.trim()) continue;
    // \u8BA1\u7B97\u4E00\u4E2A\u7A33\u5B9A selector
    let selector = '';
    if (el.id) selector = '#' + CSS.escape(el.id);
    else {
      const path = [];
      let node = el;
      while (node && node.nodeType === 1 && path.length < 6) {
        const parent = node.parentElement;
        if (!parent) { path.unshift(node.tagName.toLowerCase()); break; }
        const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
        const idx = sibs.indexOf(node);
        const tag = node.tagName.toLowerCase();
        const nth = sibs.length > 1 ? ':nth-of-type(' + (idx + 1) + ')' : '';
        path.unshift(tag + nth);
        node = parent;
      }
      selector = path.join('>');
    }
    seen.add(el);
    const el2 = {
      selector,
      tag: el.tagName.toLowerCase(),
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      inViewport: rect.top < window.innerHeight && rect.bottom > 0,
      label: clip(labelOf(el), ${MAX_LABEL}),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
    };
    if (el instanceof HTMLInputElement) {
      el2.type = el.type;
      if (el.type === 'text' || el.type === 'search') el2.value = el.value;
    }
    if (el instanceof HTMLSelectElement) {
      el2.options = [...el.options].slice(0, 20).map(o => ({ label: clip(o.textContent.trim(), 80), value: o.value, selected: o.selected, disabled: o.disabled }));
      el2.multiple = el.multiple || undefined;
    }
    elements.push(el2);
  }
  const text = clip(document.body ? document.body.innerText : '', ${MAX_SNAPSHOT_TEXT});
  return {
    url: location.href,
    title: document.title,
    scrollY: window.scrollY,
    maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    text,
    textTruncated: document.body && document.body.innerText.length > ${MAX_SNAPSHOT_TEXT},
    textTotalChars: document.body ? document.body.innerText.length : 0,
    elements,
    interactiveElementsOnPage: all.length,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
  function clip(t, n) { return t.length > n ? t.slice(0, n) : t; }
})()`;
var CLICK_SCRIPT = `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
  }
  return { found: true, label: (el.textContent || '').trim().slice(0, 80), url: location.href };
})`;
var TYPE_SCRIPT = `((sel, value) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  if (el.isContentEditable) {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, url: location.href };
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  if (!proto) return { found: true, notField: true };
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, url: location.href };
})`;
var SELECT_SCRIPT = `((sel, mode, value) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  if (!(el instanceof HTMLSelectElement)) return { found: false, notSelect: true };
  const opt = [...el.options].find(o => (mode === 'label' ? o.textContent.trim() === value : o.value === value));
  if (!opt) return { found: false };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, label: opt.textContent.trim(), value: opt.value, url: location.href };
})`;
var SCROLL_SCRIPT = `((sel, direction) => {
  const el = sel ? document.querySelector(sel) : null;
  const target = el || document.scrollingElement || document.documentElement;
  const before = window.scrollY;
  if (direction === 'top') target.scrollTop = 0;
  else if (direction === 'bottom') target.scrollTop = target.scrollHeight;
  else if (direction === 'up') target.scrollTop = Math.max(0, target.scrollTop - window.innerHeight);
  else target.scrollTop = target.scrollTop + window.innerHeight;
  return {
    scrollY: window.scrollY,
    maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    scrolledTo: el ? sel : undefined,
  };
})`;
var INSPECT_SCRIPT = `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  const cs = window.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const keys = ['display','position','width','height','color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','textAlign','margin','padding','border','borderRadius','opacity','zIndex','overflow','transform'];
  const styles = {};
  for (const k of keys) styles[k] = cs.getPropertyValue(k);
  return { found: true, tag: el.tagName.toLowerCase(), label: (el.textContent || '').trim().slice(0, 80),
    bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    inViewport: r.top < window.innerHeight && r.bottom > 0, styles };
})`;
async function runAction(manager2, request, auth, { ensureAuthorized: ensureAuthorized2 }) {
  const { action, parameters, context } = request;
  try {
    if (!ensureAuthorized2(context)) {
      return fail(
        "\u672C\u4F1A\u8BDD\u5C1A\u672A\u6388\u6743\u4F7F\u7528\u6D4F\u89C8\u5668\u3002\u8BF7\u5148\u7528\u9009\u62E9\u9898\u8BE2\u95EE\u7528\u6237\u300C\u662F\u5426\u5141\u8BB8\u672C\u6B21\u5BF9\u8BDD\u62C9\u8D77\u5E76\u64CD\u4F5C\u6D4F\u89C8\u5668\u300D\uFF0C\u7528\u6237\u540C\u610F\u540E\u8C03\u7528 browser_bridge_authorize \u5DE5\u5177\u5199\u5165\u6388\u6743\uFF0C\u518D\u91CD\u8BD5\u672C\u64CD\u4F5C\u3002\u7528\u6237\u62D2\u7EDD\u5219\u544A\u77E5\u65E0\u6CD5\u6267\u884C\u6D4F\u89C8\u5668\u64CD\u4F5C\u3002"
      );
    }
    if (action === "browser.open") {
      const exeStatus = auth.exeStatus;
      if (!exeStatus.exists) {
        return fail(
          `\u6D4F\u89C8\u5668\u672A\u5B89\u88C5\uFF1A\u627E\u4E0D\u5230 ${exeStatus.path}\u3002` + (exeStatus.isDefault ? "\u9ED8\u8BA4\u6D4F\u89C8\u5668\u662F ungoogled-chromium\uFF0C\u5B89\u88C5\u6307\u5F15\uFF1A\u5230 github.com/ungoogled-chromium/ungoogled-chromium-windows \u7684 Releases \u4E0B\u8F7D Windows x64 \u4FBF\u643A\u7248\uFF0C\u6838\u5BF9\u9875\u9762 SHA256 \u540E\u89E3\u538B\u5230 C:\\UserProgram\\ungoogled-chromium\uFF1B\u6216\u5728\u6269\u5C55\u9762\u677F\u91CC\u628A\u6D4F\u89C8\u5668\u8DEF\u5F84\u6539\u6210\u672C\u673A\u4EFB\u610F Chromium \u5185\u6838\u6D4F\u89C8\u5668\uFF08Edge/Chrome/Vivaldi \u7684 exe \u8DEF\u5F84\uFF09\u3002" : `\u8BF7\u5230\u6269\u5C55\u9762\u677F\u6838\u5BF9\u6D4F\u89C8\u5668\u8DEF\u5F84\u8BBE\u7F6E\uFF08\u5F53\u524D\u6307\u5411 ${exeStatus.path}\uFF0C\u6587\u4EF6\u4E0D\u5B58\u5728\uFF09\u3002`)
        );
      }
      await manager2.start();
    } else {
      if (!manager2.ws) {
        const exeStatus = auth.exeStatus;
        if (!exeStatus.exists) {
          return fail(`\u6D4F\u89C8\u5668\u672A\u5B89\u88C5\uFF1A\u627E\u4E0D\u5230 ${exeStatus.path}\u3002\u8BF7\u5728\u6269\u5C55\u9762\u677F\u91CC\u6838\u5BF9\u6D4F\u89C8\u5668\u8DEF\u5F84\u3002`);
        }
        await manager2.start();
      }
    }
    switch (action) {
      case "browser.open":
        return await actOpen(manager2, parameters);
      case "browser.snapshot":
        return await actSnapshot(manager2, parameters);
      case "browser.click":
        return await actClick(manager2, parameters);
      case "browser.type":
        return await actType(manager2, parameters);
      case "browser.select":
        return await actSelect(manager2, parameters);
      case "browser.scroll":
        return await actScroll(manager2, parameters);
      case "browser.back":
        return await actHistory(manager2, parameters, "back");
      case "browser.forward":
        return await actHistory(manager2, parameters, "forward");
      case "browser.inspect":
        return await actInspect(manager2, parameters);
      case "browser.capture":
        return await actCapture(manager2, parameters);
      case "browser.resize":
        return await actResize(manager2, parameters);
      case "browser.close":
        return await actClose(manager2, parameters);
      default:
        return fail(`\u672A\u77E5\u52A8\u4F5C\uFF1A${action}`);
    }
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message);
    return fail(err.message || String(err));
  }
}
async function targetEntry(manager2, parameters) {
  if (parameters.tabId) {
    const entry = manager2.sessionFor(parameters.tabId);
    if (!entry) {
      throw new ActionError(`tabId\u300C${parameters.tabId}\u300D\u4E0D\u5B58\u5728\u6216\u5DF2\u5173\u95ED\uFF1B\u8BF7\u5148 browser.snapshot \u62FF\u5F53\u524D\u6807\u7B7E\u6E05\u5355`);
    }
    manager2.markActive(entry);
    return entry;
  }
  const active = manager2.activeSession();
  if (active) {
    manager2.markActive(active);
    return active;
  }
  const fresh = await manager2.acquirePage();
  manager2.markActive(fresh);
  return fresh;
}
async function actOpen(manager2, params) {
  let url = String(params.url || "");
  if (!/^https?:\/\//i.test(url)) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  }
  const startedAt = Date.now();
  const entry = params.tabId ? manager2.sessionFor(params.tabId) : null;
  let used;
  if (entry) {
    await manager2.navigate(entry, url);
    used = entry;
  } else {
    const active = manager2.activeSession();
    if (active) {
      await manager2.navigate(active, url);
      used = active;
    } else {
      const fresh = await manager2.acquirePage();
      await manager2.navigate(fresh, url);
      used = fresh;
    }
  }
  manager2.markActive(used);
  const info = await pageBasics(manager2, used);
  if (params.viewport) await applyViewport(manager2, used, params.viewport);
  const settled = info.settled && Date.now() - startedAt < HOST_OPEN_BUDGET_MS;
  return done({
    tabId: used.sessionId,
    url: info.url,
    title: info.title,
    opened: true,
    settled,
    viewport: summarizeViewport(info.width, info.height)
  });
}
async function pageBasics(manager2, entry) {
  const data = await manager2.evaluate(entry, `JSON.stringify({url: location.href, title: document.title, ready: document.readyState, w: innerWidth, h: innerHeight})`);
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = { url: entry.url, title: "", ready: "complete", w: 0, h: 0 };
  }
  return { url: parsed.url, title: parsed.title, settled: parsed.ready === "complete", width: parsed.w, height: parsed.h };
}
async function actSnapshot(manager2, params) {
  const entry = await targetEntry(manager2, params);
  const raw = await manager2.evaluate(entry, PROBE_SCRIPT, 15e3);
  let probe;
  try {
    probe = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("\u5FEB\u7167\u89E3\u6790\u5931\u8D25");
  }
  let scope = "document";
  if (params.selector) {
    scope = String(params.selector);
    const sub = await manager2.evaluate(entry, `(() => {
      const el = document.querySelector(${JSON.stringify(scope)});
      if (!el) return null;
      const text = (el.innerText || '').slice(0, ${MAX_SNAPSHOT_TEXT});
      return JSON.stringify({ text, url: location.href, title: document.title, w: innerWidth, h: innerHeight, sy: window.scrollY,
        max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) });
    })()`);
    if (sub === null) throw new ActionError(`\u6CA1\u6709\u5143\u7D20\u5339\u914D ${scope}`);
    const subParsed = JSON.parse(sub);
    probe.text = subParsed.text;
    probe.url = subParsed.url;
    probe.title = subParsed.title;
    probe.viewport = { width: subParsed.w, height: subParsed.h };
    probe.scrollY = subParsed.sy;
    probe.maxScrollY = subParsed.max;
  }
  const tabs = [];
  for (const [sid, s] of manager2.sessions) {
    tabs.push({ id: sid, title: s.title || probe.title, url: s.url, active: sid === entry.sessionId });
  }
  entry.title = probe.title;
  entry.url = probe.url;
  return done({
    url: probe.url,
    title: probe.title,
    scope,
    scrollY: probe.scrollY,
    maxScrollY: probe.maxScrollY,
    text: probe.text,
    elements: probe.elements,
    textTruncated: probe.textTruncated || void 0,
    textTotalChars: probe.textTotalChars,
    elementsTruncated: probe.interactiveElementsOnPage > probe.elements.length || void 0,
    interactiveElementsOnPage: probe.interactiveElementsOnPage,
    viewport: summarizeViewport(probe.viewport.width, probe.viewport.height),
    tabs: tabs.length ? tabs : void 0
  });
}
async function actClick(manager2, params) {
  let selector = params.selector ? String(params.selector) : null;
  if (!selector && !params.text) {
    throw new ActionError(
      "browser.click \u9700\u8981 selector \u6216 text\u3002" + (params.ref ? `\u63D0\u4F9B\u8005\u4E0D\u4F7F\u7528 ref\uFF08\u6536\u5230 ${params.ref}\uFF09\uFF1A\u8BF7\u5148 browser.snapshot\uFF0C\u7528\u8FD4\u56DE\u5143\u7D20\u91CC\u7684 selector \u518D\u70B9\u51FB\u3002` : "")
    );
  }
  if (!selector && params.text) {
    const found = await manager2.evaluate(await targetEntry(manager2, params), `(() => {
      const txt = ${JSON.stringify(String(params.text))};
      const cands = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,[onclick]')];
      const el = cands.find(e => (e.textContent || '').trim().replace(/\\s+/g,' ') === txt)
        || cands.find(e => (e.textContent || '').trim().replace(/\\s+/g,' ').includes(txt));
      if (!el) return null;
      if (el.id) return '#' + CSS.escape(el.id);
      // \u8DEF\u5F84 selector
      const path = []; let node = el;
      while (node && node.nodeType === 1 && path.length < 6) {
        const parent = node.parentElement;
        if (!parent) { path.unshift(node.tagName.toLowerCase()); break; }
        const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
        path.unshift(node.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(node)+1) + ')' : ''));
        node = parent;
      }
      return path.join('>');
    })()`);
    if (!found) throw new ActionError(`\u6CA1\u6709\u53EF\u70B9\u51FB\u5143\u7D20\u5339\u914D\u6587\u672C\u300C${params.text}\u300D`);
    selector = found;
  }
  if (!selector) throw new ActionError("browser.click \u9700\u8981 selector \u6216 text");
  const entry = await targetEntry(manager2, params);
  const raw = await manager2.evaluate(entry, `(${CLICK_SCRIPT})(${JSON.stringify(selector)})`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { found: raw === true };
  }
  if (!parsed || !parsed.found) throw new ActionError(`\u6CA1\u6709\u5143\u7D20\u5339\u914D ${selector}`);
  return done({ clicked: selector, label: parsed.label || "", url: parsed.url || "" });
}
async function actType(manager2, params) {
  const selector = requireSelector(params, "browser.type");
  const entry = await targetEntry(manager2, params);
  const raw = await manager2.evaluate(entry, `(${TYPE_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(String(params.value ?? ""))})`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.found) throw new ActionError(`\u6CA1\u6709\u5143\u7D20\u5339\u914D ${selector}`);
  if (params.submit) {
    await manager2.evaluate(entry, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    })()`);
  }
  return done({ selector, url: parsed.url || "" });
}
async function actSelect(manager2, params) {
  const selector = requireSelector(params, "browser.select");
  if (!params.label && params.value === void 0) {
    throw new ActionError("browser.select \u9700\u8981 label \u6216 value \u4E4B\u4E00");
  }
  const mode = params.label ? "label" : "value";
  const value = String(mode === "label" ? params.label : params.value);
  const entry = await targetEntry(manager2, params);
  const raw = await manager2.evaluate(entry, `(${SELECT_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(mode)}, ${JSON.stringify(value)})`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.found) {
    if (parsed && parsed.notSelect) throw new ActionError(`${selector} \u4E0D\u662F <select> \u5143\u7D20`);
    throw new ActionError(`${selector} \u91CC\u6CA1\u6709\u9009\u9879\u5339\u914D ${mode}\u300C${value}\u300D`);
  }
  return done({ selector, label: parsed.label || "", value: parsed.value || "", url: parsed.url || "" });
}
async function actScroll(manager2, params) {
  const direction = params.direction || "down";
  const selector = params.selector ? String(params.selector) : null;
  const entry = await targetEntry(manager2, params);
  if (selector) {
    await manager2.evaluate(entry, `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);
  }
  const raw = await manager2.evaluate(entry, `(${SCROLL_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(direction)})`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const scrollY = parsed ? parsed.scrollY : 0;
  const maxScrollY = parsed ? parsed.maxScrollY : 0;
  return done({
    scrollY,
    maxScrollY,
    atTop: scrollY <= 0,
    atBottom: scrollY >= maxScrollY,
    scrolledTo: selector || void 0,
    direction: selector ? void 0 : direction
  });
}
async function actHistory(manager2, params, dir) {
  const entry = await targetEntry(manager2, params);
  const info = await manager2.evaluate(entry, `history.${dir}(); 'ok'`).catch(() => "ok");
  await new Promise((r) => setTimeout(r, 400));
  const basics = await pageBasics(manager2, entry);
  return done({ url: basics.url, title: basics.title });
}
async function actInspect(manager2, params) {
  const selector = requireSelector(params, "browser.inspect");
  const entry = await targetEntry(manager2, params);
  const raw = await manager2.evaluate(entry, `(${INSPECT_SCRIPT})(${JSON.stringify(selector)})`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.found) throw new ActionError(`\u6CA1\u6709\u5143\u7D20\u5339\u914D ${selector}`);
  return done({
    selector,
    tag: parsed.tag,
    label: parsed.label || "",
    bounds: parsed.bounds,
    inViewport: Boolean(parsed.inViewport),
    styles: parsed.styles || {}
  });
}
async function actCapture(manager2, params) {
  const entry = await targetEntry(manager2, params);
  const buf = await manager2.capture(entry);
  const basics = await pageBasics(manager2, entry);
  const width = buf.length ? readPngWidth(buf) : basics.width;
  const height = buf.length ? readPngHeight(buf) : basics.height;
  return done({
    base64: buf.toString("base64"),
    mime: "image/png",
    width,
    height,
    url: basics.url,
    title: basics.title,
    viewport: summarizeViewport(width, height)
  });
}
function readPngWidth(buf) {
  return buf.length > 24 ? buf.readUInt32BE(16) : 0;
}
function readPngHeight(buf) {
  return buf.length > 24 ? buf.readUInt32BE(20) : 0;
}
async function actResize(manager2, params) {
  const entry = await targetEntry(manager2, params);
  const viewport = params.viewport || "desktop";
  const size = await applyViewport(manager2, entry, viewport);
  const basics = await pageBasics(manager2, entry);
  return done({ viewport: summarizeViewport(basics.width || size.width, basics.height || size.height) });
}
async function applyViewport(manager2, entry, mode) {
  const size = MODE_SIZES[mode] || MODE_SIZES.desktop;
  if (mode === "fill") {
    await manager2.send("Emulation.clearDeviceMetricsOverride", {}, entry.sessionId);
    const basics = await pageBasics(manager2, entry);
    return { width: basics.width, height: basics.height };
  }
  await manager2.send("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: mode === "mobile"
  }, entry.sessionId);
  return size;
}
async function actClose(manager2, params) {
  let entry;
  if (params.tabId) {
    entry = manager2.sessionFor(params.tabId);
    if (!entry) throw new ActionError(`tabId\u300C${params.tabId}\u300D\u4E0D\u5B58\u5728`);
  } else {
    entry = manager2.activeSession();
    if (!entry) throw new ActionError("\u5F53\u524D\u6CA1\u6709\u53D7\u63A7\u6807\u7B7E\u53EF\u5173");
  }
  await manager2.send("Target.closeTarget", { targetId: entry.targetId });
  manager2.sessions.delete(entry.sessionId);
  if (manager2.activeSessionId === entry.sessionId) manager2.activeSessionId = null;
  return done({ closed: true, tabId: entry.sessionId });
}

// service/main.js
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!PORT || !TOKEN) {
  console.error("[browser-bridge] missing OPENCHAMBER_SERVICE_PORT or OPENCHAMBER_SERVICE_TOKEN");
  process.exit(1);
}
var BROWSER_ACTIONS = /* @__PURE__ */ new Set([
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
]);
var manager = null;
function getManager() {
  if (!manager) {
    const settings = readSettings();
    manager = new BrowserManager({ exePath: settings.browserPath, profileDir: resolveProfileDir(settings) });
    manager.onChange(() => {
    });
  }
  return manager;
}
function ensureAuthorized(context) {
  const sessionId = context && context.sessionId ? String(context.sessionId) : "";
  return isAuthorized(sessionId || null);
}
function statusPayload() {
  const settings = readSettings();
  const exeStatus = browserExecutableStatus(settings);
  const auth = readAuthorization();
  const authorized = auth ? Date.now() - auth.at <= AUTH_TTL_MS : false;
  const m = manager ? manager.describe() : { running: false, pages: [] };
  return {
    settings: { browserPath: settings.browserPath, profileDir: resolveProfileDir(settings), defaultBrowser: exeStatus.isDefault },
    browserExe: exeStatus,
    authorization: { authorized, sessionId: auth ? auth.sessionId : null, at: auth ? auth.at : null },
    browser: m
  };
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store"
  });
  res.end(text);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
var server = http.createServer(async (req, res) => {
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "POST" && url.pathname === "/browser-control") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F JSON" });
        return;
      }
      if (!parsed || typeof parsed.action !== "string" || !BROWSER_ACTIONS.has(parsed.action)) {
        sendJson(res, 400, { ok: false, error: "\u4E0D\u662F\u5408\u6CD5\u7684 browser.* \u52A8\u4F5C" });
        return;
      }
      const result = await runAction(getManager(), parsed, { exeStatus: browserExecutableStatus(readSettings()) }, { ensureAuthorized });
      sendJson(res, 200, result);
      return;
    }
    if (url.pathname === "/ui/status" && req.method === "GET") {
      sendJson(res, 200, statusPayload());
      return;
    }
    if (url.pathname === "/ui/settings" && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "GET") {
        const settings2 = readSettings();
        sendJson(res, 200, { browserPath: settings2.browserPath, profileDir: settings2.profileDir });
        return;
      }
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "\u8BF7\u6C42\u4F53\u4E0D\u662F JSON" });
        return;
      }
      const patch = {};
      if (typeof parsed.browserPath === "string") patch.browserPath = parsed.browserPath.trim();
      if (typeof parsed.profileDir === "string") patch.profileDir = parsed.profileDir.trim();
      writeSettings(patch);
      if (manager && (patch.browserPath !== void 0 || patch.profileDir !== void 0)) {
        await manager.close();
        manager = null;
      }
      const settings = readSettings();
      sendJson(res, 200, { saved: true, settings: { browserPath: settings.browserPath, profileDir: settings.profileDir } });
      return;
    }
    if (url.pathname === "/ui/authorize" && req.method === "POST") {
      const body = await readBody(req);
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
      }
      if (parsed && parsed.revoke) {
        revokeAuthorization();
        sendJson(res, 200, { revoked: true });
      } else {
        const record = authorizeSession(parsed.sessionId || null);
        sendJson(res, 200, { authorized: true, at: record.at });
      }
      return;
    }
    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message || "\u670D\u52A1\u5185\u90E8\u9519\u8BEF" });
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[browser-bridge] service listening on 127.0.0.1:${PORT}`);
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2e3).unref();
});
