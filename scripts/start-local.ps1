param([string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$repoDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $repoDirectory 'data' }
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd('\', '/')
if ($RuntimeDirectory -eq [IO.Path]::GetPathRoot($RuntimeDirectory).TrimEnd('\', '/') -or $RuntimeDirectory -eq $repoDirectory) {
    throw 'Choose a dedicated runtime directory, not a drive or repository root.'
}
New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
if ((Get-Item -LiteralPath $RuntimeDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime directory must not be a link.' }

function Runtime-File([string]$Name) {
    $result = [IO.Path]::GetFullPath((Join-Path $RuntimeDirectory $Name))
    if (-not $result.StartsWith($RuntimeDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime file path.' }
    if ((Test-Path -LiteralPath $result) -and ((Get-Item -LiteralPath $result).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Runtime files must not be links.' }
    return $result
}
function Recorded-Process([string]$Path) {
    $recordedId = 0
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and [int]::TryParse((Get-Content -LiteralPath $Path -Raw).Trim(), [ref]$recordedId) -and $recordedId -gt 0) {
        return Get-CimInstance Win32_Process -Filter "ProcessId = $recordedId" -ErrorAction SilentlyContinue
    }
    return $null
}
function Has-Argument($Record, [string]$Argument) {
    return $Record -and $Record.CommandLine -and [regex]::IsMatch($Record.CommandLine, '(?:^|\s)"?' + [regex]::Escape($Argument) + '"?(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function New-PrivateKey {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Own-TunnelProvider($Record) {
    if ($Record -and $Record.ExecutablePath -ieq $tunnelExecutable -and (Has-Argument $Record 'tunnel') -and (Has-Argument $Record $origin)) { return 'cloudflare' }
    $hasForward = (Has-Argument $Record '80:127.0.0.1:8787') -or (Has-Argument $Record '-R80:127.0.0.1:8787')
    if ($Record -and $Record.ExecutablePath -ieq $sshExecutable -and $hasForward -and (Has-Argument $Record 'nokey@localhost.run') -and $Record.CommandLine.Contains($knownHostsPath)) { return 'localhost.run' }
    return $null
}
function Read-TunnelUrl([string]$Provider) {
    $suffix = if ($Provider -eq 'cloudflare') { 'trycloudflare\.com' } else { '(?:localhost\.run|lhr\.life)' }
    foreach ($logPath in @($tunnelLogPath, $tunnelErrorPath)) {
        if (Test-Path -LiteralPath $logPath -PathType Leaf) {
            if ($Provider -eq 'localhost.run') {
                $logTail = (Select-String -LiteralPath $logPath -Pattern 'tunneled with tls termination' | Select-Object -Last 3 | ForEach-Object { $_.Line }) -join "`n"
            } else { $logTail = (Get-Content -LiteralPath $logPath -Tail 120 -ErrorAction SilentlyContinue) -join "`n" }
            $matches = @([regex]::Matches($logTail, '(?:https://|(?m)^)([a-z0-9][a-z0-9-]{0,62}\.' + $suffix + ')(?![a-zA-Z0-9.-])'))
            [array]::Reverse($matches)
            foreach ($urlMatch in $matches) {
                $hostName = $urlMatch.Groups[1].Value
                if ($hostName -notmatch '^(admin|www|api|ssh|docs)\.') { return 'https://' + $hostName }
            }
        }
    }
    return $null
}

$nodeEntry = Join-Path $repoDirectory 'src\main.mjs'
$nodeExecutable = (Get-Command node.exe).Source
$origin = 'http://127.0.0.1:8787'
$pidPath = Runtime-File 'bot.pid'
$tokenPath = Runtime-File 'telegram-token.xml'
$invitePath = Runtime-File 'invite.txt'
$previewPath = Runtime-File 'map-preview.txt'
$mapUrlPath = Runtime-File 'map-url.txt'
$stopPath = Runtime-File 'stop.request'
$tunnelPidPath = Runtime-File 'tunnel.pid'
$tunnelLogPath = Runtime-File 'tunnel.log'
$tunnelErrorPath = Runtime-File 'tunnel-error.log'
$tunnelExecutable = Runtime-File 'cloudflared.exe'
$sshExecutable = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$knownHostsPath = Runtime-File 'localhost-run-known-hosts'
$providerPath = Runtime-File 'tunnel-provider.txt'
$tunnelRecord = Recorded-Process $tunnelPidPath
$activeProvider = Own-TunnelProvider $tunnelRecord
$tunnelAlive = $null -ne $activeProvider
if (-not $tunnelAlive -and (Test-Path -LiteralPath $mapUrlPath -PathType Leaf)) { Remove-Item -LiteralPath $mapUrlPath }

$botRecord = Recorded-Process $pidPath
$botAlive = $botRecord -and $botRecord.Name -ieq 'node.exe' -and (Has-Argument $botRecord $nodeEntry)
if ($botAlive) {
    if (-not (Test-Path -LiteralPath $previewPath -PathType Leaf)) { throw 'The running bot predates the map setup. Stop it with stop-local.ps1, then start it again.' }
    Write-Output 'MappiBot is already running; checking its map and tunnel.'
} else {
    if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
        $secret = Read-Host 'Telegram bot token (encrypted for this Windows account)' -AsSecureString
        $secret | Export-Clixml -LiteralPath $tokenPath
        $secret = $null
    }
    if (-not (Test-Path -LiteralPath $invitePath -PathType Leaf)) { Set-Content -LiteralPath $invitePath -Value (New-PrivateKey) -Encoding Ascii -NoNewline }
    if (-not (Test-Path -LiteralPath $previewPath -PathType Leaf)) { Set-Content -LiteralPath $previewPath -Value (New-PrivateKey) -Encoding Ascii -NoNewline }
    if ((Get-Content -LiteralPath $invitePath -Raw).Trim() -notmatch '^[A-Za-z0-9_-]{16,64}$') { throw 'The saved invitation code has an invalid format.' }
    if ((Get-Content -LiteralPath $previewPath -Raw).Trim() -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'The saved preview key has an invalid format.' }
    if (Test-Path -LiteralPath $stopPath -PathType Leaf) { Remove-Item -LiteralPath $stopPath }

    $environmentNames = @('TELEGRAM_BOT_TOKEN', 'INVITE_CODE', 'DATA_DIR', 'MAP_PORT', 'MAP_PREVIEW_KEY', 'MAP_URL_FILE', 'MAP_URL', 'STOP_FILE')
    $previousEnvironment = @{}
    foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        $secret = Import-Clixml -LiteralPath $tokenPath
        $credential = [pscredential]::new('bot', $secret)
        $env:TELEGRAM_BOT_TOKEN = $credential.GetNetworkCredential().Password
        $env:INVITE_CODE = (Get-Content -LiteralPath $invitePath -Raw).Trim()
        $env:DATA_DIR = $RuntimeDirectory
        $env:MAP_PORT = '8787'
        $env:MAP_PREVIEW_KEY = (Get-Content -LiteralPath $previewPath -Raw).Trim()
        $env:MAP_URL_FILE = $mapUrlPath
        $env:MAP_URL = $null
        $env:STOP_FILE = $stopPath
        $process = Start-Process -FilePath $nodeExecutable -ArgumentList ('--env-file-if-exists=.env "{0}"' -f $nodeEntry) -WorkingDirectory $repoDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Runtime-File 'bot.log') -RedirectStandardError (Runtime-File 'bot-error.log')
        Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding Ascii -NoNewline
        $botRecord = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $process.Id) -ErrorAction SilentlyContinue
    } finally {
        foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
        $credential = $null
        $secret = $null
    }
}

# Do not publish another application that happens to occupy the configured port.
$mapReady = $false
$readyDeadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $readyDeadline) {
    $currentBot = Recorded-Process $pidPath
    if (-not $currentBot -or -not $botRecord -or $currentBot.ProcessId -ne $botRecord.ProcessId -or $currentBot.CreationDate -ne $botRecord.CreationDate -or -not (Has-Argument $currentBot $nodeEntry)) { throw 'Bot exited during startup. Inspect the runtime bot-error.log.' }
    $listeners = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
    if (@($listeners | Where-Object { $_.OwningProcess -ne $botRecord.ProcessId -or $_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) { throw 'Port 8787 must belong only to this bot on 127.0.0.1; the tunnel was not started.' }
    if ($listeners.Count -gt 0) {
        try { $health = Invoke-RestMethod -Uri ($origin + '/api/health') -TimeoutSec 2; $mapReady = $health.ok -eq $true } catch { $mapReady = $false }
        if ($mapReady) { break }
    }
    Start-Sleep -Milliseconds 400
}
if (-not $mapReady) { throw 'The bot is running but its map did not become ready. Inspect bot-error.log and restart with the latest code.' }

$preferredProvider = 'cloudflare'
if (Test-Path -LiteralPath $providerPath -PathType Leaf) {
    $savedProvider = (Get-Content -LiteralPath $providerPath -Raw).Trim()
    if ($savedProvider -in @('cloudflare', 'localhost.run')) { $preferredProvider = $savedProvider }
}
if ($tunnelAlive) { $preferredProvider = $activeProvider }
$providerAttempts = if ($preferredProvider -eq 'localhost.run') { @('localhost.run') } else { @('cloudflare', 'localhost.run') }
$publicUrl = $null
foreach ($provider in $providerAttempts) {
    try {
        if (-not $tunnelAlive) {
            if ($provider -eq 'cloudflare') {
                $launchExecutable = & (Join-Path $PSScriptRoot 'download-cloudflared.ps1') -RuntimeDirectory $RuntimeDirectory
                $launchArguments = @('tunnel', '--no-autoupdate', '--url', $origin)
            } else {
                if (-not (Test-Path -LiteralPath $sshExecutable -PathType Leaf)) { throw 'Windows OpenSSH client is not installed.' }
                $launchExecutable = $sshExecutable
                $launchArguments = @('-T', '-F', 'none', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=none', '-o', ('UserKnownHostsFile="{0}"' -f $knownHostsPath), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-R', '80:127.0.0.1:8787', 'nokey@localhost.run')
            }
            # Downloads can take time; recheck ownership immediately before exposing the origin.
            $currentBot = Recorded-Process $pidPath
            $listeners = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
            if (-not $currentBot -or $currentBot.ProcessId -ne $botRecord.ProcessId -or $currentBot.CreationDate -ne $botRecord.CreationDate -or -not (Has-Argument $currentBot $nodeEntry) -or $listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -ne $botRecord.ProcessId -or $_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) { throw 'The map origin changed during setup.' }
            $privateNames = @('TELEGRAM_BOT_TOKEN', 'INVITE_CODE', 'MAP_PREVIEW_KEY', 'EASYWAY_LOGIN', 'EASYWAY_PASSWORD')
            $previousPrivate = @{}
            foreach ($name in $privateNames) { $previousPrivate[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
            try {
                $tunnelProcess = Start-Process -FilePath $launchExecutable -ArgumentList $launchArguments -WorkingDirectory $RuntimeDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput $tunnelLogPath -RedirectStandardError $tunnelErrorPath
                Set-Content -LiteralPath $tunnelPidPath -Value $tunnelProcess.Id -Encoding Ascii -NoNewline
                $tunnelRecord = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $tunnelProcess.Id) -ErrorAction SilentlyContinue
            } finally {
                foreach ($name in $privateNames) { [Environment]::SetEnvironmentVariable($name, $previousPrivate[$name], 'Process') }
            }
        }
        $tunnelDeadline = [DateTime]::UtcNow.AddSeconds(35)
        do {
            $currentTunnel = Recorded-Process $tunnelPidPath
            if (-not $currentTunnel -or -not $tunnelRecord -or $currentTunnel.ProcessId -ne $tunnelRecord.ProcessId -or $currentTunnel.CreationDate -ne $tunnelRecord.CreationDate -or (Own-TunnelProvider $currentTunnel) -ne $provider) { throw 'Tunnel exited during startup.' }
            $publicUrl = Read-TunnelUrl $provider
            if (-not $publicUrl -and $tunnelAlive -and (Test-Path -LiteralPath $mapUrlPath -PathType Leaf)) {
                $savedUrl = (Get-Content -LiteralPath $mapUrlPath -Raw).Trim()
                $savedSuffix = if ($provider -eq 'cloudflare') { 'trycloudflare\.com' } else { '(?:localhost\.run|lhr\.life)' }
                if ($savedUrl -match ('^https://[a-z0-9][a-z0-9-]{0,62}\.' + $savedSuffix + '$') -and $savedUrl -notmatch '^https://(admin|www|api|ssh|docs)\.') { $publicUrl = $savedUrl }
            }
            if ($publicUrl) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $tunnelDeadline)
        if (-not $publicUrl) { throw 'Tunnel did not provide a URL within 35 seconds.' }
        Set-Content -LiteralPath $providerPath -Value $provider -Encoding Ascii -NoNewline
        break
    } catch {
        Write-Warning ('{0}: {1}' -f $provider, $_.Exception.Message)
        $currentTunnel = Recorded-Process $tunnelPidPath
        if ($currentTunnel -and $tunnelRecord -and $currentTunnel.ProcessId -eq $tunnelRecord.ProcessId -and $currentTunnel.CreationDate -eq $tunnelRecord.CreationDate -and (Own-TunnelProvider $currentTunnel) -eq $provider) { Stop-Process -Id $currentTunnel.ProcessId -Force }
        $tunnelAlive = $false
        $tunnelRecord = $null
        $publicUrl = $null
        if (Test-Path -LiteralPath $mapUrlPath -PathType Leaf) { Remove-Item -LiteralPath $mapUrlPath }
    }
}
if (-not $publicUrl) { throw 'No HTTPS tunnel became ready. The bot remains local; inspect tunnel-error.log and rerun this launcher.' }
$currentTunnel = Recorded-Process $tunnelPidPath
if (-not $currentTunnel -or -not $tunnelRecord -or $currentTunnel.ProcessId -ne $tunnelRecord.ProcessId -or $currentTunnel.CreationDate -ne $tunnelRecord.CreationDate -or -not (Own-TunnelProvider $currentTunnel)) { throw 'The tunnel stopped before setup completed; rerun this launcher.' }
Set-Content -LiteralPath $mapUrlPath -Value $publicUrl -Encoding Ascii -NoNewline
Write-Output ('MappiBot is running in the background. PID: {0}' -f $botRecord.ProcessId)
Write-Output ('Telegram map URL: {0}' -f $publicUrl)
Write-Output 'The bot updates its map menu within a few seconds. Keep this PC awake and online. A new tunnel gets a new URL.'
