param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$extensionRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $extensionRoot "manifest.json"
$distPath = Join-Path $extensionRoot "dist"
$storeStagePath = Join-Path $distPath "store-package"
$installStagePath = Join-Path $distPath "install-package"
$storeZipPath = Join-Path $distPath "assistly-crm-activity-tracker-store.zip"
$installZipPath = Join-Path $distPath "assistly-crm-activity-tracker-install.zip"
$latestZipPath = Join-Path $distPath "assistly-crm-activity-tracker.zip"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json was not found in $extensionRoot"
}

function Reset-Directory([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }

    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Copy-ExtensionFiles([string]$Destination) {
    $itemsToPackage = @("manifest.json", "src", "assets")

    foreach ($item in $itemsToPackage) {
        $source = Join-Path $extensionRoot $item

        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination $Destination -Recurse -Force
        }
    }
}

function Set-PackageVersion([string]$PackageRoot) {
    if (-not $Version.Trim()) {
        return
    }

    $stagedManifestPath = Join-Path $PackageRoot "manifest.json"
    $manifest = Get-Content -LiteralPath $stagedManifestPath -Raw | ConvertFrom-Json
    $manifest.version = $Version.Trim()
    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $stagedManifestPath -Encoding UTF8
}

foreach ($zipPath in @($storeZipPath, $installZipPath, $latestZipPath)) {
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
}

Reset-Directory $storeStagePath
Copy-ExtensionFiles $storeStagePath
Set-PackageVersion $storeStagePath
Compress-Archive -Path (Join-Path $storeStagePath "*") -DestinationPath $storeZipPath -Force

Reset-Directory $installStagePath
$installExtensionPath = Join-Path $installStagePath "assistly-crm-activity-tracker"
New-Item -ItemType Directory -Path $installExtensionPath -Force | Out-Null
Copy-ExtensionFiles $installExtensionPath
Set-PackageVersion $installExtensionPath
Copy-Item -LiteralPath (Join-Path $extensionRoot "install-windows.cmd") -Destination $installStagePath -Force
Copy-Item -LiteralPath (Join-Path $extensionRoot "install-windows.ps1") -Destination $installStagePath -Force
Compress-Archive -Path (Join-Path $installStagePath "*") -DestinationPath $installZipPath -Force
Copy-Item -LiteralPath $installZipPath -Destination $latestZipPath -Force

Remove-Item -LiteralPath $storeStagePath -Recurse -Force
Remove-Item -LiteralPath $installStagePath -Recurse -Force

Write-Host "Extension packages created:"
Write-Host $installZipPath
Write-Host $storeZipPath
