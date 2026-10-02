<#
.SYNOPSIS
    Run the automated screenshot capture: clean up stale browser, launch headless
    Edge with CDP enabled, wait for the debug port, then drive capture-screenshots.mjs.

.DESCRIPTION
    Why a script instead of starting the browser by hand:
    the headless browser must stay alive while its parent process is alive, so
    "launch browser -> wait for CDP -> capture -> exit" runs inside a single call.
    When the call returns, the browser is recycled together with the parent.

    It also kills leftover browser processes that still hold this script's private
    profile, because Chromium hands a second launch with the same profile over to
    the old instance (which then has no working debug port).

    NOTE: keep this file ASCII-only. Windows PowerShell reads .ps1 files as ANSI
    when there is no BOM, so non-ASCII text here would be mangled.

.EXAMPLE
    & .\run-capture.ps1 -Shots home-empty,decimal,dark-theme
#>
param(
    [Parameter(Mandatory = $true)][string[]]$Shots,
    [int]$Port = 9225,
    [string]$EdgePath = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$profileDir = Join-Path $root '.edge-cdp'
$profileTag = '.edge-cdp'
$captureScript = Join-Path $PSScriptRoot 'capture-screenshots.mjs'

if (-not (Test-Path $EdgePath)) { throw "Browser not found: $EdgePath" }
if (-not (Test-Path $captureScript)) { throw "Capture script not found: $captureScript" }

# 1) Kill leftover browser processes that hold our private profile only.
$stale = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileTag) }
foreach ($process in $stale) {
    Write-Output "killing stale browser pid=$($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($stale) { Start-Sleep -Seconds 2 }

Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue

# 2) Launch the browser and wait for the CDP endpoint.
$version = $null
for ($attempt = 1; $attempt -le 3 -and -not $version; $attempt++) {
    Start-Process -FilePath $EdgePath -ArgumentList @(
        '--headless=new'
        '--disable-gpu'
        '--no-first-run'
        '--no-default-browser-check'
        '--disable-features=Translate'
        "--remote-debugging-port=$Port"
        '--remote-allow-origins=*'
        "--user-data-dir=$profileDir"
        '--window-size=1440,1150'
        'about:blank'
    )
    for ($tick = 0; $tick -lt 40; $tick++) {
        try {
            $version = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
            break
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $version) { Write-Output "attempt $attempt not ready, retrying" }
}

if (-not $version) { Write-Output 'CDP_NOT_READY'; exit 1 }
Write-Output "CDP ready: $($version.Browser)"

# 3) Hand over to the Node capture script.
$env:CDP_PORT = "$Port"
& node $captureScript @Shots
exit $LASTEXITCODE
