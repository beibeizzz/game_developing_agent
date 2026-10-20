param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$Launcher = (Resolve-Path (Join-Path $PSScriptRoot '../game_developing_agent')).Path
$LinuxLauncher = (& wsl -d Ubuntu -- wslpath -u $Launcher).Trim()
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
for ($Index = 0; $Index -lt $Arguments.Count; $Index++) {
    if ($Arguments[$Index] -match '^[A-Za-z]:[\\/]') {
        $Arguments[$Index] = (& wsl -d Ubuntu -- wslpath -u $Arguments[$Index]).Trim()
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}
& wsl -d Ubuntu -- bash $LinuxLauncher @Arguments
exit $LASTEXITCODE
