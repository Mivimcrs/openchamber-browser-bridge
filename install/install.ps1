# One-shot installer for OpenChamber-Browser-bridge (Windows).
#
# Usage (from the repo root, or from an unzipped release):
#   powershell -ExecutionPolicy Bypass -File install\install.ps1
#
# Options:
#   -ConfigDir <path>   OpenChamber config dir (default: ~/.config/openchamber)
#   -Source <path>      Package root to install (default: repo root next to install\)
#   -Grant              Pre-write capability grants (service/skills/opencodePlugin).
#                       Off by default: OpenChamber asks you to approve them once.
#
# The script only touches:
#   <ConfigDir>\extensions\browser-bridge\        (copied package)
#   <ConfigDir>\extensions.json                   (path entry)
#   <ConfigDir>\settings.json                     (browserProvider = browser-bridge)
#
# It never deletes other extensions and never touches their settings.

param(
  [string]$ConfigDir = (Join-Path $HOME '.config\openchamber'),
  [string]$Source = '',
  [switch]$Grant
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

function Read-Json([string]$path) {
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  return $text | ConvertFrom-Json
}

function Write-Json([string]$path, $value) {
  $text = $value | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($path, $text + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

if (-not $Source) {
  $Source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

Write-Host 'OpenChamber-Browser-bridge installer' -ForegroundColor Cyan
Write-Host "  source      : $Source"
Write-Host "  config dir  : $ConfigDir"

if (-not (Test-Path (Join-Path $Source 'package.json'))) {
  Fail "package.json not found in $Source. Run this script from the repository root."
}
if (-not (Test-Path (Join-Path $Source 'service\bundle.js'))) {
  Fail "service\bundle.js is missing. Use a release zip, or run 'npm run build' first."
}
if (-not (Test-Path (Join-Path $ConfigDir 'extensions.json'))) {
  Fail "OpenChamber config not found at $ConfigDir. Start OpenChamber once, then run this again."
}

$target = Join-Path $ConfigDir 'extensions\browser-bridge'
Write-Host "  install to  : $target"

# ---- 1. copy the package (every top-level entry the host needs) ----
# Directory names are resolved from the filesystem, not written as literals,
# so non-ASCII folder names survive any console code page.
$skip = @('tools', 'tests', 'install', 'dist', 'node_modules', '.git', '.github', '.state', '.openchamber', 'tmp-test-data', '本地工具')
$skipFiles = @('.gitignore', '.gitattributes', 'package-lock.json', '踩坑日志.md')

if (Test-Path $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Path $target -Force | Out-Null

foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
  if ($entry.PSIsContainer) {
    if ($skip -contains $entry.Name) { continue }
    Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $target $entry.Name) -Recurse -Force
    continue
  }
  if ($skipFiles -contains $entry.Name) { continue }
  Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $target $entry.Name) -Force
}

# service ships as a single bundle; drop any stray sources
Get-ChildItem -LiteralPath (Join-Path $target 'service') -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne 'bundle.js' } |
  Remove-Item -Force

if (-not (Test-Path (Join-Path $target 'service\bundle.js'))) {
  Fail 'copy failed: service\bundle.js is missing after copy'
}

# ---- 2. register the extension path ----
$extensionsPath = Join-Path $ConfigDir 'extensions.json'
$config = Read-Json $extensionsPath
if (-not $config.paths) {
  $config | Add-Member -NotePropertyName paths -NotePropertyValue @() -Force
}

$paths = @($config.paths)
$replaced = $false
for ($i = 0; $i -lt $paths.Count; $i++) {
  $leaf = ($paths[$i] -split '[\\/]')[-1]
  if ($leaf -ieq 'browser-bridge') {
    $paths[$i] = $target
    $replaced = $true
  }
}
if (-not $replaced) { $paths += $target }
$config.paths = $paths

if ($Grant) {
  if (-not $config.capabilityGrants) {
    $config | Add-Member -NotePropertyName capabilityGrants -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $granted = @()
  if ($config.capabilityGrants.'browser-bridge') { $granted = @($config.capabilityGrants.'browser-bridge') }
  foreach ($capability in @('service', 'skills', 'opencodePlugin')) {
    if ($granted -notcontains $capability) { $granted += $capability }
  }
  $config.capabilityGrants | Add-Member -NotePropertyName 'browser-bridge' -NotePropertyValue $granted -Force
}

Write-Json $extensionsPath $config
Write-Host '  extensions.json updated'

# ---- 3. make it the browser provider ----
$settingsPath = Join-Path $ConfigDir 'settings.json'
if (Test-Path $settingsPath) {
  $settings = Read-Json $settingsPath
  $settings | Add-Member -NotePropertyName browserProvider -NotePropertyValue 'browser-bridge' -Force
  Write-Json $settingsPath $settings
  Write-Host '  settings.json: browserProvider = browser-bridge'
} else {
  Write-Host '  settings.json not found (OpenChamber will create it on first run)' -ForegroundColor Yellow
}

# ---- 4. verify ----
$installedManifest = Read-Json (Join-Path $target 'package.json')
$entry = $installedManifest.openchamber.contributes.service.entry
$entryExists = Test-Path (Join-Path $target ($entry -replace '/', '\'))
$browserPath = 'C:\UserProgram\ungoogled-chromium\chrome.exe'
$browserFound = Test-Path $browserPath

Write-Host ''
Write-Host 'Installed:' -ForegroundColor Green
Write-Host "  version        : $($installedManifest.version)"
Write-Host "  service entry  : $entry (found: $entryExists)"
Write-Host "  default browser: $browserPath (found: $browserFound)"
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Fully quit OpenChamber and start it again.'
if (-not $Grant) {
  Write-Host '  2. Approve the extension permissions when OpenChamber asks'
  Write-Host '     (service / opencodePlugin / skills).'
} else {
  Write-Host '  2. Capability grants were pre-written by -Grant; no approval dialog.'
}
Write-Host '  3. Settings -> General -> OpenChamber tools -> Browser provider'
Write-Host '     -> pick "OpenChamber-Browser-bridge".'
if (-not $browserFound) {
  Write-Host '  4. No Chromium at the default path: set any Chromium-based browser'
  Write-Host '     exe in the extension panel, or install ungoogled-chromium.'
}
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
