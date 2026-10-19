<#
.SYNOPSIS
    Install pi2web globally from a Git branch.

.DESCRIPTION
    Keeps a dedicated clone in a fixed directory, checks out the requested
    branch at its latest remote commit, builds it, packs it, and installs the
    packed tarball globally with npm.

    Installing straight from a Git URL (npm install -g github:...#branch) is
    not used because it fails on Windows with npm 11. Installing the packed
    tarball also lets the native modules (better-sqlite3, node-pty) run their
    install scripts, which npm 11 otherwise blocks.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Branch main -Dir D:\pi2web-src

.EXAMPLE
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/sxwxs/pi2web/feat/backend-relay/scripts/install.ps1)))
#>
[CmdletBinding()]
param(
    [string]$Branch = $(if ($env:PI2WEB_BRANCH) { $env:PI2WEB_BRANCH } else { 'feat/backend-relay' }),
    [string]$Repo = $(if ($env:PI2WEB_REPO) { $env:PI2WEB_REPO } else { 'https://github.com/sxwxs/pi2web.git' }),
    [string]$Dir = $(if ($env:PI2WEB_SRC_DIR) { $env:PI2WEB_SRC_DIR } else { Join-Path $env:LOCALAPPDATA 'pi2web\src' }),
    # Discard local changes and untracked files in the clone instead of stopping.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$NativeScripts = 'better-sqlite3,node-pty'
$MinNode = [version]'22.19.0'

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $File $($Arguments -join ' ')"
    }
}

function Get-Output {
    param([string]$File, [string[]]$Arguments)
    $output = & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $File $($Arguments -join ' ')"
    }
    return ($output -join "`n").Trim()
}

foreach ($tool in 'git', 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool was not found in PATH."
    }
}

$nodeVersion = [version]((Get-Output node @('--version')).TrimStart('v'))
if ($nodeVersion -lt $MinNode) {
    throw "pi2web needs Node.js $MinNode or later; found $nodeVersion."
}

Write-Host "pi2web source : $Dir"
Write-Host "Repository    : $Repo"
Write-Host "Branch        : $Branch"

if (Test-Path (Join-Path $Dir '.git')) {
    $origin = Get-Output git @('-C', $Dir, 'remote', 'get-url', 'origin')
    if ($origin -ne $Repo) {
        throw "$Dir is a clone of $origin, not $Repo. Use -Dir to pick another directory."
    }

    $dirty = Get-Output git @('-C', $Dir, 'status', '--porcelain')
    if ($dirty) {
        if (-not $Force) {
            throw "$Dir has local changes. Re-run with -Force to discard them."
        }
        Write-Host 'Discarding local changes (-Force)...'
        Invoke-Checked git @('-C', $Dir, 'reset', '--hard')
        Invoke-Checked git @('-C', $Dir, 'clean', '-fdx', '-e', 'node_modules/')
    }

    Write-Host 'Fetching...'
    Invoke-Checked git @('-C', $Dir, 'fetch', '--prune', 'origin')
}
elseif (Test-Path $Dir) {
    if (Get-ChildItem -Force $Dir | Select-Object -First 1) {
        throw "$Dir exists and is not a Git clone. Remove it or use -Dir."
    }
    Invoke-Checked git @('clone', '--no-checkout', $Repo, $Dir)
}
else {
    $parent = Split-Path $Dir
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force $parent | Out-Null
    }
    Invoke-Checked git @('clone', '--no-checkout', $Repo, $Dir)
}

& git -C $Dir rev-parse --verify --quiet "refs/remotes/origin/$Branch" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Branch $Branch was not found on $Repo."
}
Invoke-Checked git @('-C', $Dir, 'checkout', '-B', $Branch, "origin/$Branch")
$commit = Get-Output git @('-C', $Dir, 'log', '-1', '--format=%h %s')
Write-Host "Checked out   : $commit"

$packDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pi2web-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $packDir | Out-Null
Push-Location $Dir
try {
    Write-Host 'Installing build dependencies (npm ci)...'
    Invoke-Checked npm @('ci', '--no-audit', '--no-fund')

    # prepack runs the TypeScript build.
    Write-Host 'Building and packing...'
    Invoke-Checked npm @('pack', '--pack-destination', $packDir)
    $tarball = Get-ChildItem -Path $packDir -Filter 'pi2web-*.tgz' | Select-Object -First 1
    if (-not $tarball) {
        throw "npm pack did not produce a tarball in $packDir."
    }

    Write-Host 'Installing globally...'
    Invoke-Checked npm @('install', '-g', $tarball.FullName, "--allow-scripts=$NativeScripts", '--no-audit', '--no-fund')
}
finally {
    Pop-Location
    Remove-Item -Recurse -Force $packDir -ErrorAction SilentlyContinue
}

$globalRoot = Get-Output npm @('root', '-g')
$installed = Join-Path $globalRoot 'pi2web'
Push-Location $installed
try {
    Invoke-Checked node @('-e', "new (require('better-sqlite3'))(':memory:'); require('node-pty');")
}
finally {
    Pop-Location
}

$version = Get-Output pi2web @('--version')
Write-Host ''
Write-Host "Installed pi2web $version from $Branch ($commit)." -ForegroundColor Green
Write-Host 'Run the same command again to update to the latest commit on the branch.'
