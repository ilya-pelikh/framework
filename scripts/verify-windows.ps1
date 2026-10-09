$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$verification = Join-Path ([IO.Path]::GetTempPath()) ('islands-verification-' + [Guid]::NewGuid().ToString('N'))
$project = Join-Path $verification 'project'
New-Item -ItemType Directory -Path $project -Force | Out-Null
Write-Output "Verification directory: $verification"

function Copy-SourceTree([string]$From, [string]$To) {
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
        if ($item.Name -in @('node_modules', 'dist', '.cache', '.git', '.agents', '.codex')) { continue }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unexpected source link: $($item.FullName)" }
        $target = Join-Path $To $item.Name
        if ($item.PSIsContainer) { Copy-SourceTree $item.FullName $target }
        else { Copy-Item -LiteralPath $item.FullName -Destination $target }
    }
}

function Invoke-Step([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Verification step failed: $Executable $($Arguments -join ' ')" }
}

foreach ($directory in @('apps', 'packages', 'scripts', 'tests', '.github', 'deployment')) {
    Copy-SourceTree (Join-Path $source $directory) (Join-Path $project $directory)
}
foreach ($file in @('package.json', 'package-lock.json', 'tsconfig.json', 'types.d.ts', '.npmrc')) {
    $path = Join-Path $source $file
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $project }
}
Push-Location $project
try {
    Invoke-Step 'node' @('--version')
    if ((& npm.cmd --version) -ne '11.19.1') { throw 'Expected npm 11.19.1' }
    $env:ISLANDS_BUILD_ROOT = $project
    $env:RELEASE_ID = $null
    $env:REGISTRY_PATH = ''
    Invoke-Step 'npm.cmd' @('ci', '--fetch-retries=0', '--fetch-timeout=15000')
    Invoke-Step 'npm.cmd' @('run', 'typecheck')
    Invoke-Step 'npm.cmd' @('test')
    Invoke-Step 'npm.cmd' @('run', 'build')
    Invoke-Step 'node' @('--import', 'tsx', 'tests/start-smoke.ts')
    Invoke-Step 'npx.cmd' @('playwright', 'install', 'chromium')
    Invoke-Step 'npm.cmd' @('run', 'test:hardening')
    Invoke-Step 'npm.cmd' @('run', 'test:load')
    Invoke-Step 'node' @('--import', 'tsx', 'tests/build-smoke.ts')
    Invoke-Step 'node' @('--import', 'tsx', 'tests/build-browser-smoke.ts')
    Invoke-Step 'npm.cmd' @('run', 'test:e2e')
    $env:RELEASE_ID = 'v2'
    Invoke-Step 'npm.cmd' @('run', 'build', '--workspace', '@islands/catalog')
    Invoke-Step 'node' @('--import', 'tsx', 'tests/deploy-release.e2e.ts')
    Invoke-Step 'node' @('--import', 'tsx', 'tests/dev-smoke.ts')
    Invoke-Step 'npm.cmd' @('run', 'security:report')
    Write-Output "PASS: clean Windows verification ($verification)"
} finally { Pop-Location }
