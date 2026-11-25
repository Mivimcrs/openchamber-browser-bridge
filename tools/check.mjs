// 发布前自检：清单完整、入口存在、脚本语法、没有本机路径/密钥泄漏。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, access } from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from './_deps.mjs'

const run = promisify(execFile)
const problems = []
const notes = []

const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) problems.push('package.json 的 version 不是 x.y.z')
if (!manifest.openchamber?.apiVersion) problems.push('package.json 缺少 openchamber.apiVersion')

const contributes = manifest.openchamber?.contributes || {}
if (!contributes.panel?.entry) problems.push('package.json 缺少 contributes.panel.entry')
if (!contributes.service?.entry) problems.push('package.json 缺少 contributes.service.entry')
if (!contributes.service?.provides?.includes('browser')) problems.push('service 必须 provides: ["browser"]')

const entries = [contributes.panel?.entry, contributes.service?.entry].filter(Boolean)
for (const entry of entries) {
  try { await access(path.join(ROOT, entry)) }
  catch { problems.push(`入口文件不存在：${entry}`) }
}

// 面板入口引用的脚本也必须存在
try {
  const html = await readFile(path.join(ROOT, contributes.panel.entry), 'utf8')
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const src = match[1]
    if (/^https?:/.test(src)) continue
    try { await access(path.join(ROOT, path.dirname(contributes.panel.entry), src)) }
    catch { problems.push(`面板引用的脚本不存在：${src}（先 npm run build:panel）`) }
  }
} catch { /* 上面已经报过入口缺失 */ }

async function* walk(dir, rel = '') {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.state', 'tmp-test-data', '.openchamber', '本地工具'].includes(item.name)) continue
    const relPath = rel ? `${rel}/${item.name}` : item.name
    if (item.isDirectory()) yield* walk(path.join(dir, item.name), relPath)
    else yield relPath
  }
}

const codeFiles = []
for await (const rel of walk(ROOT)) {
  if (!/\.(mjs|js)$/.test(rel)) continue
  codeFiles.push(rel)
  try { await run(process.execPath, ['--check', path.join(ROOT, rel)]) }
  catch (error) { problems.push(`语法检查失败：${rel}\n${error.stderr || error.message}`) }
}
notes.push(`语法检查通过：${codeFiles.length} 个文件`)

// 本机路径 / 明文密钥泄漏检查（本次构建的扩展不能带个人路径或凭据）
const LEAK = [/:\\Users\\(?!你)/i, /:\/Users\/(?!你)/i, /gh[pousr]_[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9]{20,}/]
for await (const rel of walk(ROOT)) {
  if (!/\.(mjs|js|json|md|html|yml|yaml)$/.test(rel)) continue
  if (rel.startsWith('tools/')) continue
  const text = await readFile(path.join(ROOT, rel), 'utf8')
  for (const pattern of LEAK) {
    if (pattern.test(text)) problems.push(`疑似泄漏本机路径或密钥：${rel}（${pattern}）`)
  }
}

const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8').catch(() => '')
if (!readme) problems.push('缺少 README.md')
else {
  const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8').catch(() => '')
  if (!changelog.includes(manifest.version)) notes.push(`提示：CHANGELOG.md 里没写当前版本 ${manifest.version}`)
}

if (problems.length) {
  console.error(`自检失败（${problems.length} 项）`)
  for (const item of problems) console.error(`- ${item}`)
  process.exit(1)
}

console.log(`OK  version=${manifest.version}`)
for (const note of notes) console.log(`- ${note}`)
