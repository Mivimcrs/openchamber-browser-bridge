// 13 个 browser.* 动作 → CDP/页面脚本 翻译层。
// 返回 BrowserProviderResult 形状（ok:true+data / ok:false+error），失败永远 200。

const MODE_SIZES = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
  fill: null,
}

const MAX_SNAPSHOT_ELEMENTS = 300
const MAX_SNAPSHOT_TEXT = 20_000
const MAX_LABEL = 120
/** 宿主的 browser.open 预算 45 秒；留 15 秒余量判定"慢页" */
const HOST_OPEN_BUDGET_MS = 30_000

export class ActionError extends Error {}

function fail(error) { return { ok: false, error } }
function done(data) { return { ok: true, data } }

function summarizeViewport(width, height) {
  for (const mode of Object.keys(MODE_SIZES)) {
    const size = MODE_SIZES[mode]
    if (size && size.width === width && size.height === height) return { mode, width, height }
  }
  return { mode: 'custom', width, height }
}

function requireSelector(params, action) {
  if (!params.selector || !String(params.selector).trim()) {
    throw new ActionError(`${action} 需要一个 CSS selector（参数 selector）`)
  }
  return String(params.selector)
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) : text
}

// ---------- 页面内探测脚本（字符串注入，返回 JSON） ----------

// 交互元素收集 + 文本抽取。bounds 相对视口。
const PROBE_SCRIPT = `(() => {
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
    // 计算一个稳定 selector
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
})()`

// 点击：优先真实坐标鼠标事件（覆盖多数 SPA），失败回落 el.click()
const CLICK_SCRIPT = `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
  }
  return { found: true, label: (el.textContent || '').trim().slice(0, 80), url: location.href };
})`

// 输入：React/Vue 兼容的替换式写值
const TYPE_SCRIPT = `((sel, value) => {
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
})`

const SELECT_SCRIPT = `((sel, mode, value) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  if (!(el instanceof HTMLSelectElement)) return { found: false, notSelect: true };
  const opt = [...el.options].find(o => (mode === 'label' ? o.textContent.trim() === value : o.value === value));
  if (!opt) return { found: false };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, label: opt.textContent.trim(), value: opt.value, url: location.href };
})`

const SCROLL_SCRIPT = `((sel, direction) => {
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
})`

const INSPECT_SCRIPT = `((sel) => {
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
})`

// ---------- 动作实现 ----------

export async function runAction(manager, request, auth, { ensureAuthorized }) {
  const { action, parameters, context } = request
  try {
    // 授权门：所有动作都要过；browser.open 是唯一入口动作
    if (!ensureAuthorized(context)) {
      return fail(
        '本会话尚未授权使用浏览器。' +
        '请先用选择题询问用户「是否允许本次对话拉起并操作浏览器」，' +
        '用户同意后调用 browser_bridge_authorize 工具写入授权，再重试本操作。' +
        '用户拒绝则告知无法执行浏览器操作。'
      )
    }

    // 浏览器可用性检查（仅入口动作做，省得每个动作都 stat）
    if (action === 'browser.open') {
      const exeStatus = auth.exeStatus
      if (!exeStatus.exists) {
        return fail(
          `浏览器未安装：找不到 ${exeStatus.path}。` +
          (exeStatus.isDefault
            ? '默认浏览器是 ungoogled-chromium，安装指引：到 github.com/ungoogled-chromium/ungoogled-chromium-windows 的 Releases 下载 Windows x64 便携版，核对页面 SHA256 后解压到 C:\\UserProgram\\ungoogled-chromium；或在扩展面板里把浏览器路径改成本机任意 Chromium 内核浏览器（Edge/Chrome/Vivaldi 的 exe 路径）。'
            : `请到扩展面板核对浏览器路径设置（当前指向 ${exeStatus.path}，文件不存在）。`)
        )
      }
      await manager.start()
    } else {
      if (!manager.ws) {
        // 非入口动作时浏览器没连着：先尝试拉起（授权已过）
        const exeStatus = auth.exeStatus
        if (!exeStatus.exists) {
          return fail(`浏览器未安装：找不到 ${exeStatus.path}。请在扩展面板里核对浏览器路径。`)
        }
        await manager.start()
      }
    }

    switch (action) {
      case 'browser.open': return await actOpen(manager, parameters)
      case 'browser.snapshot': return await actSnapshot(manager, parameters)
      case 'browser.click': return await actClick(manager, parameters)
      case 'browser.type': return await actType(manager, parameters)
      case 'browser.select': return await actSelect(manager, parameters)
      case 'browser.scroll': return await actScroll(manager, parameters)
      case 'browser.back': return await actHistory(manager, parameters, 'back')
      case 'browser.forward': return await actHistory(manager, parameters, 'forward')
      case 'browser.inspect': return await actInspect(manager, parameters)
      case 'browser.capture': return await actCapture(manager, parameters)
      case 'browser.resize': return await actResize(manager, parameters)
      case 'browser.close': return await actClose(manager, parameters)
      default: return fail(`未知动作：${action}`)
    }
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message)
    return fail(err.message || String(err))
  }
}

