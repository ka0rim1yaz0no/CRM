$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "..\callbridge\AssistlyCallBridge.ps1"
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "Bridge script failed parsing." }
foreach ($name in @("Save-NativeDialReceipt", "Invoke-NativeDialPoll", "Start-NativeDialWorker")) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $definition) { throw "Native dial function is missing." }
    . ([scriptblock]::Create($definition.Extent.Text))
}
$outputs = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\outputs"))
$InstallDirectory = Join-Path $outputs ("native-bridge-test-" + [guid]::NewGuid())
$DialJournalPath = Join-Path $InstallDirectory "receipts.log"
$config = [pscustomobject]@{ backendUrl = "https://synthetic.invalid"; businessId = "synthetic"; deviceId = "synthetic" }
$script:launches = 0; $script:requests = 0; $script:checks = 0
$script:handlerReady = $true; $script:state = "idle"; $script:changeAfterClaim = $false; $script:slow = $false
$script:command = [pscustomobject]@{ attemptId = [guid]::NewGuid().ToString(); phone = "+12025550100"; validForMs = 1500 }
function Test-NativeDialHandler { return $script:handlerReady }
function Get-NextivaDetection {
    $script:checks++
    $value = if ($script:changeAfterClaim -and $script:checks -gt 1) { "active" } else { $script:state }
    return [pscustomobject]@{ State = $value; NextivaProcessDetected = $value -ne "unknown"; AudioSessionActive = $value -eq "active" }
}
function Invoke-RestMethod { $script:requests++; if ($script:slow) { Start-Sleep -Milliseconds 30 }; return $script:command }
function Start-Process { param($FilePath, $WindowStyle); if ($FilePath -ne "tel:+12025550100" -or $WindowStyle -ne "Hidden") { throw "Unsafe OS handoff." }; $script:launches++ }
function Write-BridgeLog { param($Message) }
function Check-NoLaunch { param([scriptblock]$Action); $before = $script:launches; & $Action; if ($script:launches -ne $before) { throw "Unsafe native dial occurred." } }
try {
    Invoke-NativeDialPoll -Config $config -Token "synthetic"
    if ($script:launches -ne 1) { throw "Authorized native handoff was not made." }
    Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" }
    foreach ($state in @("active", "unknown")) { $script:state = $state; Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" } }
    $script:state = "idle"; $script:handlerReady = $false
    Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" }; $script:handlerReady = $true
    $script:checks = 0; $script:changeAfterClaim = $true; $script:command.attemptId = [guid]::NewGuid().ToString()
    Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" }; $script:changeAfterClaim = $false
    foreach ($phone in @("tel:+12025550100", "+12025550100;calc.exe", "https://synthetic.invalid", "", "123")) {
        $script:command.phone = $phone; Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" }
    }
    $script:command.phone = "+12025550100"; $script:command.validForMs = 10; $script:slow = $true
    Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" }; $script:slow = $false; $script:command.validForMs = 1500
    $config.backendUrl = "http://synthetic.invalid"
    Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" }; $config.backendUrl = "https://synthetic.invalid"
    $script:command.attemptId = "invalid-command"
    Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" }
    $script:command.attemptId = [guid]::NewGuid().ToString()
    Invoke-NativeDialPoll -Config $config -Token "synthetic"
    if ($script:launches -ne 2) { throw "A second unique command must hand off once." }
    Check-NoLaunch { Invoke-NativeDialPoll -Config $config -Token "synthetic" }
    function Invoke-NativeDialPoll { param($Config, $Token); Start-Sleep -Seconds 2 }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $worker = Start-NativeDialWorker -Config $config -Token "synthetic"
    try {
        if ($watch.ElapsedMilliseconds -gt 500) { throw "Native worker startup blocked sampling." }
        Start-Sleep -Milliseconds 100
        if ($worker.InvocationStateInfo.State -ne "Running") { throw "Asynchronous native worker failed." }
    } finally { $worker.Stop(); $worker.Dispose() }
    $loop = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.DoWhileStatementAst] }, $true)
    if ($loop.Body.Extent.Text -match "Invoke-NativeDialPoll") { throw "Native network polling must not block the audio sampling loop." }
    Write-Output '{"nativeBridgeMockChecksPassed":true,"workerAsynchronous":true,"realCalls":0,"networkRequests":0,"duplicateLaunches":0}'
} finally {
    $resolved = [System.IO.Path]::GetFullPath($InstallDirectory)
    if (-not $resolved.StartsWith($outputs + [System.IO.Path]::DirectorySeparatorChar) -or (Split-Path $resolved -Leaf) -notlike "native-bridge-test-*") { throw "Unsafe test cleanup path." }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
