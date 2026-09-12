param([string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$repoDirectory = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $repoDirectory 'data' }
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory)
New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
$nodeEntry = Join-Path $repoDirectory 'src\main.mjs'
$nodeExecutable = (Get-Command node.exe).Source
$pidPath = Join-Path $RuntimeDirectory 'bot.pid'
if (Test-Path -LiteralPath $pidPath) {
    $existingId = [int](Get-Content -LiteralPath $pidPath -Raw)
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $existingId" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains($nodeEntry)) {
        Write-Output 'MappiBot is already running.'
        exit 0
    }
}
$tokenPath = Join-Path $RuntimeDirectory 'telegram-token.xml'
if (-not (Test-Path -LiteralPath $tokenPath)) {
    $secret = Read-Host 'Telegram bot token (stored encrypted for this Windows account)' -AsSecureString
    $secret | Export-Clixml -LiteralPath $tokenPath
}
$invitePath = Join-Path $RuntimeDirectory 'invite.txt'
if (-not (Test-Path -LiteralPath $invitePath)) {
    $newInvite = & $nodeExecutable -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
    Set-Content -LiteralPath $invitePath -Value $newInvite -NoNewline
}
$previousToken = $env:TELEGRAM_BOT_TOKEN
$previousInvite = $env:INVITE_CODE
$previousData = $env:DATA_DIR
try {
    $secret = Import-Clixml -LiteralPath $tokenPath
    $credential = [pscredential]::new('bot', $secret)
    $env:TELEGRAM_BOT_TOKEN = $credential.GetNetworkCredential().Password
    $env:INVITE_CODE = (Get-Content -LiteralPath $invitePath -Raw).Trim()
    $env:DATA_DIR = $RuntimeDirectory
    $process = Start-Process -FilePath $nodeExecutable -ArgumentList ('"{0}"' -f $nodeEntry) -WorkingDirectory $repoDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $RuntimeDirectory 'bot.log') -RedirectStandardError (Join-Path $RuntimeDirectory 'bot-error.log')
    Set-Content -LiteralPath $pidPath -Value $process.Id -NoNewline
    Start-Sleep -Seconds 3
    $process.Refresh()
    if ($process.HasExited) { throw 'Bot exited during startup. Inspect bot-error.log in the runtime directory.' }
    Write-Output ('MappiBot is running in the background. PID: {0}' -f $process.Id)
} finally {
    $env:TELEGRAM_BOT_TOKEN = $previousToken
    $env:INVITE_CODE = $previousInvite
    $env:DATA_DIR = $previousData
    $credential = $null
    $secret = $null
}