async function targetEntry(manager, parameters) {
  if (parameters.tabId) {
    const entry = manager.sessionFor(parameters.tabId)
    if (!entry) {
      throw new ActionError(`tabId「${parameters.tabId}」不存在或已关闭；请先 browser.snapshot 拿当前标签清单`)
    }
    manager.markActive(entry)
    return entry
  }
  const active = manager.activeSession()
  if (active) {
    manager.markActive(active)
    return active
  }
  const fresh = await manager.acquirePage()
  manager.markActive(fresh)
  return fresh
}

async function actOpen(manager, params) {
  let url = String(params.url || '')
  if (!/^https?:\/\//i.test(url)) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url
  }
  const startedAt = Date.now()
  const entry = params.tabId ? manager.sessionFor(params.tabId) : null
  let used
  if (entry) {
    await manager.navigate(entry, url)
    used = entry
  } else {
    const active = manager.activeSession()
    if (active) {
      await manager.navigate(active, url)
      used = active
    } else {
      const fresh = await manager.acquirePage()
      await manager.navigate(fresh, url)
      used = fresh
    }
  }
  manager.markActive(used)
  const info = await pageBasics(manager, used)
  if (params.viewport) await applyViewport(manager, used, params.viewport)
  // 宿主的 browser.open 预算是 45 秒，留出余量；慢页不判失败，settled:false
  const settled = info.settled && Date.now() - startedAt < HOST_OPEN_BUDGET_MS
  return done({
    tabId: used.sessionId,
    url: info.url,
    title: info.title,
    opened: true,
    settled,
    viewport: summarizeViewport(info.width, info.height),
  })
}

async function pageBasics(manager, entry) {
  const data = await manager.evaluate(entry, `JSON.stringify({url: location.href, title: document.title, ready: document.readyState, w: innerWidth, h: innerHeight})`)
  let parsed
  try { parsed = JSON.parse(data) } catch { parsed = { url: entry.url, title: '', ready: 'complete', w: 0, h: 0 } }
  return { url: parsed.url, title: parsed.title, settled: parsed.ready === 'complete', width: parsed.w, height: parsed.h }
}

