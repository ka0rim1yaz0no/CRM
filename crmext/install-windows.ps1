$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packagedExtensionPath = Join-Path $scriptRoot "assistly-crm-activity-tracker"
$sourcePath = if (Test-Path -LiteralPath (Join-Path $packagedExtensionPath "manifest.json")) {
    $packagedExtensionPath
} else {
    $scriptRoot
}

$installRoot = Join-Path $env:LOCALAPPDATA "Assistly CRM"
$installPath = Join-Path $installRoot "Activity Tracker Extension"
$crmUrl = "https://crm.assistly123.com"
$allowedCaptureOrigins = @(
    "https://crm.assistly123.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
)

if (-not (Test-Path -LiteralPath (Join-Path $sourcePath "manifest.json"))) {
    throw "Could not find the extension manifest. Extract the ZIP first, then run this installer again."
}

if (Test-Path -LiteralPath $installPath) {
    $resolvedInstallRoot = [System.IO.Path]::GetFullPath($installRoot)
    $resolvedInstallPath = [System.IO.Path]::GetFullPath($installPath)

    if (-not $resolvedInstallPath.StartsWith($resolvedInstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Install path safety check failed."
    }

    Remove-Item -LiteralPath $installPath -Recurse -Force
}

New-Item -ItemType Directory -Path $installPath -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourcePath "manifest.json") -Destination $installPath -Force
Copy-Item -LiteralPath (Join-Path $sourcePath "src") -Destination $installPath -Recurse -Force

$assetsPath = Join-Path $sourcePath "assets"
if (Test-Path -LiteralPath $assetsPath) {
    Copy-Item -LiteralPath $assetsPath -Destination $installPath -Recurse -Force
}

function Set-RegistryStringListPolicy([string]$RootPath, [string]$PolicyName, [string[]]$Values) {
    $policyPath = Join-Path $RootPath $PolicyName

    if (Test-Path -LiteralPath $policyPath) {
        Remove-Item -LiteralPath $policyPath -Recurse -Force
    }

    New-Item -Path $policyPath -Force | Out-Null

    for ($index = 0; $index -lt $Values.Count; $index += 1) {
        New-ItemProperty -Path $policyPath -Name ([string]($index + 1)) -PropertyType String -Value $Values[$index] -Force | Out-Null
    }
}

function Enable-ScreenCapturePolicies([string]$PolicyRoot) {
    New-Item -Path $PolicyRoot -Force | Out-Null
    New-ItemProperty -Path $PolicyRoot -Name "ScreenCaptureAllowed" -PropertyType DWord -Value 1 -Force | Out-Null
    Set-RegistryStringListPolicy -RootPath $PolicyRoot -PolicyName "ScreenCaptureAllowedByOrigins" -Values $allowedCaptureOrigins
    Set-RegistryStringListPolicy -RootPath $PolicyRoot -PolicyName "ScreenCaptureWithoutGestureAllowedForOrigins" -Values $allowedCaptureOrigins
}

function Find-ManagedBrowser {
    $browserCandidates = @(
        @{ Name = "Brave"; Path = Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\Application\brave.exe" },
        @{ Name = "Brave"; Path = Join-Path ${env:ProgramFiles} "BraveSoftware\Brave-Browser\Application\brave.exe" },
        @{ Name = "Brave"; Path = Join-Path ${env:ProgramFiles(x86)} "BraveSoftware\Brave-Browser\Application\brave.exe" },
        @{ Name = "Chrome"; Path = Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe" },
        @{ Name = "Chrome"; Path = Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe" },
        @{ Name = "Chrome"; Path = Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe" },
        @{ Name = "Edge"; Path = Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe" },
        @{ Name = "Edge"; Path = Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe" }
    )

    foreach ($candidate in $browserCandidates) {
        if (Test-Path -LiteralPath $candidate.Path) {
            return $candidate
        }
    }

    return $null
}

function Create-ManagedBrowserShortcut([string]$BrowserPath, [string]$BrowserName) {
    $launcherPath = Join-Path $installRoot "Start Assistly CRM Managed Browser.cmd"
    $launcherContent = @(
        "@echo off",
        "start """" ""$BrowserPath"" --auto-select-desktop-capture-source=""Entire screen"" --enable-usermedia-screen-capturing ""$crmUrl"""
    ) -join [Environment]::NewLine
    Set-Content -LiteralPath $launcherPath -Value $launcherContent -Encoding ASCII

    $desktopShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Assistly CRM Managed Browser.lnk"
    $startMenuRoot = Join-Path ([Environment]::GetFolderPath("Programs")) "Assistly CRM"
    $startMenuShortcutPath = Join-Path $startMenuRoot "Assistly CRM Managed Browser.lnk"

    New-Item -ItemType Directory -Path $startMenuRoot -Force | Out-Null

    foreach ($shortcutPath in @($desktopShortcutPath, $startMenuShortcutPath)) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $launcherPath
        $shortcut.WorkingDirectory = $installRoot
        $shortcut.IconLocation = "$BrowserPath,0"
        $shortcut.Description = "Starts $BrowserName with Assistly CRM live-view capture settings."
        $shortcut.Save()
    }

    return $launcherPath
}

Enable-ScreenCapturePolicies "HKCU:\Software\Policies\Google\Chrome"
Enable-ScreenCapturePolicies "HKCU:\Software\Policies\BraveSoftware\Brave"
Enable-ScreenCapturePolicies "HKCU:\Software\Policies\Microsoft\Edge"

$managedBrowser = Find-ManagedBrowser
$managedLauncherPath = $null
if ($managedBrowser) {
    $managedLauncherPath = Create-ManagedBrowserShortcut -BrowserPath $managedBrowser.Path -BrowserName $managedBrowser.Name
}

Set-Clipboard -Value $installPath

try {
    Start-Process "chrome.exe" "chrome://extensions/"
} catch {
    Start-Process "chrome://extensions/"
}

Write-Host ""
Write-Host "Assistly CRM Activity Tracker is ready."
Write-Host ""
Write-Host "Extension folder copied to:"
Write-Host $installPath
Write-Host ""
Write-Host "The folder path was copied to your clipboard."
Write-Host "In Chrome: enable Developer mode, click Load unpacked, then paste/select that folder."
Write-Host ""
Write-Host "Screen-capture policies were added for Chrome, Brave, and Edge under the current Windows user."
if ($managedLauncherPath) {
    Write-Host "Managed browser launcher created:"
    Write-Host $managedLauncherPath
    Write-Host "Use the desktop/start-menu shortcut 'Assistly CRM Managed Browser' for auto-select entire-screen live view."
    Write-Host "Close existing browser windows first; Chromium ignores launch flags when the browser is already running."
} else {
    Write-Host "No supported browser executable was found for the managed launcher. Install Brave, Chrome, or Edge, then run this installer again."
}
Write-Host ""
