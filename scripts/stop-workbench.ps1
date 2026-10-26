$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot
$agentServerPath = Join-Path $agentRoot 'src/server.ts'
$agentPidFile = Join-Path $agentRoot '.local/server/pid.txt'
if (Test-Path -LiteralPath $agentPidFile) {
    $agentPriorPid = [int](Get-Content -LiteralPath $agentPidFile)
    $agentPriorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$agentPriorPid" -ErrorAction SilentlyContinue
    if ($agentPriorProcess -and $agentPriorProcess.CommandLine.Contains($agentServerPath)) { Stop-Process -Id $agentPriorPid; Write-Output 'Workbench stopped. Coding containers retain their own lifecycle.' }
    else { Write-Output 'Recorded workbench process is not running.' }
}