async function actSnapshot(manager, params) {
  const entry = await targetEntry(manager, params)
  const raw = await manager.evaluate(entry, PROBE_SCRIPT, 15_000)
  let probe
  try { probe = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { throw new Error('快照解析失败') }

  // scope：selector 有值时截取该子树
  let scope = 'document'
  if (params.selector) {
    scope = String(params.selector)
    const sub = await manager.evaluate(entry, `(() => {
      const el = document.querySelector(${JSON.stringify(scope)});
      if (!el) return null;
      const text = (el.innerText || '').slice(0, ${MAX_SNAPSHOT_TEXT});
      return JSON.stringify({ text, url: location.href, title: document.title, w: innerWidth, h: innerHeight, sy: window.scrollY,
        max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) });
    })()`)
    if (sub === null) throw new ActionError(`没有元素匹配 ${scope}`)
    const subParsed = JSON.parse(sub)
    probe.text = subParsed.text
    probe.url = subParsed.url
    probe.title = subParsed.title
    probe.viewport = { width: subParsed.w, height: subParsed.h }
    probe.scrollY = subParsed.sy
    probe.maxScrollY = subParsed.max
  }

  // 标签清单：浏览器所有 page 目标
  const tabs = []
  for (const [sid, s] of manager.sessions) {
    tabs.push({ id: sid, title: s.title || probe.title, url: s.url, active: sid === entry.sessionId })
  }
  // 刷新当前页的 title/url，让标签清单不至于永远显示打开时的值
  entry.title = probe.title
  entry.url = probe.url

  return done({
    url: probe.url,
    title: probe.title,
    scope,
    scrollY: probe.scrollY,
    maxScrollY: probe.maxScrollY,
    text: probe.text,
    elements: probe.elements,
    textTruncated: probe.textTruncated || undefined,
    textTotalChars: probe.textTotalChars,
    elementsTruncated: probe.interactiveElementsOnPage > probe.elements.length || undefined,
    interactiveElementsOnPage: probe.interactiveElementsOnPage,
    viewport: summarizeViewport(probe.viewport.width, probe.viewport.height),
    tabs: tabs.length ? tabs : undefined,
  })
}

async function actClick(manager, params) {
  let selector = params.selector ? String(params.selector) : null
  if (!selector && !params.text) {
    throw new ActionError(
      'browser.click 需要 selector 或 text。' +
      (params.ref ? `提供者不使用 ref（收到 ${params.ref}）：请先 browser.snapshot，用返回元素里的 selector 再点击。` : '')
    )
  }
  if (!selector && params.text) {
    // 按可见文本定位
    const found = await manager.evaluate(await targetEntry(manager, params), `(() => {
      const txt = ${JSON.stringify(String(params.text))};
      const cands = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,[onclick]')];
      const el = cands.find(e => (e.textContent || '').trim().replace(/\\s+/g,' ') === txt)
        || cands.find(e => (e.textContent || '').trim().replace(/\\s+/g,' ').includes(txt));
      if (!el) return null;
      if (el.id) return '#' + CSS.escape(el.id);
      // 路径 selector
      const path = []; let node = el;
      while (node && node.nodeType === 1 && path.length < 6) {
        const parent = node.parentElement;
        if (!parent) { path.unshift(node.tagName.toLowerCase()); break; }
        const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
        path.unshift(node.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(node)+1) + ')' : ''));
        node = parent;
      }
      return path.join('>');
    })()`)
    if (!found) throw new ActionError(`没有可点击元素匹配文本「${params.text}」`)
    selector = found
  }
  if (!selector) throw new ActionError('browser.click 需要 selector 或 text')
  const entry = await targetEntry(manager, params)
  const raw = await manager.evaluate(entry, `(${CLICK_SCRIPT})(${JSON.stringify(selector)})`)
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = { found: raw === true } }
  if (!parsed || !parsed.found) throw new ActionError(`没有元素匹配 ${selector}`)
  return done({ clicked: selector, label: parsed.label || '', url: parsed.url || '' })
}

