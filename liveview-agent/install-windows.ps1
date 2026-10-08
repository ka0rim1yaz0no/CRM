$ErrorActionPreference = "Stop"

$Version = "1.0.0"
$CrmUrl = "https://crm.assistly123.com"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Assistly\LiveViewAgent"
$LauncherPath = Join-Path $InstallRoot "Start Assistly Live View.cmd"
$ProfilePath = Join-Path $InstallRoot "BrowserProfile"
$AllowedOrigins = @("https://crm.assistly123.com")

function Set-RegistryStringListPolicy([string]$RootPath, [string]$PolicyName, [string[]]$Values) {
    $policyPath = Join-Path $RootPath $PolicyName
    if (Test-Path -LiteralPath $policyPath) { Remove-Item -LiteralPath $policyPath -Recurse -Force }
    New-Item -Path $policyPath -Force | Out-Null
    for ($index = 0; $index -lt $Values.Count; $index += 1) {
        New-ItemProperty -Path $policyPath -Name ([string]($index + 1)) -PropertyType String -Value $Values[$index] -Force | Out-Null
    }
}

function Enable-ScreenCapturePolicies([string]$PolicyRoot) {
    New-Item -Path $PolicyRoot -Force | Out-Null
    New-ItemProperty -Path $PolicyRoot -Name "ScreenCaptureAllowed" -PropertyType DWord -Value 1 -Force | Out-Null
    Set-RegistryStringListPolicy $PolicyRoot "ScreenCaptureAllowedByOrigins" $AllowedOrigins
    Set-RegistryStringListPolicy $PolicyRoot "ScreenCaptureWithoutGestureAllowedForOrigins" $AllowedOrigins
}

function Find-Browser {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\Application\brave.exe"),
        (Join-Path ${env:ProgramFiles} "BraveSoftware\Brave-Browser\Application\brave.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe")
    )
    return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

$BrowserPath = Find-Browser
if (-not $BrowserPath) { throw "Chrome, Brave, or Edge is required." }

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ProfilePath -Force | Out-Null

Enable-ScreenCapturePolicies "HKCU:\Software\Policies\Google\Chrome"
Enable-ScreenCapturePolicies "HKCU:\Software\Policies\BraveSoftware\Brave"
Enable-ScreenCapturePolicies "HKCU:\Software\Policies\Microsoft\Edge"

$launcher = @(
    "@echo off",
    "start `"`" `"$BrowserPath`" --user-data-dir=`"$ProfilePath`" --auto-select-desktop-capture-source=`"Entire screen`" --enable-usermedia-screen-capturing --app=`"$CrmUrl`""
) -join [Environment]::NewLine
Set-Content -LiteralPath $LauncherPath -Value $launcher -Encoding ASCII

$shell = New-Object -ComObject WScript.Shell
$startupShortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Startup")) "Assistly Live View Agent.lnk"))
$startupShortcut.TargetPath = $LauncherPath
$startupShortcut.WorkingDirectory = $InstallRoot
$startupShortcut.IconLocation = "$BrowserPath,0"
$startupShortcut.Description = "Starts the disclosed Assistly CRM Live View workspace."
$startupShortcut.Save()

$desktopShortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Assistly CRM Live View.lnk"))
$desktopShortcut.TargetPath = $LauncherPath
$desktopShortcut.WorkingDirectory = $InstallRoot
$desktopShortcut.IconLocation = "$BrowserPath,0"
$desktopShortcut.Description = "Starts the disclosed Assistly CRM Live View workspace."
$desktopShortcut.Save()

Set-Content -LiteralPath (Join-Path $InstallRoot "version.txt") -Value $Version -Encoding ASCII
Start-Process -FilePath $LauncherPath

Write-Host "Assistly Live View Agent $Version installed." -ForegroundColor Green
Write-Host "The managed CRM workspace will start automatically with Windows."
Write-Host "Employees remain visibly informed when monitoring is enabled and when Live View is active."
