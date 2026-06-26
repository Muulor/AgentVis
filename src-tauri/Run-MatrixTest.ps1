# AgentVis WFP matrix test runner.
# Run from an elevated PowerShell window or via Test.bat.

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $PSCommandPath
Set-Location $ScriptRoot

$HelperExe = Join-Path $ScriptRoot 'target\debug\agentvis_wfp_helper.exe'
$ProbeExe = Join-Path $ScriptRoot 'target\debug\agentvis_wfp_network_probe.exe'
$CurlExe = Join-Path $env:SystemRoot 'System32\curl.exe'
$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "      AgentVis WFP matrix test runner        " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "ScriptRoot: $ScriptRoot"
Write-Host "Helper    : $HelperExe"
Write-Host "Probe     : $ProbeExe"
Write-Host "Admin     : $IsAdmin"

if (!$IsAdmin) {
  Write-Host "WARNING: this test usually needs an elevated process to add WFP filters." -ForegroundColor Yellow
}

if (!(Test-Path $HelperExe) -or !(Test-Path $ProbeExe)) {
  Write-Host "helper/probe not found, building..." -ForegroundColor Yellow
  cargo build --bin agentvis_wfp_helper --bin agentvis_wfp_network_probe
}

if (!(Test-Path $HelperExe)) {
  throw "helper not found: $HelperExe"
}
if (!(Test-Path $ProbeExe)) {
  throw "probe not found: $ProbeExe"
}

$ready = Join-Path $env:TEMP 'agentvis-wfp-ready.txt'
$helperOut = Join-Path $env:TEMP 'agentvis-wfp-helper.json'
$helperErr = Join-Path $env:TEMP 'agentvis-wfp-helper.err'
$curlOut = Join-Path $env:TEMP 'agentvis-wfp-curl.out'
$curlErr = Join-Path $env:TEMP 'agentvis-wfp-curl.err'

Write-Host "[1/6] Cleaning temp files..."
Remove-Item $ready, $helperOut, $helperErr, $curlOut, $curlErr -ErrorAction SilentlyContinue

Write-Host "[2/6] Starting helper and waiting for ready-file..."
$helper = $null

try {
  $helper = Start-Process `
    -FilePath $HelperExe `
    -ArgumentList @(
      'probe',
      '--exe', $ProbeExe,
      '--timeout-ms', '60000',
      '--ready-file', $ready,
      '--json'
    ) `
    -PassThru `
    -RedirectStandardOutput $helperOut `
    -RedirectStandardError $helperErr
} catch {
  Write-Host "helper start failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Helper path: $HelperExe" -ForegroundColor Red
  throw
}

$deadline = (Get-Date).AddSeconds(10)
while (!(Test-Path $ready) -and !$helper.HasExited -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 100
}

if ($helper.HasExited -or !(Test-Path $ready)) {
  Write-Host "ERROR: helper did not create ready-file." -ForegroundColor Red
  if (Test-Path $helperOut) {
    Write-Host "--- helper stdout ---" -ForegroundColor Yellow
    Get-Content $helperOut -ErrorAction SilentlyContinue
  }
  if (Test-Path $helperErr) {
    Write-Host "--- helper stderr ---" -ForegroundColor Yellow
    Get-Content $helperErr -ErrorAction SilentlyContinue
  }
  exit 1
}

$tcpExit = $null
$tcpAccepted = $null
$udpExit = $null
$udpReceived = $false
$curlExit = $null
$inspectResult = $null

try {
  Write-Host "[3/6] Testing target TCP block..."
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), 0)
  $listener.Start()
  $tcpPort = $listener.LocalEndpoint.Port

  & $ProbeExe tcp --host 127.0.0.1 --port $tcpPort --timeout-ms 1000 --json | Out-Null
  $tcpExit = $LASTEXITCODE
  $tcpAccepted = $listener.Pending()
  $listener.Stop()

  Write-Host "[4/6] Testing target UDP behavior..."
  $udp = [System.Net.Sockets.UdpClient]::new(0)
  $udp.Client.Blocking = $false
  $udpPort = $udp.Client.LocalEndPoint.Port

  & $ProbeExe udp --host 127.0.0.1 --port $udpPort --payload agentvis-wfp-manual --timeout-ms 1000 --json | Out-Null
  $udpExit = $LASTEXITCODE
  Start-Sleep -Milliseconds 200

  try {
    $remote = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Any, 0)
    $bytes = $udp.Receive([ref]$remote)
    $udpReceived = $true
  } catch [System.Net.Sockets.SocketException] {
    if ($_.Exception.ErrorCode -ne 10035) { throw }
  } finally {
    $udp.Close()
  }

  Write-Host "[5/6] Testing non-target network..."
  if (Test-Path $CurlExe) {
    $curlProcess = Start-Process `
      -FilePath $CurlExe `
      -ArgumentList @('-I', 'https://example.com', '--connect-timeout', '5') `
      -Wait `
      -PassThru `
      -RedirectStandardOutput $curlOut `
      -RedirectStandardError $curlErr
    $curlExit = $curlProcess.ExitCode
  } else {
    Write-Host "curl.exe not found, using .NET HEAD fallback." -ForegroundColor Yellow
    try {
      $request = [System.Net.HttpWebRequest]::Create('https://example.com')
      $request.Method = 'HEAD'
      $request.Timeout = 5000
      $response = $request.GetResponse()
      $response.Close()
      $curlExit = 0
    } catch {
      Write-Host "non-target network fallback failed: $($_.Exception.Message)" -ForegroundColor Yellow
      $curlExit = 1
    }
  }
} finally {
  Write-Host "[6/6] Stopping helper and cleaning residual WFP objects..."
  if ($helper -and !$helper.HasExited) {
    Stop-Process -Id $helper.Id -Force
    Wait-Process -Id $helper.Id -Timeout 5 -ErrorAction SilentlyContinue
  }

  & $HelperExe cleanup --confirm-agentvis-wfp-cleanup --json | Out-Null
  $inspectResult = & $HelperExe inspect --json
}

$isClean = ($inspectResult -match '"residualFiltersDetected":false') -and ($inspectResult -match '"providerDetected":false')

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "                 Test summary                " -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host "Target TCP : tcpExit=$tcpExit, tcpAccepted=$tcpAccepted"
Write-Host "Target UDP : udpExit=$udpExit, udpReceived=$udpReceived"
Write-Host "Non-target : curlExit=$curlExit"
if ($isClean) {
  Write-Host "Cleanup    : clean, no residual objects" -ForegroundColor Green
} else {
  Write-Host "Cleanup    : residual objects detected" -ForegroundColor Red
  Write-Host $inspectResult
}
Write-Host "============================================="
