param(
    [switch]$Once,
    [ValidateSet("", "idle", "active", "unknown")]
    [string]$MockStatus = ""
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$BridgeVersion = "0.4.0"
$InstallDirectory = Join-Path $env:LOCALAPPDATA "Assistly\CallBridge"
$ConfigPath = Join-Path $InstallDirectory "config.json"
$LogPath = Join-Path $InstallDirectory "bridge.log"

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
            var processIds = new HashSet<int>();
            AddActiveProcessIds(processIds, EDataFlow.Capture, ERole.Multimedia);
            AddActiveProcessIds(processIds, EDataFlow.Capture, ERole.Communications);
            AddActiveProcessIds(processIds, EDataFlow.Render, ERole.Multimedia);
            AddActiveProcessIds(processIds, EDataFlow.Render, ERole.Communications);
            var result = new int[processIds.Count];
            processIds.CopyTo(result);
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
    } | ConvertTo-Json

    Invoke-RestMethod `
        -Method Post `
        -Uri "$($Config.backendUrl)/api/call-bridge/heartbeat" `
        -Headers $headers `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 10 | Out-Null
}

Initialize-AudioProbe

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
    $inactiveSamples = 0
    $lastHeartbeatAt = [DateTime]::MinValue

    do {
        $detection = Get-NextivaDetection
        $nextState = $detection.State

        if ($reportedState -eq "active" -and $nextState -ne "active") {
            $inactiveSamples += 1
            if ($inactiveSamples -lt 3) {
                $nextState = "active"
            }
        } else {
            $inactiveSamples = 0
        }

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

        Start-Sleep -Seconds 2
    } while ($true)
} catch {
    Write-BridgeLog "Bridge stopped: $($_.Exception.Message)"
    throw
} finally {
    if ($createdNew) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
