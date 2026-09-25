@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Update failed. Review the message above.
  pause
  exit /b 1
)
echo.
pause
