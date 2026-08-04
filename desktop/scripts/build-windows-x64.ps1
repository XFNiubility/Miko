[CmdletBinding()]
param(
  [ValidateSet('', 'msi', 'nsis')]
  [string]$Bundle = '',

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArgs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = (Resolve-Path (Join-Path $scriptDir '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopDir '..')).Path

$targetTriple = 'x86_64-pc-windows-msvc'
$tauriTargetDir = Join-Path $desktopDir 'src-tauri\target'
$canonicalOutputDir = Join-Path $desktopDir 'build-artifacts\windows-x64'
$activeOutputDir = $canonicalOutputDir
$appVersion = (Get-Content -Path (Join-Path $desktopDir 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$windowsBundle = if ($Bundle) { $Bundle } elseif ($env:TAURI_WINDOWS_BUNDLE) { $env:TAURI_WINDOWS_BUNDLE } else { 'nsis' }

if (@('msi', 'nsis') -notcontains $windowsBundle) {
  throw "[build-windows-x64] Unsupported Windows bundle '$windowsBundle'. Use 'msi' or 'nsis'."
}

function Write-Step {
  param([string]$Message)
  Write-Host "[build-windows-x64] $Message"
}

function Assert-WindowsHost {
  if ($env:OS -ne 'Windows_NT') {
    throw '[build-windows-x64] This script must run on Windows.'
  }
}

function Assert-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "[build-windows-x64] Missing required command: $Name"
  }
}

function Test-TauriSigningKey {
  return [bool]($env:TAURI_SIGNING_PRIVATE_KEY -or $env:TAURI_SIGNING_PRIVATE_KEY_PATH)
}

function Assert-SecureUpdaterEndpoint {
  param([string]$Endpoint)

  if (-not $Endpoint) {
    return
  }

  try {
    $uri = [System.Uri]::new($Endpoint)
  } catch {
    throw "[build-windows-x64] LOCAL_UPDATE_ENDPOINT must be an absolute HTTPS URL. Received: $Endpoint"
  }

  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https') {
    throw "[build-windows-x64] LOCAL_UPDATE_ENDPOINT must use https. Tauri updater rejects insecure endpoints at app startup. Received: $Endpoint"
  }
}

function Add-PathEntryIfExists {
  param([string]$PathEntry)

  if ((Test-Path $PathEntry) -and -not (($env:Path -split ';') -contains $PathEntry)) {
    $env:Path = "$PathEntry;$env:Path"
  }
}

function Import-VsDevEnvironment {
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw '[build-windows-x64] Could not find vswhere.exe. Install Visual Studio 2022 Build Tools with the C++ workload.'
  }

  $installationPath = & $vswhere `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath |
    Select-Object -First 1

  if (-not $installationPath) {
    throw '[build-windows-x64] Missing Visual C++ build tools. Install the "Desktop development with C++" / VC.Tools.x86.x64 workload first.'
  }

  $vsDevCmd = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $vsDevCmd)) {
    throw "[build-windows-x64] Could not find VsDevCmd.bat under $installationPath"
  }

  Write-Step "Importing MSVC environment from $vsDevCmd"

  $env:VSCMD_SKIP_SENDTELEMETRY = '1'
  $envDump = & cmd.exe /d /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] Failed to initialize Visual Studio build environment (exit $LASTEXITCODE)"
  }

  foreach ($line in $envDump) {
    if ($line -match '^(.*?)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

function Get-RustCargoBinDir {
  return Join-Path $env:USERPROFILE '.cargo\bin'
}

function Get-BunBinDir {
  return Join-Path $env:USERPROFILE '.bun\bin'
}

function Get-NsisBinDirs {
  return @(
    (Join-Path (Split-Path -Parent $repoRoot) '.build-tools\nsis-3.11\nsis-3.11\Bin'),
    (Join-Path $env:ProgramFiles 'NSIS'),
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS')
  ) | Where-Object { $_ }
}

function Ensure-BuildToolPaths {
  Add-PathEntryIfExists (Get-BunBinDir)
  Add-PathEntryIfExists (Get-RustCargoBinDir)
  foreach ($nsisDir in Get-NsisBinDirs) {
    Add-PathEntryIfExists $nsisDir
  }
}

function Test-NsisAvailable {
  return [bool](Get-Command makensis -ErrorAction SilentlyContinue)
}

function Get-LatestArtifact {
  param(
    [string[]]$SearchRoots,
    [string[]]$Patterns,
    [datetime]$ModifiedSince = [datetime]::MinValue
  )

  foreach ($root in $SearchRoots) {
    if (-not (Test-Path $root)) {
      continue
    }

    foreach ($pattern in $Patterns) {
      $match = Get-ChildItem -Path $root -File -Filter $pattern -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $ModifiedSince } |
        Sort-Object Name |
        Select-Object -Last 1

      if ($match) {
        return $match
      }
    }
  }

  return $null
}

function Get-StagedArtifactName {
  param([string]$ArtifactName)

  switch -Regex ($ArtifactName) {
    '^latest\.json$' { return 'latest.json' }
    '\.exe\.sig$' { return "Miko_${appVersion}_windows_x64_nsis.exe.sig" }
    '\.exe$' { return "Miko_${appVersion}_windows_x64_nsis.exe" }
    '\.msi\.zip\.sig$' { return "Miko_${appVersion}_windows_x64_msi.msi.zip.sig" }
    '\.msi\.zip$' { return "Miko_${appVersion}_windows_x64_msi.msi.zip" }
    '\.msi\.sig$' { return "Miko_${appVersion}_windows_x64_msi.msi.sig" }
    '\.msi$' { return "Miko_${appVersion}_windows_x64_msi.msi" }
    default { return $ArtifactName }
  }
}

function Get-LocalUpdaterDownloadUrl {
  param(
    [string]$Endpoint,
    [string]$ArtifactName
  )

  $endpointUri = [System.Uri]::new($Endpoint)
  $builder = [System.UriBuilder]::new($endpointUri.Scheme, $endpointUri.Host, $endpointUri.Port)
  $builder.Path = "download/$([System.Uri]::EscapeDataString($ArtifactName))"
  return $builder.Uri.AbsoluteUri
}

function Resolve-OutputDirectory {
  param([string]$PreferredPath)

  New-Item -ItemType Directory -Force -Path $PreferredPath | Out-Null

  $existingArtifacts = Get-ChildItem -Path $PreferredPath -Force -ErrorAction SilentlyContinue
  foreach ($artifact in $existingArtifacts) {
    try {
      Remove-Item -LiteralPath $artifact.FullName -Force -Recurse
    } catch {
      $fallbackPath = "$PreferredPath-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Write-Step "Could not clear locked artifact '$($artifact.FullName)'. Using fallback output directory: $fallbackPath"
      New-Item -ItemType Directory -Force -Path $fallbackPath | Out-Null
      return $fallbackPath
    }
  }

  return $PreferredPath
}

Assert-WindowsHost
Ensure-BuildToolPaths
Assert-Command bun

Import-VsDevEnvironment

Assert-Command cargo
Assert-Command rustc
Assert-Command bunx

if ($windowsBundle -eq 'nsis' -and -not (Test-NsisAvailable)) {
  Write-Step 'NSIS makensis.exe not found locally; Tauri will try to download nsis-3.11 during bundling.'
}

if (-not $env:CLAUDE_CODE_BUN_TARGET) {
  $env:CLAUDE_CODE_BUN_TARGET = 'bun-windows-x64'
  Write-Step 'Using CLAUDE_CODE_BUN_TARGET=bun-windows-x64 for local Windows sidecar build'
}

if ($env:SKIP_INSTALL -ne '1') {
  Write-Step 'Installing root dependencies...'
  Push-Location $repoRoot
  try {
    & bun install
    if ($LASTEXITCODE -ne 0) {
      throw "[build-windows-x64] bun install failed in repo root (exit $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }

  Write-Step 'Installing desktop dependencies...'
  Push-Location $desktopDir
  try {
    & bun install
    if ($LASTEXITCODE -ne 0) {
      throw "[build-windows-x64] bun install failed in desktop (exit $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }

  $adaptersDir = Join-Path $repoRoot 'adapters'
  if (Test-Path (Join-Path $adaptersDir 'package.json')) {
    Write-Step 'Installing adapter dependencies...'
    Push-Location $adaptersDir
    try {
      & bun install
      if ($LASTEXITCODE -ne 0) {
        throw "[build-windows-x64] bun install failed in adapters (exit $LASTEXITCODE)"
      }
    } finally {
      Pop-Location
    }
  }
}

$tauriBuildArgs = @(
  'tauri',
  'build',
  '--target',
  $targetTriple,
  '--bundles',
  $windowsBundle,
  '--ci'
)

$tempConfigPath = $null
$hasTauriSigningKey = Test-TauriSigningKey
if ($env:LOCAL_UPDATE_ENDPOINT -or $env:LOCAL_UPDATE_PUBKEY -or -not $hasTauriSigningKey -or $windowsBundle -eq 'nsis') {
  Assert-SecureUpdaterEndpoint -Endpoint $env:LOCAL_UPDATE_ENDPOINT
  $tempConfigPath = Join-Path ([System.IO.Path]::GetTempPath()) 'cc-haha.tauri.local.windows.json'
  $tempConfigObject = @{}
  $updaterConfig = @{}
  if ($env:LOCAL_UPDATE_ENDPOINT) {
    $updaterConfig.endpoints = @($env:LOCAL_UPDATE_ENDPOINT)
    Write-Step "Using local updater endpoint: $env:LOCAL_UPDATE_ENDPOINT"
  }
  if ($env:LOCAL_UPDATE_PUBKEY) {
    $updaterConfig.pubkey = $env:LOCAL_UPDATE_PUBKEY
    Write-Step 'Using local updater public key from LOCAL_UPDATE_PUBKEY'
  }
  if ($updaterConfig.Count -gt 0) {
    $tempConfigObject.plugins = @{
      updater = $updaterConfig
    }
  }
  if (-not $hasTauriSigningKey) {
    $tempConfigObject.bundle = @{
      createUpdaterArtifacts = $false
    }
    Write-Step 'TAURI_SIGNING_PRIVATE_KEY/TAURI_SIGNING_PRIVATE_KEY_PATH not set, disabling updater artifacts for local build'
  }
  if ($windowsBundle -eq 'nsis') {
    if (-not $tempConfigObject.ContainsKey('bundle')) {
      $tempConfigObject.bundle = @{}
    }
    $tempConfigObject.bundle.useLocalToolsDir = $true
    Write-Step 'Using Tauri local tools dir for NSIS bundling'
  }
  $tempConfig = $tempConfigObject | ConvertTo-Json -Depth 10
  Set-Content -Path $tempConfigPath -Value $tempConfig -Encoding UTF8
  $tauriBuildArgs += @('--config', $tempConfigPath)
}

if ($null -ne $TauriArgs) {
  $remainingArgs = @($TauriArgs)
  if ($remainingArgs.Count -gt 0) {
    $tauriBuildArgs += $remainingArgs
  }
}

Write-Step "Building Windows desktop app for $targetTriple"
Write-Step "Windows bundle: $windowsBundle"
$buildStartedAt = Get-Date

Push-Location $desktopDir
try {
  $env:TAURI_ENV_TARGET_TRIPLE = $targetTriple
  & bunx @tauriBuildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] tauri build failed (exit $LASTEXITCODE)"
  }
} finally {
  Pop-Location
  if ($tempConfigPath -and (Test-Path $tempConfigPath)) {
    Remove-Item -LiteralPath $tempConfigPath -Force
  }
}

$activeOutputDir = Resolve-OutputDirectory -PreferredPath $canonicalOutputDir

$bundleRoots = @(
  (Join-Path $tauriTargetDir "$targetTriple\release\bundle"),
  (Join-Path $tauriTargetDir 'release\bundle')
)

$artifactPatterns = if ($windowsBundle -eq 'nsis') { @('*.exe') } else { @('*.msi') }
if ($hasTauriSigningKey) {
  if ($windowsBundle -eq 'nsis') {
    $artifactPatterns += '*.exe.sig'
  } else {
    $artifactPatterns += @('*.msi.sig', '*.msi.zip', '*.msi.zip.sig')
  }
  $artifactPatterns += 'latest.json'
}
$copiedArtifacts = New-Object System.Collections.Generic.List[string]

foreach ($root in $bundleRoots) {
  if (-not (Test-Path $root)) {
    continue
  }

  foreach ($pattern in $artifactPatterns) {
    $artifacts = Get-ChildItem -Path $root -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $buildStartedAt }
    foreach ($artifact in $artifacts) {
      $destinationName = Get-StagedArtifactName -ArtifactName $artifact.Name
      $destination = Join-Path $activeOutputDir $destinationName
      Copy-Item -LiteralPath $artifact.FullName -Destination $destination -Force
      if (-not $copiedArtifacts.Contains($destination)) {
        $copiedArtifacts.Add($destination) | Out-Null
      }
    }
  }
}

if ($env:LOCAL_UPDATE_ENDPOINT) {
  $latestPath = Join-Path $activeOutputDir 'latest.json'
  $nsisArtifact = Join-Path $activeOutputDir "Miko_${appVersion}_windows_x64_nsis.exe"
  $nsisSignature = Join-Path $activeOutputDir "Miko_${appVersion}_windows_x64_nsis.exe.sig"
  if ((-not (Test-Path $latestPath)) -and (Test-Path $nsisArtifact) -and (Test-Path $nsisSignature)) {
    $artifactName = Split-Path -Leaf $nsisArtifact
    $latestManifest = @{
      version = $appVersion
      notes = "Local updater test build $appVersion"
      pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      platforms = @{
        'windows-x86_64' = @{
          signature = (Get-Content -LiteralPath $nsisSignature -Raw).Trim()
          url = Get-LocalUpdaterDownloadUrl -Endpoint $env:LOCAL_UPDATE_ENDPOINT -ArtifactName $artifactName
        }
      }
    } | ConvertTo-Json -Depth 10
    Set-Content -Path $latestPath -Value $latestManifest -Encoding UTF8
    $copiedArtifacts.Add($latestPath) | Out-Null
    Write-Step "Generated local updater latest.json: $latestPath"
  }
}

$msiInstaller = $null
$nsisInstaller = $null
if ($windowsBundle -eq 'nsis') {
  $nsisInstaller = Get-LatestArtifact -SearchRoots @(
    (Join-Path $tauriTargetDir "$targetTriple\release\bundle\nsis"),
    (Join-Path $tauriTargetDir 'release\bundle\nsis')
  ) -Patterns @('*.exe') -ModifiedSince $buildStartedAt
} else {
  $msiInstaller = Get-LatestArtifact -SearchRoots @(
    (Join-Path $tauriTargetDir "$targetTriple\release\bundle\msi"),
    (Join-Path $tauriTargetDir 'release\bundle\msi')
  ) -Patterns @('*.msi') -ModifiedSince $buildStartedAt
}

$msiInstallerPath = if ($msiInstaller) { $msiInstaller.FullName } else { 'not found' }
$nsisInstallerPath = if ($nsisInstaller) { $nsisInstaller.FullName } else { 'not found' }

$buildInfo = @(
  "App version: $appVersion"
  "Target triple: $targetTriple"
  "Windows bundle: $windowsBundle"
  "Canonical output: $canonicalOutputDir"
  "Actual output: $activeOutputDir"
  "Windows installer (NSIS): $nsisInstallerPath"
  "Windows installer (MSI): $msiInstallerPath"
  "Artifacts copied: $($copiedArtifacts.Count)"
  "Built at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
)

Set-Content -Path (Join-Path $activeOutputDir 'BUILD_INFO.txt') -Value $buildInfo -Encoding UTF8

Write-Host ''
Write-Step 'Build finished.'
Write-Step "Artifacts output: $activeOutputDir"
if ($msiInstaller) {
  Write-Step "MSI installer source: $($msiInstaller.FullName)"
}
if ($nsisInstaller) {
  Write-Step "NSIS installer source: $($nsisInstaller.FullName)"
}
if (-not $msiInstaller -and -not $nsisInstaller) {
  Write-Step 'No Windows installer found under bundle directories.'
}

Write-Step "Canonical output: $canonicalOutputDir"

if ($env:OPEN_OUTPUT -eq '1') {
  Invoke-Item $canonicalOutputDir
}
