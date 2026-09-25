$ErrorActionPreference = "Stop"
$InstallDirectory = Join-Path $env:LOCALAPPDATA "Assistly\CallBridge"
$StartupDirectory = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupDirectory "Assistly Call Bridge.lnk"

Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*AssistlyCallBridge.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $InstallDirectory -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Assistly Call Bridge was removed from this Windows account."
