[CmdletBinding()]
param(
    [switch]$BuildOnly,
    [switch]$LinuxDesktop
)

$ErrorActionPreference = 'Stop'

function Invoke-BuildStep {
    param([string]$Label, [string]$Command, [string[]]$CommandArguments)
    Write-Host $Label -ForegroundColor Cyan
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell treats ordinary native stderr as error records.
        $ErrorActionPreference = 'Continue'
        & $Command @CommandArguments
        $stepExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($stepExitCode -ne 0) {
        throw "$Label failed with exit code $stepExitCode. No installer was started."
    }
}

$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousTmpDir = $env:TMPDIR
$previousCI = $env:CI
$previousSkipBuild = $env:T3CODE_DESKTOP_SKIP_BUILD
$buildTemp = $null
$exitCode = 0

try {
    $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    Set-Location -LiteralPath $repoRoot
    Get-Command git, vp, docker -ErrorAction Stop | Out-Null
    $version = (Get-Content -LiteralPath 'apps/server/package.json' -Raw | ConvertFrom-Json).version
    $outputRoot = Join-Path $repoRoot 'release/custom'
    $linuxOutput = Join-Path $outputRoot 'linux'
    $windowsOutput = Join-Path $outputRoot 'windows'
    New-Item -ItemType Directory -Path $linuxOutput,$windowsOutput -Force | Out-Null
    $env:CI = 'true'
    $env:T3CODE_DESKTOP_SKIP_BUILD = 'false'

    Invoke-BuildStep 'Installing build dependencies...' 'vp' @('install','--frozen-lockfile')
    Invoke-BuildStep 'Checking the Linux build environment...' 'docker' @('info','--format','{{.OSType}}')
    $builderImage = 't3code-linux-builder:local'
    $imageCheckPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker image inspect $builderImage --format '{{.Id}}' *> $null
        $builderExists = $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $imageCheckPreference
    }
    if (-not $builderExists) {
        Invoke-BuildStep 'Preparing the Linux compiler image...' 'docker' @(
            'build','--platform','linux/amd64','--tag',$builderImage,
            (Join-Path $repoRoot 'scripts/linux-custom-builder')
        )
    }
    $linuxDesktopFlag = if ($LinuxDesktop) { '1' } else { '0' }
    Invoke-BuildStep 'Building the matching Linux runtime...' 'docker' @(
        'run','--rm','--platform','linux/amd64',
        '--mount',"type=bind,source=$repoRoot,target=/source,readonly",
        '--mount',"type=bind,source=$linuxOutput,target=/output",
        '--mount','type=volume,source=t3code-linux-build-cache,target=/home/vp/.cache',
        '--env','CI=true','--env',"BUILD_LINUX_DESKTOP=$linuxDesktopFlag",
        '--entrypoint','bash',$builderImage,'/source/scripts/build-custom-linux.sh'
    )

    $runtime = Join-Path $linuxOutput "t3-$version-linux-x64.tar.gz"
    if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) {
        throw 'The matching Linux runtime was not produced. No installer was started.'
    }

    $driveRoot = [IO.Path]::GetPathRoot($repoRoot)
    if (Test-Path -LiteralPath (Join-Path $driveRoot 'node_modules')) {
        throw 'Drive-level node_modules prevents the isolated package check.'
    }
    $buildTemp = Join-Path $driveRoot ('t3code-custom-build-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $buildTemp | Out-Null
    $env:TEMP = $buildTemp
    $env:TMP = $buildTemp
    $env:TMPDIR = $buildTemp

    Invoke-BuildStep 'Building the T3 Code (Custom) Windows installer...' 'vp' @(
        'run','dist:desktop:artifact','--platform','win','--target','nsis',
        '--arch','x64','--build-version',$version,'--wsl-runtime',$runtime,
        '--output-dir',$windowsOutput
    )
    $installer = Join-Path $windowsOutput "T3-Code-Custom-$version-x64.exe"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw 'The custom installer was not produced. No installer was started.'
    }
    $sourceCommit = (& git rev-parse HEAD).Trim()
    $record = [ordered]@{
        version = $version
        sourceCommit = $sourceCommit
        installer = $installer
        installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        wslRuntimeSha256 = (Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [IO.File]::WriteAllText(
        (Join-Path $outputRoot 'BUILD.json'),
        ($record | ConvertTo-Json) + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host "Built from checkout $sourceCommit" -ForegroundColor Green
    Write-Host "Installer: $installer" -ForegroundColor Green

    if (-not $BuildOnly) {
        Write-Host 'Quit T3 Code fully before installing the new client.' -ForegroundColor Yellow
        Read-Host 'Press Enter after quitting T3 Code to start the installer' | Out-Null
        $clientNames = @('T3 Code (Alpha)','T3 Code (Nightly)','T3 Code (Custom)','T3 Code','t3code')
        while (@(Get-Process -Name $clientNames -ErrorAction SilentlyContinue).Count -gt 0) {
            Read-Host 'T3 Code is still running. Use File > Quit, then press Enter' | Out-Null
        }
        $installerTemp = Join-Path $outputRoot 'installer-temp'
        New-Item -ItemType Directory -Path $installerTemp -Force | Out-Null
        $env:TEMP = $installerTemp
        $env:TMP = $installerTemp
        $env:TMPDIR = $installerTemp
        $installed = Start-Process -FilePath $installer -Wait -PassThru
        if ($installed.ExitCode -notin @(0,3010)) {
            throw "Installer exited with code $($installed.ExitCode)."
        }
        & (Join-Path $PSScriptRoot 'refresh-custom-icon.ps1')
        Write-Host 'Custom client installed. Look for T3 Code (Custom) in its sidebar.' -ForegroundColor Green
    }
} catch {
    Write-Host ("Build/install stopped: " + $_.Exception.Message) -ForegroundColor Red
    $exitCode = 1
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    $env:TMPDIR = $previousTmpDir
    $env:CI = $previousCI
    $env:T3CODE_DESKTOP_SKIP_BUILD = $previousSkipBuild
    if ($buildTemp -and (Test-Path -LiteralPath $buildTemp)) {
        $expectedTemp = [IO.Path]::GetFullPath($buildTemp)
        $resolvedTemp = (Resolve-Path -LiteralPath $buildTemp).Path
        if ($resolvedTemp -ne $expectedTemp -or
            ((Get-Item -LiteralPath $resolvedTemp).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing to clean an unexpected temporary directory.'
        }
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
exit $exitCode
