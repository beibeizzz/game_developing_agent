param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $agentRoot
$agentPort = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$agentEnvPath = if ($env:AGENT_ENV_FILE) { $env:AGENT_ENV_FILE } else { Join-Path $agentRoot '.env' }
if (!$env:PORT -and (Test-Path -LiteralPath $agentEnvPath)) {
    foreach ($agentLine in Get-Content -LiteralPath $agentEnvPath) {
        if ($agentLine -match '^\s*PORT\s*=\s*["'']?(\d+)') { $agentPort = [int]$Matches[1] }
    }
}
$agentUrl = 'http://127.0.0.1:' + $agentPort
$agentServerPath = Join-Path $agentRoot 'src/server.ts'
$agentLogPath = Join-Path $agentRoot '.local/server'
New-Item -ItemType Directory -Path $agentLogPath -Force | Out-Null
$agentPidFile = Join-Path $agentLogPath 'pid.txt'
if (Test-Path -LiteralPath $agentPidFile) {
    $agentPriorPid = [int](Get-Content -LiteralPath $agentPidFile)
    $agentPriorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$agentPriorPid" -ErrorAction SilentlyContinue
    if ($agentPriorProcess -and $agentPriorProcess.CommandLine.Contains($agentServerPath)) {
        Write-Output ('Workbench already running at ' + $agentUrl)
        exit 0
    }
}
if (!(Test-Path -LiteralPath 'dist/workbench/index.html')) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Workbench build failed' }
}
$agentNode = (Get-Command node).Source
$agentProcess = Start-Process -FilePath $agentNode -ArgumentList '--import','tsx',('"' + $agentServerPath + '"') -WorkingDirectory $agentRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $agentLogPath 'stdout.log') -RedirectStandardError (Join-Path $agentLogPath 'stderr.log') -PassThru
$agentProcess.Id | Set-Content -LiteralPath $agentPidFile
$agentReady = $false
for ($agentAttempt = 0; $agentAttempt -lt 80; $agentAttempt++) {
    $agentProcess.Refresh()
    if ($agentProcess.HasExited) { throw ('Workbench exited. Read ' + (Join-Path $agentLogPath 'stderr.log')) }
    try { $agentHealth = Invoke-RestMethod -Uri ($agentUrl + '/api/health') -TimeoutSec 1; if ($agentHealth.ok) { $agentReady = $true; break } } catch {}
    Start-Sleep -Milliseconds 250
}
if (!$agentReady) { throw ('Workbench health check timed out. Read ' + (Join-Path $agentLogPath 'stderr.log')) }
Write-Output ('Started PID ' + $agentProcess.Id + ': ' + $agentUrl)
if (!$NoBrowser) { Start-Process $agentUrl }
