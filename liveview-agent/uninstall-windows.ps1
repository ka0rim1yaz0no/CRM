$ErrorActionPreference = "Stop"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Assistly\LiveViewAgent"
$StartupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "Assistly Live View Agent.lnk"
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Assistly CRM Live View.lnk"

foreach ($path in @($StartupShortcut, $DesktopShortcut)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
Write-Host "Assistly Live View Agent removed." -ForegroundColor Green
