$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "..\callbridge\AssistlyCallBridge.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Bridge source did not parse." }
$loop = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.DoWhileStatementAst] }, $true)
if (-not $loop) { throw "Bridge sampling loop was not found." }
$body = [scriptblock]::Create($loop.Body.Extent.Text.Substring(1, $loop.Body.Extent.Text.Length - 2))
$records = [System.Collections.Generic.List[object]]::new()
$samples = @("active", "idle", "active", "idle")
function Get-NextivaDetection {
    [pscustomobject]@{ State = $samples[$sampleIndex]; AudioSessionActive = $samples[$sampleIndex] -eq "active"; NextivaProcessDetected = $true }
}
function Send-Heartbeat {
    param($Config, $Token, $Detection, $State)
    $records.Add([pscustomobject]@{ State = $State; Audio = $Detection.AudioSessionActive; Sample = $sampleIndex })
}
function Write-BridgeLog { param($Message) }
function Get-Date { [DateTime]::Parse("2026-10-22T03:00:00Z").AddMilliseconds($sampleIndex * 500) }
function Start-Sleep {
    param([int]$Seconds, [int]$Milliseconds)
    if (($Seconds * 1000 + $Milliseconds) -gt 500) { throw "Call-state sampling adds more than 500ms of avoidable delay." }
}
$reportedState = "unknown"
$inactiveSamples = 0
$lastHeartbeatAt = [DateTime]::MinValue
$Once = $false
$config = $null
$token = "synthetic-unused-token"
for ($sampleIndex = 0; $sampleIndex -lt $samples.Count; $sampleIndex++) { . $body }
if ($records.Count -ne $samples.Count) { throw "A raw audio transition was delayed or suppressed." }
for ($index = 0; $index -lt $samples.Count; $index++) {
    if ($records[$index].State -ne $samples[$index]) { throw "Reported state does not match the observed audio state." }
}
Write-Output "Synthetic bridge sampling transitions passed; no installed bridge, configuration or network was accessed."
