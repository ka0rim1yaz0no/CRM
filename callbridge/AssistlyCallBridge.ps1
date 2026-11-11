param(
    [switch]$Once,
    [switch]$ProbeOnly,
    [ValidateSet("", "idle", "active", "unknown")]
    [string]$MockStatus = ""
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$BridgeVersion = "0.5.0"
$InstallDirectory = Join-Path $env:LOCALAPPDATA "Assistly\CallBridge"
$ConfigPath = Join-Path $InstallDirectory "config.json"
$LogPath = Join-Path $InstallDirectory "bridge.log"
$DialJournalPath = Join-Path $InstallDirectory "native-dials.log"

function Write-BridgeLog {
    param([string]$Message)

    try {
        New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null

        if (Test-Path -LiteralPath $LogPath) {
            $logFile = Get-Item -LiteralPath $LogPath
            if ($logFile.Length -gt 1MB) {
                Move-Item -LiteralPath $LogPath -Destination "$LogPath.previous" -Force
            }
        }

        Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) $Message"
    } catch {
        # Logging must never stop call-state reporting.
    }
}

function Initialize-AudioProbe {
    if ("Assistly.CallBridge.AudioProbe" -as [type]) {
        return
    }

    $source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Assistly.CallBridge
{
    public static class AudioProbe
    {
        private enum EDataFlow { Render, Capture, All }
        private enum ERole { Console, Multimedia, Communications }
        private enum AudioSessionState { Inactive, Active, Expired }

        [Flags]
        private enum CLSCTX : uint { All = 23 }

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        private class MMDeviceEnumerator { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
        private interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
        private interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, CLSCTX clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("BFA971F1-4D5E-40BB-935E-967039BFBEE4")]
        private interface IAudioSessionManager2
        {
            [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, uint streamFlags, out IntPtr sessionControl);
            [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, uint streamFlags, out IntPtr audioVolume);
            [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
        private interface IAudioSessionEnumerator
        {
            [PreserveSig] int GetCount(out int count);
            [PreserveSig] int GetSession(int index, out IAudioSessionControl control);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
        private interface IAudioSessionControl
        {
            [PreserveSig] int GetState(out AudioSessionState state);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
            [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
            [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
            [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
            [PreserveSig] int GetGroupingParam(out Guid groupingId);
            [PreserveSig] int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
        private interface IAudioSessionControl2
        {
            [PreserveSig] int GetState(out AudioSessionState state);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
            [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
            [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
            [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
            [PreserveSig] int GetGroupingParam(out Guid groupingId);
            [PreserveSig] int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
            [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string value);
            [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string value);
            [PreserveSig] int GetProcessId(out uint processId);
            [PreserveSig] int IsSystemSoundsSession();
            [PreserveSig] int SetDuckingPreference(bool optOut);
        }

        public static int[] ActiveAudioProcessIds()
        {
            var captureProcessIds = new HashSet<int>();
            var renderProcessIds = new HashSet<int>();
            AddActiveProcessIds(captureProcessIds, EDataFlow.Capture, ERole.Multimedia);
            AddActiveProcessIds(captureProcessIds, EDataFlow.Capture, ERole.Communications);
            AddActiveProcessIds(renderProcessIds, EDataFlow.Render, ERole.Multimedia);
            AddActiveProcessIds(renderProcessIds, EDataFlow.Render, ERole.Communications);
            captureProcessIds.IntersectWith(renderProcessIds);
            var result = new int[captureProcessIds.Count];
            captureProcessIds.CopyTo(result);
            return result;
        }

        private static void AddActiveProcessIds(HashSet<int> processIds, EDataFlow dataFlow, ERole role)
        {
            IMMDevice device = null;
            object managerObject = null;
            IAudioSessionEnumerator sessions = null;

            try
            {
                var deviceEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                if (deviceEnumerator.GetDefaultAudioEndpoint(dataFlow, role, out device) != 0 || device == null)
                    return;

                var iid = typeof(IAudioSessionManager2).GUID;
                if (device.Activate(ref iid, CLSCTX.All, IntPtr.Zero, out managerObject) != 0 || managerObject == null)
                    return;

                var manager = (IAudioSessionManager2)managerObject;
                if (manager.GetSessionEnumerator(out sessions) != 0 || sessions == null)
                    return;

                int count;
                sessions.GetCount(out count);

                for (var index = 0; index < count; index++)
                {
                    IAudioSessionControl control = null;
                    try
                    {
                        if (sessions.GetSession(index, out control) != 0 || control == null)
                            continue;

                        var control2 = (IAudioSessionControl2)control;
                        AudioSessionState state;
                        uint processId;
                        control2.GetState(out state);
                        control2.GetProcessId(out processId);

                        if (state == AudioSessionState.Active && processId > 0)
                            processIds.Add((int)processId);
                    }
                    finally
                    {
                        if (control != null && Marshal.IsComObject(control))
                            Marshal.ReleaseComObject(control);
                    }
                }
            }
            catch
            {
                // A missing or changing audio device should produce an unknown signal, not crash the bridge.
            }
            finally
            {
                if (sessions != null && Marshal.IsComObject(sessions))
                    Marshal.ReleaseComObject(sessions);
                if (managerObject != null && Marshal.IsComObject(managerObject))
                    Marshal.ReleaseComObject(managerObject);
                if (device != null && Marshal.IsComObject(device))
                    Marshal.ReleaseComObject(device);
            }
        }
    }
}
'@

    Add-Type -TypeDefinition $source -Language CSharp
}

function Get-NextivaDetection {
    if ($MockStatus) {
        return [pscustomobject]@{
            State = $MockStatus
            NextivaProcessDetected = $MockStatus -ne "unknown"
            AudioSessionActive = $MockStatus -eq "active"
            ProcessIds = @()
        }
    }

    $nextivaProcesses = @(Get-Process -Name "Nextiva" -ErrorAction SilentlyContinue)
    if ($nextivaProcesses.Count -eq 0) {
        return [pscustomobject]@{
            State = "unknown"
            NextivaProcessDetected = $false
            AudioSessionActive = $false
            ProcessIds = @()
        }
    }

    $nextivaProcessIds = @($nextivaProcesses | ForEach-Object { [int]$_.Id })
    $activeAudioProcessIds = @([Assistly.CallBridge.AudioProbe]::ActiveAudioProcessIds())
    $audioSessionActive = @($activeAudioProcessIds | Where-Object { $nextivaProcessIds -contains $_ }).Count -gt 0

    return [pscustomobject]@{
        State = if ($audioSessionActive) { "active" } else { "idle" }
        NextivaProcessDetected = $true
        AudioSessionActive = $audioSessionActive
        ProcessIds = $nextivaProcessIds
    }
}

function Get-PlainTextToken {
    param([string]$EncryptedToken)

    $secureToken = ConvertTo-SecureString $EncryptedToken
    return [System.Net.NetworkCredential]::new("", $secureToken).Password
}

function Send-Heartbeat {
    param(
        [pscustomobject]$Config,
        [string]$Token,
        [pscustomobject]$Detection,
        [string]$State
    )

    $headers = @{
        Authorization = "Bearer $Token"
        "X-Business-Id" = $Config.businessId
    }
    $body = @{
        deviceId = $Config.deviceId
        deviceName = $env:COMPUTERNAME
        state = $State
        nextivaProcessDetected = $Detection.NextivaProcessDetected
        audioSessionActive = $Detection.AudioSessionActive
        bridgeVersion = $BridgeVersion
        nativeDialProtocol = if ($script:nativeWorker -and $script:nativeWorker.InvocationStateInfo.State -eq "Running" -and (Test-NativeDialHandler)) { 1 } else { 0 }
    } | ConvertTo-Json

    Invoke-RestMethod `
        -Method Post `
        -Uri "$($Config.backendUrl)/api/call-bridge/heartbeat" `
        -Headers $headers `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 10 | Out-Null
}

function Test-NativeDialHandler {
    try {
        $choice = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\tel\UserChoice" -ErrorAction Stop
        return [bool]($choice.ProgId -match "(?i)nextiva")
    } catch { return $false }
}

function Save-NativeDialReceipt {
    param([string]$AttemptId)
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    $stream = [System.IO.File]::Open($DialJournalPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true, 1024, $true)
        try { $saved = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if (($saved -split "`r?`n") -contains $AttemptId) { return $false }
        $null = $stream.Seek(0, [System.IO.SeekOrigin]::End)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("$AttemptId`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        return $true
    } finally { $stream.Dispose() }
}

function Invoke-NativeDialPoll {
    param([pscustomobject]$Config, [string]$Token)
    $origin = [uri]$Config.backendUrl
    if (-not $origin.IsAbsoluteUri -or $origin.Scheme -ne "https" -or -not (Test-NativeDialHandler)) { return }
    $before = Get-NextivaDetection
    if ($before.State -ne "idle" -or -not $before.NextivaProcessDetected -or $before.AudioSessionActive) { return }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $command = Invoke-RestMethod -Method Post -Uri "$($Config.backendUrl)/api/call-bridge/native-dial/claim" `
        -Headers @{ Authorization = "Bearer $Token"; "X-Business-Id" = $Config.businessId } `
        -ContentType "application/json" -Body (@{ deviceId = $Config.deviceId } | ConvertTo-Json) -TimeoutSec 3
    if (-not $command) { return }
    if ($command.attemptId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" -or
        $command.phone -notmatch "^\+[1-9][0-9]{7,14}$" -or $command.validForMs -le 0 -or $command.validForMs -gt 1500 -or
        $clock.Elapsed.TotalMilliseconds -ge $command.validForMs) { return }
    $current = Get-NextivaDetection
    if ($current.State -ne "idle" -or -not $current.NextivaProcessDetected -or $current.AudioSessionActive -or
        -not (Test-NativeDialHandler)) { return }
    # Persist before the OS handoff. A crash or lost reply must never replay a dial.
    if (-not (Save-NativeDialReceipt -AttemptId $command.attemptId)) { return }
    if ($clock.Elapsed.TotalMilliseconds -ge $command.validForMs) { return }
    Start-Process -FilePath "tel:$($command.phone)" -WindowStyle Hidden
    Write-BridgeLog "Native dial handed to the configured Nextiva protocol handler; awaiting call-state confirmation."
}

function Start-NativeDialWorker {
    param([pscustomobject]$Config, [string]$Token)
    $definitions = @{}
    foreach ($name in @("Get-NextivaDetection", "Test-NativeDialHandler", "Save-NativeDialReceipt", "Invoke-NativeDialPoll", "Write-BridgeLog")) {
        $definitions[$name] = (Get-Item -LiteralPath "function:$name").Definition
    }
    $worker = [PowerShell]::Create()
    $body = {
        param($Config, $Token, $InstallDirectory, $DialJournalPath, $LogPath, $Definitions)
        $ErrorActionPreference = "Stop"
        $MockStatus = ""
        foreach ($name in $Definitions.Keys) { . ([scriptblock]::Create("function $name {" + $Definitions[$name] + "}")) }
        while ($true) {
            $clock = [System.Diagnostics.Stopwatch]::StartNew()
            $interval = 1000
            try { Invoke-NativeDialPoll -Config $Config -Token $Token }
            catch { $interval = 5000; Write-BridgeLog "Native dial polling unavailable; no fallback dial was attempted." }
            Start-Sleep -Milliseconds ([int][Math]::Max(50, $interval - $clock.Elapsed.TotalMilliseconds))
        }
    }
    $null = $worker.AddScript($body.ToString()).AddArgument($Config).AddArgument($Token).AddArgument($InstallDirectory).AddArgument($DialJournalPath).AddArgument($LogPath).AddArgument($definitions)
    $null = $worker.BeginInvoke()
    return $worker
}

Initialize-AudioProbe

if ($ProbeOnly) {
    Get-NextivaDetection | ConvertTo-Json -Depth 4
    exit 0
}

if ($Once -and -not (Test-Path -LiteralPath $ConfigPath)) {
    Get-NextivaDetection | ConvertTo-Json -Depth 4
    exit 0
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-BridgeLog "Configuration is missing. Run install-windows.cmd to pair this computer."
    exit 1
}

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\AssistlyCallBridge", [ref]$createdNew)
if (-not $createdNew) {
    if ($Once) {
        Get-NextivaDetection | ConvertTo-Json -Depth 4
    }
    exit 0
}

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $token = Get-PlainTextToken -EncryptedToken $config.encryptedToken
    $reportedState = "unknown"
    $lastHeartbeatAt = [DateTime]::MinValue
    if (-not $Once -and -not $MockStatus) { $script:nativeWorker = Start-NativeDialWorker -Config $config -Token $token }

    do {
        $detection = Get-NextivaDetection
        $nextState = $detection.State

        # Send raw transitions promptly; the server owns end confirmation and the 30-second deadline.
        $stateChanged = $nextState -ne $reportedState
        $heartbeatDue = ((Get-Date) - $lastHeartbeatAt).TotalSeconds -ge 5

        if ($stateChanged -or $heartbeatDue -or $Once) {
            try {
                Send-Heartbeat -Config $config -Token $token -Detection $detection -State $nextState
                $lastHeartbeatAt = Get-Date
                if ($stateChanged) {
                    Write-BridgeLog "Nextiva state changed to $nextState."
                }
            } catch {
                Write-BridgeLog "Heartbeat failed: $($_.Exception.Message)"
            }
        }

        $reportedState = $nextState

        if ($Once) {
            [pscustomobject]@{
                state = $nextState
                nextivaProcessDetected = $detection.NextivaProcessDetected
                audioSessionActive = $detection.AudioSessionActive
                processIds = $detection.ProcessIds
            } | ConvertTo-Json -Depth 4
            break
        }

        Start-Sleep -Milliseconds 500
    } while ($true)
} catch {
    Write-BridgeLog "Bridge stopped: $($_.Exception.Message)"
    throw
} finally {
    if ($script:nativeWorker) { $script:nativeWorker.Stop(); $script:nativeWorker.Dispose() }
    if ($createdNew) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
