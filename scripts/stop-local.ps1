param([string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$repoDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $repoDirectory 'data' }
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd('\', '/')
if ($RuntimeDirectory -eq [IO.Path]::GetPathRoot($RuntimeDirectory).TrimEnd('\', '/') -or $RuntimeDirectory -eq $repoDirectory) { throw 'Choose the dedicated runtime directory.' }
if (-not (Test-Path -LiteralPath $RuntimeDirectory -PathType Container)) { Write-Output 'No local runtime directory found.'; return }
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
function Remove-OwnPid([string]$Path, [int]$ExpectedId) {
    $savedId = 0
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and [int]::TryParse((Get-Content -LiteralPath $Path -Raw).Trim(), [ref]$savedId) -and $savedId -eq $ExpectedId) { Remove-Item -LiteralPath $Path }
}
function Is-OwnTunnel($Record) {
    if ($Record -and $Record.ExecutablePath -ieq $tunnelExecutable -and (Has-Argument $Record 'tunnel') -and (Has-Argument $Record $origin)) { return $true }
    $hasForward = (Has-Argument $Record '80:127.0.0.1:8787') -or (Has-Argument $Record '-R80:127.0.0.1:8787')
    return $Record -and $Record.ExecutablePath -ieq $sshExecutable -and $hasForward -and (Has-Argument $Record 'nokey@localhost.run') -and $Record.CommandLine.Contains($knownHostsPath)
}

$pidPath = Runtime-File 'bot.pid'
$stopPath = Runtime-File 'stop.request'
$tunnelPidPath = Runtime-File 'tunnel.pid'
$mapUrlPath = Runtime-File 'map-url.txt'
$nodeEntry = Join-Path $repoDirectory 'src\main.mjs'
$tunnelExecutable = Runtime-File 'cloudflared.exe'
$sshExecutable = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$knownHostsPath = Runtime-File 'localhost-run-known-hosts'
$origin = 'http://127.0.0.1:8787'
$forced = $false
$botRecord = Recorded-Process $pidPath
if ($botRecord -and $botRecord.Name -ieq 'node.exe' -and (Has-Argument $botRecord $nodeEntry)) {
    Set-Content -LiteralPath $stopPath -Value 'stop' -Encoding Ascii -NoNewline
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $currentBot = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $botRecord.ProcessId) -ErrorAction SilentlyContinue
        $sameBot = $currentBot -and $currentBot.CreationDate -eq $botRecord.CreationDate -and $currentBot.Name -ieq 'node.exe' -and (Has-Argument $currentBot $nodeEntry)
    } while ($sameBot -and [DateTime]::UtcNow -lt $stopDeadline)
    if ($sameBot) {
        Stop-Process -Id $currentBot.ProcessId -Force -ErrorAction Stop
        $forced = $true
    }
    $remainingBot = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $botRecord.ProcessId) -ErrorAction SilentlyContinue
    if (-not $remainingBot -or $remainingBot.CreationDate -ne $botRecord.CreationDate) { Remove-OwnPid $pidPath $botRecord.ProcessId }
    Write-Output 'MappiBot stopped.'
} elseif ($botRecord) {
    Write-Output 'Recorded PID belongs to another process; it was left untouched.'
} else {
    Write-Output 'MappiBot is not running.'
}

$tunnelRecord = Recorded-Process $tunnelPidPath
if (Is-OwnTunnel $tunnelRecord) {
    $currentTunnel = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $tunnelRecord.ProcessId) -ErrorAction SilentlyContinue
    if ($currentTunnel -and $currentTunnel.CreationDate -eq $tunnelRecord.CreationDate -and (Is-OwnTunnel $currentTunnel)) { Stop-Process -Id $currentTunnel.ProcessId -Force -ErrorAction Stop }
    $remainingTunnel = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $tunnelRecord.ProcessId) -ErrorAction SilentlyContinue
    if (-not $remainingTunnel -or $remainingTunnel.CreationDate -ne $tunnelRecord.CreationDate) {
        Remove-OwnPid $tunnelPidPath $tunnelRecord.ProcessId
        if (Test-Path -LiteralPath $mapUrlPath -PathType Leaf) { Remove-Item -LiteralPath $mapUrlPath }
    }
    Write-Output 'HTTPS tunnel stopped.'
} elseif ($tunnelRecord) {
    Write-Output 'Recorded tunnel PID belongs to another process; it was left untouched.'
} elseif (Test-Path -LiteralPath $mapUrlPath -PathType Leaf) {
    Remove-Item -LiteralPath $mapUrlPath
}
if ($forced) { Write-Output 'The bot required a forced stop. Wait up to 60 seconds for its process lock to expire before restarting.' }
Write-Output 'Credentials, invitation code, preview key, favourites, and logs are preserved.'
