param([Parameter(Mandatory = $true)][string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd('\', '/')
if ($RuntimeDirectory -eq [IO.Path]::GetPathRoot($RuntimeDirectory).TrimEnd('\', '/')) { throw 'Choose a dedicated runtime directory.' }
New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
if ((Get-Item -LiteralPath $RuntimeDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime directory must not be a link.' }

# Pin both the official release and its published SHA-256; never run an unverified download.
# https://github.com/cloudflare/cloudflared/releases/tag/2026.9.1
$version = '2026.9.1'
if ([Environment]::Is64BitOperatingSystem) {
    $assetName = 'cloudflared-windows-amd64.exe'
    $expectedHash = '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712'
} else {
    $assetName = 'cloudflared-windows-386.exe'
    $expectedHash = '11b6e4b2d306950bd87e7caa4deee8e80a32d71ffee555a96237a76651eeae4c'
}
$downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/download/' + $version + '/' + $assetName
$executablePath = [IO.Path]::GetFullPath((Join-Path $RuntimeDirectory 'cloudflared.exe'))
$temporaryPath = [IO.Path]::GetFullPath((Join-Path $RuntimeDirectory ('cloudflared-' + $version + '.download')))
foreach ($filePath in @($executablePath, $temporaryPath)) {
    if (-not $filePath.StartsWith($RuntimeDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid download destination.' }
    if ((Test-Path -LiteralPath $filePath) -and ((Get-Item -LiteralPath $filePath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Download destination must not be a link.' }
}
if (Test-Path -LiteralPath $executablePath -PathType Leaf) {
    if ((Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash -ine $expectedHash) { throw 'Existing cloudflared.exe does not match the pinned official release. It was not replaced or executed.' }
    return $executablePath
}
try {
    Invoke-WebRequest -Uri $downloadUrl -UseBasicParsing -OutFile $temporaryPath -TimeoutSec 120 -UserAgent 'MappiBot-local-setup'
    if ((Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash -ine $expectedHash) { throw 'Cloudflare download checksum did not match the official release.' }
    Move-Item -LiteralPath $temporaryPath -Destination $executablePath
    return $executablePath
} finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath }
}
