$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "assistly-live-view-agent"
$zip = Join-Path $dist "assistly-live-view-agent.zip"

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($file in @("install-windows.cmd", "install-windows.ps1", "uninstall-windows.cmd", "uninstall-windows.ps1")) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage -Force
}
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Built $zip"
