param([string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$repoDirectory = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $repoDirectory 'data' }
$pidPath = Join-Path ([IO.Path]::GetFullPath($RuntimeDirectory)) 'bot.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output 'No local bot PID recorded.'; exit 0 }
$botProcessId = [int](Get-Content -LiteralPath $pidPath -Raw)
$entryPath = Join-Path $repoDirectory 'src\main.mjs'
$record = Get-CimInstance Win32_Process -Filter "ProcessId = $botProcessId" -ErrorAction SilentlyContinue
if ($record -and $record.Name -eq 'node.exe' -and $record.CommandLine -and $record.CommandLine.Contains($entryPath)) {
    Stop-Process -Id $botProcessId
    Write-Output 'MappiBot stopped. Wait up to 60 seconds before restarting after a forced stop.'
} else { Write-Output 'Recorded MappiBot process is not running.' }
