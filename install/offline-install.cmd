@echo off
setlocal
rem Offline one-shot installer for OpenChamber-Browser-bridge (Windows).
rem Double-click this file after unzipping, with OpenChamber started at least once.

set "HERE=%~dp0"
set "PKGROOT=%HERE%.."

echo Installing OpenChamber-Browser-bridge...
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" -Source "%PKGROOT%"
if errorlevel 1 (
  echo.
  echo Install failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo Done. Fully quit OpenChamber and start it again.
pause
