param(
    [string]$BackendUrl = "",
    [string]$BusinessId = "",
    [string]$PairingCode = "",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$BridgeVersion = "0.3.0"
$InstallDirectory = Join-Path $env:LOCALAPPDATA "Assistly\CallBridge"
$SourceScript = Join-Path $PSScriptRoot "AssistlyCallBridge.ps1"
$InstalledScript = Join-Path $InstallDirectory "AssistlyCallBridge.ps1"
$ConfigPath = Join-Path $InstallDirectory "config.json"
$StartupDirectory = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupDirectory "Assistly Call Bridge.lnk"
$PowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path -LiteralPath $SourceScript)) {
    throw "AssistlyCallBridge.ps1 is missing from the installer folder."
}

if (-not $BackendUrl) {
    $BackendUrl = Read-Host "CRM URL (local example: http://127.0.0.1:4000)"
}

if (-not $BusinessId) {
    $BusinessId = Read-Host "Business ID shown in CRM Settings"
}

if (-not $PairingCode) {
    $PairingCode = Read-Host "8-digit pairing code"
}

$BackendUrl = $BackendUrl.Trim().TrimEnd("/")
if ($BackendUrl.EndsWith("/api", [StringComparison]::OrdinalIgnoreCase)) {
    $BackendUrl = $BackendUrl.Substring(0, $BackendUrl.Length - 4)
}

$BusinessId = $BusinessId.Trim()
$PairingCode = ($PairingCode -replace "\D", "")

if (-not [Uri]::IsWellFormedUriString($BackendUrl, [UriKind]::Absolute)) {
    throw "CRM URL is invalid."
}

if (-not $BusinessId -or $PairingCode.Length -ne 8) {
    throw "Business ID and an 8-digit pairing code are required."
}

$existingConfig = $null
if (Test-Path -LiteralPath $ConfigPath) {
    try {
        $existingConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    } catch {
        $existingConfig = $null
    }
}

$deviceId = if ($existingConfig.deviceId) { $existingConfig.deviceId } else { [Guid]::NewGuid().ToString("N") }
$headers = @{ "X-Business-Id" = $BusinessId }
$body = @{
    pairingCode = $PairingCode
    deviceId = $deviceId
    deviceName = $env:COMPUTERNAME
    bridgeVersion = $BridgeVersion
} | ConvertTo-Json

Write-Host "Pairing this computer with Assistly CRM..."
$claim = Invoke-RestMethod `
    -Method Post `
    -Uri "$BackendUrl/api/call-bridge/claim" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 15

if (-not $claim.token) {
    throw "CRM did not return a bridge token."
}

Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like "*AssistlyCallBridge.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
Copy-Item -LiteralPath $SourceScript -Destination $InstalledScript -Force

$encryptedToken = ConvertTo-SecureString $claim.token -AsPlainText -Force | ConvertFrom-SecureString
$config = @{
    backendUrl = $BackendUrl
    businessId = $BusinessId
    employeeCode = $claim.employeeCode
    employeeName = $claim.employeeName
    deviceId = $deviceId
    encryptedToken = $encryptedToken
    installedAt = (Get-Date).ToString("o")
    bridgeVersion = $BridgeVersion
    accountSwitchingEnabled = [bool]$claim.accountSwitchingEnabled
}
$config | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $PowerShellPath
$shortcut.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstalledScript`""
$shortcut.WorkingDirectory = $InstallDirectory
$shortcut.WindowStyle = 7
$shortcut.Description = "Assistly CRM Nextiva call-state bridge"
$shortcut.Save()

if (-not $NoStart) {
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
}

Write-Host ""
Write-Host "Assistly Call Bridge installed successfully." -ForegroundColor Green
Write-Host "Employee: $($claim.employeeName)"
Write-Host "Computer: $env:COMPUTERNAME"
if ($claim.accountSwitchingEnabled) {
    Write-Host "Account switching: enabled for the latest authorized sales login"
}
Write-Host "Nextiva state will appear in CRM Settings within a few seconds."
