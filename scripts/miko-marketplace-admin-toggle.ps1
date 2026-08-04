param([switch]$NoUi)

$ErrorActionPreference = 'Stop'

$stateDir = Join-Path $env:LOCALAPPDATA 'Miko\MarketplaceAdmin'
$pidFile = Join-Path $stateDir 'tunnel.pid'
$logFile = Join-Path $stateDir 'tunnel.log'
$sshKey = Join-Path $env:USERPROFILE '.ssh\miko_admin_ed25519'
$localPort = 8789
$forwardSpec = "${localPort}:127.0.0.1:8788"
$adminUrl = "http://localhost:${localPort}/login"

function Show-Notice([string]$message, [string]$title = 'Miko Admin') {
  if ($NoUi) {
    Write-Output "$title`: $message"
    return
  }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($message, $title) | Out-Null
}

function Get-ManagedTunnel {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $savedPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) {
    Remove-Item -LiteralPath $pidFile -Force
    return $null
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
  if (-not $process -or $process.Name -ne 'ssh.exe' -or $process.CommandLine -notlike "*$forwardSpec*") {
    Remove-Item -LiteralPath $pidFile -Force
    return $null
  }
  return $process
}

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

$managedTunnel = Get-ManagedTunnel
if ($managedTunnel) {
  Stop-Process -Id $managedTunnel.ProcessId -Force
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Show-Notice 'The admin tunnel is closed. Run the toggle again to reopen it.'
  exit 0
}

if (-not (Test-Path -LiteralPath $sshKey)) {
  Show-Notice "SSH key not found:`n$sshKey" 'Miko Admin Startup Failed'
  exit 1
}

$occupied = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue
if ($occupied) {
  Show-Notice "Local port $localPort is already in use." 'Miko Admin Startup Failed'
  exit 1
}

Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
$arguments = @(
  '-N',
  '-L', $forwardSpec,
  '-i', $sshKey,
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  'miko-admin@mikoai.top'
)

$process = Start-Process -FilePath 'ssh.exe' -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError $logFile -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding Ascii

$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  $listener = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    $status = & curl.exe --noproxy '*' -sS -o NUL -w '%{http_code}' "http://localhost:${localPort}/health"
    if ($status -eq '200') {
      $ready = $true
      break
    }
  }
}

if (-not $ready) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  $details = if (Test-Path -LiteralPath $logFile) { (Get-Content -LiteralPath $logFile -Tail 8) -join "`n" } else { 'No SSH log is available.' }
  Show-Notice "Unable to establish the admin tunnel.`n`n$details" 'Miko Admin Startup Failed'
  exit 1
}

if (-not $NoUi) { Start-Process $adminUrl }
Show-Notice "Miko Admin is open:`n$adminUrl`n`nRun the same toggle again to close the tunnel."
