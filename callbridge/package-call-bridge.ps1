$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistDirectory = Join-Path $Root "dist"
$StagingDirectory = Join-Path $Root ".package"
$PackagePath = Join-Path $DistDirectory "assistly-call-bridge.zip"
$resolvedRoot = [System.IO.Path]::GetFullPath($Root) + [System.IO.Path]::DirectorySeparatorChar
foreach ($target in @($StagingDirectory, $PackagePath)) {
    if (-not [System.IO.Path]::GetFullPath($target).StartsWith($resolvedRoot)) { throw "Unsafe package output path." }
    if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).LinkType) { throw "Package output must not be a link." }
}

if (Test-Path -LiteralPath $StagingDirectory) {
    Remove-Item -LiteralPath $StagingDirectory -Recurse -Force
}

New-Item -ItemType Directory -Path $StagingDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $DistDirectory -Force | Out-Null

@(
    "AssistlyCallBridge.ps1",
    "install-windows.ps1",
    "install-windows.cmd",
    "update-windows.ps1",
    "update-windows.cmd",
    "uninstall-windows.ps1",
    "README.md",
    "NATIVE-DIALING.md"
) | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $Root $_) -Destination (Join-Path $StagingDirectory $_) -Force
}

if (Test-Path -LiteralPath $PackagePath) {
    Remove-Item -LiteralPath $PackagePath -Force
}

Compress-Archive -Path (Join-Path $StagingDirectory "*") -DestinationPath $PackagePath -CompressionLevel Optimal
Remove-Item -LiteralPath $StagingDirectory -Recurse -Force

Write-Host "Built $PackagePath"