async function actType(manager, params) {
  const selector = requireSelector(params, 'browser.type')
  const entry = await targetEntry(manager, params)
  const raw = await manager.evaluate(entry, `(${TYPE_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(String(params.value ?? ''))})`)
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (!parsed || !parsed.found) throw new ActionError(`没有元素匹配 ${selector}`)
  if (params.submit) {
    await manager.evaluate(entry, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    })()`)
  }
  return done({ selector, url: parsed.url || '' })
}

async function actSelect(manager, params) {
  const selector = requireSelector(params, 'browser.select')
  if (!params.label && params.value === undefined) {
    throw new ActionError('browser.select 需要 label 或 value 之一')
  }
  const mode = params.label ? 'label' : 'value'
  const value = String(mode === 'label' ? params.label : params.value)
  const entry = await targetEntry(manager, params)
  const raw = await manager.evaluate(entry, `(${SELECT_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(mode)}, ${JSON.stringify(value)})`)
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (!parsed || !parsed.found) {
    if (parsed && parsed.notSelect) throw new ActionError(`${selector} 不是 <select> 元素`)
    throw new ActionError(`${selector} 里没有选项匹配 ${mode}「${value}」`)
  }
  return done({ selector, label: parsed.label || '', value: parsed.value || '', url: parsed.url || '' })
}

async function actScroll(manager, params) {
  const direction = params.direction || 'down'
  const selector = params.selector ? String(params.selector) : null
  const entry = await targetEntry(manager, params)
  if (selector) {
    await manager.evaluate(entry, `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`)
  }
  const raw = await manager.evaluate(entry, `(${SCROLL_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(direction)})`)
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const scrollY = parsed ? parsed.scrollY : 0
  const maxScrollY = parsed ? parsed.maxScrollY : 0
  return done({
    scrollY,
    maxScrollY,
    atTop: scrollY <= 0,
    atBottom: scrollY >= maxScrollY,
    scrolledTo: selector || undefined,
    direction: selector ? undefined : direction,
  })
}

async function actHistory(manager, params, dir) {
  const entry = await targetEntry(manager, params)
  const info = await manager.evaluate(entry, `history.${dir}(); 'ok'`).catch(() => 'ok')
  await new Promise(r => setTimeout(r, 400))
  const basics = await pageBasics(manager, entry)
  return done({ url: basics.url, title: basics.title })
}

async function actInspect(manager, params) {
  const selector = requireSelector(params, 'browser.inspect')
  const entry = await targetEntry(manager, params)
  const raw = await manager.evaluate(entry, `(${INSPECT_SCRIPT})(${JSON.stringify(selector)})`)
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (!parsed || !parsed.found) throw new ActionError(`没有元素匹配 ${selector}`)
  return done({
    selector,
    tag: parsed.tag,
    label: parsed.label || '',
    bounds: parsed.bounds,
    inViewport: Boolean(parsed.inViewport),
    styles: parsed.styles || {},
  })
}

async function actCapture(manager, params) {
  const entry = await targetEntry(manager, params)
  // CDP 截图不要求窗口前台（captureVisibleTab 才要求），不抢用户焦点
  const buf = await manager.capture(entry)
  const basics = await pageBasics(manager, entry)
  const width = buf.length ? readPngWidth(buf) : basics.width
  const height = buf.length ? readPngHeight(buf) : basics.height
  return done({
    base64: buf.toString('base64'),
    mime: 'image/png',
    width,
    height,
    url: basics.url,
    title: basics.title,
    viewport: summarizeViewport(width, height),
  })
}

function readPngWidth(buf) {
  return buf.length > 24 ? buf.readUInt32BE(16) : 0
}
function readPngHeight(buf) {
  return buf.length > 24 ? buf.readUInt32BE(20) : 0
}

async function actResize(manager, params) {
  const entry = await targetEntry(manager, params)
  const viewport = params.viewport || 'desktop'
  const size = await applyViewport(manager, entry, viewport)
  // 覆盖后读一次真实内尺寸，保证回报与快照一致
  const basics = await pageBasics(manager, entry)
  return done({ viewport: summarizeViewport(basics.width || size.width, basics.height || size.height) })
}

async function applyViewport(manager, entry, mode) {
  const size = MODE_SIZES[mode] || MODE_SIZES.desktop
  if (mode === 'fill') {
    // 清除覆盖
    await manager.send('Emulation.clearDeviceMetricsOverride', {}, entry.sessionId)
    const basics = await pageBasics(manager, entry)
    return { width: basics.width, height: basics.height }
  }
  await manager.send('Emulation.setDeviceMetricsOverride', {
    width: size.width, height: size.height, deviceScaleFactor: 1, mobile: mode === 'mobile',
  }, entry.sessionId)
  return size
}

async function actClose(manager, params) {
  let entry
  if (params.tabId) {
    entry = manager.sessionFor(params.tabId)
    if (!entry) throw new ActionError(`tabId「${params.tabId}」不存在`)
  } else {
    // 当前活跃的受控页
    entry = manager.activeSession()
    if (!entry) throw new ActionError('当前没有受控标签可关')
  }
  await manager.send('Target.closeTarget', { targetId: entry.targetId })
  manager.sessions.delete(entry.sessionId)
  if (manager.activeSessionId === entry.sessionId) manager.activeSessionId = null
  return done({ closed: true, tabId: entry.sessionId })
}
