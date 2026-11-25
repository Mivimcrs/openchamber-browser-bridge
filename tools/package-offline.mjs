// 离线安装包：把扩展包 + 一键安装脚本 + 安装说明打成一个 zip，
// 给没有 git / npm 的机器用（解压后直接运行 install.ps1）。
//
// 产物：dist/openchamber-browser-bridge-<version>-setup.zip
// 结构：
//   openchamber-browser-bridge-<version>/
//     package.json, icon.svg, service/, plugin/, panel/, skills/, 文档/
//     LICENSE, README.md, CHANGELOG.md
//     install/install.ps1, install/README.md
//     offline-install.cmd      ← 双击即可（Windows）
import { createHash } from 'node:crypto'
import * as zlib from 'node:zlib'
import { readdir, readFile, stat, writeFile, mkdir, cp } from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from './_deps.mjs'

const deflateRawSync = zlib.deflateRawSync
const zlibCrc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null

const INCLUDE_DIRS = new Set(['service', 'plugin', 'panel', 'skills', '文档', 'install'])
const INCLUDE_FILES = new Set(['package.json', 'icon.svg', 'LICENSE', 'README.md', 'CHANGELOG.md', 'install/offline-install.cmd'])
const EXCLUDE_SUFFIX = ['.zip', '.log']

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()
const crc32 = typeof zlibCrc32 === 'function'
  ? (data) => zlibCrc32(data) >>> 0
  : (data) => {
    let crc = -1
    for (let i = 0; i < data.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff]
    return (crc ^ -1) >>> 0
  }

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff

async function walk(dir, rel = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (EXCLUDE_SUFFIX.some((suffix) => entry.name.endsWith(suffix))) continue
    if (entry.isDirectory()) {
      // 只在顶层按白名单挑目录，进去之后整棵收
      if (!rel && !INCLUDE_DIRS.has(entry.name)) continue
      out.push(...await walk(path.join(dir, entry.name), relPath))
      continue
    }
    if (rel) out.push(relPath)
    else if (INCLUDE_FILES.has(relPath)) out.push(relPath)
  }
  return out
}

function buildZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.rel, 'utf8')
    const packed = deflateRawSync(file.data, { level: 9 })
    const useDeflate = packed.length < file.data.length
    const body = useDeflate ? packed : file.data
    const crc = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(dosTime(file.mtime), 10)
    local.writeUInt16LE(dosDate(file.mtime), 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10)
    entry.writeUInt16LE(dosTime(file.mtime), 12)
    entry.writeUInt16LE(dosDate(file.mtime), 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(file.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}

const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const prefix = `openchamber-browser-bridge-${manifest.version}`

const rels = await walk(ROOT)
for (const required of ['package.json', 'service/bundle.js', 'panel/built.js', 'install/install.ps1', 'install/offline-install.cmd']) {
  if (!rels.includes(required)) throw new Error(`缺少 ${required}（先 npm run build）`)
}

const files = []
for (const rel of rels) {
  const full = path.join(ROOT, rel)
  files.push({ rel: `${prefix}/${rel}`, data: await readFile(full), mtime: (await stat(full)).mtime })
}

const zip = buildZip(files)
await mkdir(path.join(ROOT, 'dist'), { recursive: true })
const out = path.join(ROOT, 'dist', `${prefix}-setup.zip`)
await writeFile(out, zip)
const sha = createHash('sha256').update(zip).digest('hex').slice(0, 16)
console.log(`OK  ${out}`)
console.log(`entries=${files.length}  bytes=${zip.length}  version=${manifest.version}  sha256=${sha}…`)
for (const file of files) console.log(`  ${String(file.data.length).padStart(8)}  ${file.rel}`)
