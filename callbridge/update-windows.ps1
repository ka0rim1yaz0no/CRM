$ErrorActionPreference = "Stop"
$BridgeVersion = "0.3.0"
$InstallDirectory = Join-Path $env:LOCALAPPDATA "Assistly\CallBridge"
$SourceScript = Join-Path $PSScriptRoot "AssistlyCallBridge.ps1"
$InstalledScript = Join-Path $InstallDirectory "AssistlyCallBridge.ps1"
$ConfigPath = Join-Path $InstallDirectory "config.json"
$PowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path -LiteralPath $SourceScript)) {
    throw "AssistlyCallBridge.ps1 is missing from the updater folder."
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Call Bridge is not paired on this Windows account. Run install-windows.cmd first."
}

Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*AssistlyCallBridge.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
Copy-Item -LiteralPath $SourceScript -Destination $InstalledScript -Force

Start-Process `
    -FilePath $PowerShellPath `
    -ArgumentList @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", "`"$InstalledScript`""
    ) `
    -WindowStyle Hidden

Write-Host "Assistly Call Bridge updated to version $BridgeVersion." -ForegroundColor Green
Write-Host "The existing computer pairing was preserved."
