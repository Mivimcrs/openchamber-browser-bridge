// 面板脚本：经 connectHost 调本扩展的服务。
// 构建：node tools/build-panel.mjs（esbuild 打到 panel/built.js）
import { connectHost } from '@openchamber/sdk'

const host = connectHost()

// 宿主的 serviceRequest 需要 { method, path, query, body }，body 必须是字符串
async function call(path, init) {
  const res = await host.serviceRequest({
    method: init?.method || 'GET',
    path,
    body: init?.body,
  })
  let data = null
  try {
    data = typeof res?.body === 'string' ? JSON.parse(res.body) : (res?.body ?? res)
  } catch { data = res }
  if (res && typeof res.status === 'number' && res.status >= 400) {
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  return data
}

const $ = (id) => document.getElementById(id)

async function refresh() {
  try {
    const st = await call('/ui/status')
    $('exe-path').value = st.settings.browserPath
    $('profile-dir').value = st.settings.profileDir || ''
    $('exe-badge').textContent = st.browserExe.exists ? '已安装' : '未找到'
    $('exe-badge').className = 'badge ' + (st.browserExe.exists ? 'ok' : 'bad')
    $('auth-badge').textContent = st.authorization.authorized ? '已授权' : '未授权'
    $('auth-badge').className = 'badge ' + (st.authorization.authorized ? 'ok' : 'idle')
    $('run-badge').textContent = st.browser.running ? `运行中（端口 ${st.browser.debugPort}）` : '未连接'
    $('run-badge').className = 'badge ' + (st.browser.running ? 'ok' : 'idle')
    $('pages').textContent = (st.browser.pages || []).map(p => p.title || p.url).join(' / ') || '（无受控页面）'
  } catch {
    $('run-badge').textContent = '服务不可达'
    $('run-badge').className = 'badge bad'
  }
}

$('save').addEventListener('click', async () => {
  try {
    await call('/ui/settings', {
      method: 'POST',
      body: JSON.stringify({
        browserPath: $('exe-path').value.trim(),
        profileDir: $('profile-dir').value.trim(),
      }),
    })
    await refresh()
  } catch (err) { alert('保存失败：' + err.message) }
})

$('revoke').addEventListener('click', async () => {
  try {
    await call('/ui/authorize', { method: 'POST', body: JSON.stringify({ revoke: true }) })
    await refresh()
  } catch (err) { alert('撤销失败：' + err.message) }
})

async function applyInitial() {
  await refresh()
  setInterval(refresh, 5000)
}

applyInitial()
