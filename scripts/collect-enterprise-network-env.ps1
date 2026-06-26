# AgentVis enterprise network compatibility read-only collector.
# Collects current network/proxy/VPN/firewall/EDR signals and writes reports without changing system settings.

param(
  [string]$ScenarioName = "current",
  [string]$OutputDir = (Join-Path $env:TEMP "agentvis-enterprise-network-matrix"),
  [switch]$SkipDnsSamples
)

$ErrorActionPreference = "Continue"

function ConvertTo-AgentVisSafeFileName {
  param([string]$Value)
  $safe = $Value -replace "[^A-Za-z0-9_.-]", "_"
  if ([string]::IsNullOrWhiteSpace($safe)) {
    return "current"
  }
  return $safe
}

function Test-AgentVisAdmin {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Invoke-AgentVisCollect {
  param(
    [scriptblock]$ScriptBlock
  )
  try {
    return & $ScriptBlock
  } catch {
    return [ordered]@{
      status = "unavailable"
      error = $_.Exception.Message
    }
  }
}

function ConvertTo-AgentVisRedactedValue {
  param($Value)
  if ($null -eq $Value) {
    return $null
  }
  if ($Value -is [array]) {
    return @($Value | ForEach-Object { ConvertTo-AgentVisRedactedValue $_ })
  }

  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $text
  }

  $redacted = [regex]::Replace(
    $text,
    "(?i)(https?://)([^/\s:@]+):([^@\s/]+)@",
    '$1<redacted>:<redacted>@'
  )
  $redacted = [regex]::Replace(
    $redacted,
    "(?i)\b(token|password|passwd|pwd|secret|apikey|api_key|access_token|refresh_token)=([^&\s;]+)",
    '$1=<redacted>'
  )
  $redacted = [regex]::Replace(
    $redacted,
    "(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+",
    '$1 <redacted>'
  )
  return $redacted
}

function Get-AgentVisEnvProxySnapshot {
  $keys = @(
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "npm_config_proxy",
    "npm_config_https_proxy",
    "npm_config_noproxy"
  )
  $scopes = @("Process", "User", "Machine")
  $rows = @()
  foreach ($key in $keys) {
    foreach ($scope in $scopes) {
      $value = [Environment]::GetEnvironmentVariable($key, $scope)
      if ($null -ne $value -and $value -ne "") {
        $rows += [ordered]@{
          key = $key
          scope = $scope
          value = ConvertTo-AgentVisRedactedValue $value
        }
      }
    }
  }
  return $rows
}

function Get-AgentVisWinInetProxy {
  $settings = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction Stop
  return [ordered]@{
    proxyEnable = [bool]$settings.ProxyEnable
    proxyServer = ConvertTo-AgentVisRedactedValue $settings.ProxyServer
    autoConfigUrl = ConvertTo-AgentVisRedactedValue $settings.AutoConfigURL
    autoDetect = [bool]$settings.AutoDetect
  }
}

function Get-AgentVisDnsSamples {
  if ($SkipDnsSamples) {
    return [ordered]@{
      status = "skipped"
      reason = "SkipDnsSamples"
    }
  }

  $hosts = @(
    "example.com",
    "github.com",
    "registry.npmjs.org",
    "pypi.org",
    "127.0.0.1.sslip.io",
    "169-254-169-254.sslip.io"
  )
  $samples = @()
  foreach ($hostName in $hosts) {
    try {
      $records = Resolve-DnsName -Name $hostName -ErrorAction Stop |
        Select-Object Name, Type, IPAddress, NameHost
      $samples += [ordered]@{
        host = $hostName
        status = "ok"
        records = @($records)
      }
    } catch {
      $samples += [ordered]@{
        host = $hostName
        status = "unavailable"
        error = $_.Exception.Message
      }
    }
  }
  return $samples
}

function Get-AgentVisInterestingProcesses {
  $pattern = "(?i)(clash|v2ray|sing-box|shadowsocks|wireguard|openvpn|tailscale|zerotier|forti|globalprotect|anyconnect|zscaler|netskope|crowdstrike|falcon|carbonblack|sentinel|tanium|cylance|defender|msmpeng|proxy|vpn|edr)"
  return Get-Process -ErrorAction Stop |
    Where-Object { $_.ProcessName -match $pattern } |
    Sort-Object ProcessName |
    Select-Object ProcessName, Id
}

function Get-AgentVisInterestingServices {
  $pattern = "(?i)(clash|v2ray|sing-box|shadowsocks|wireguard|openvpn|tailscale|zerotier|forti|globalprotect|anyconnect|zscaler|netskope|crowdstrike|falcon|carbonblack|sentinel|tanium|cylance|defender|proxy|vpn|edr)"
  return Get-Service -ErrorAction Stop |
    Where-Object { $_.Name -match $pattern -or $_.DisplayName -match $pattern } |
    Sort-Object Name |
    Select-Object Name, DisplayName, Status, StartType
}

function ConvertTo-AgentVisOneLine {
  param($Value)
  if ($null -eq $Value) {
    return "none"
  }
  if ($Value -is [string]) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
      return "none"
    }
    return ($Value -replace "`r?`n", " ").Trim()
  }
  return (($Value | ConvertTo-Json -Depth 8 -Compress) -replace "`r?`n", " ").Trim()
}

$safeScenario = ConvertTo-AgentVisSafeFileName $ScenarioName
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$jsonPath = Join-Path $OutputDir "enterprise-network-$safeScenario-$timestamp.json"
$markdownPath = Join-Path $OutputDir "enterprise-network-$safeScenario-$timestamp.md"

$report = [ordered]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToString("o")
  scenarioName = $ScenarioName
  readOnly = $true
  skipDnsSamples = [bool]$SkipDnsSamples
  system = [ordered]@{
    os = Invoke-AgentVisCollect {
      Get-CimInstance Win32_OperatingSystem |
        Select-Object Caption, Version, BuildNumber, OSArchitecture
    }
    powershell = [ordered]@{
      edition = $PSVersionTable.PSEdition
      version = $PSVersionTable.PSVersion.ToString()
    }
    isAdministrator = Test-AgentVisAdmin
    computerName = $env:COMPUTERNAME
    userDomain = $env:USERDOMAIN
  }
  network = [ordered]@{
    activeAdapters = Invoke-AgentVisCollect {
      Get-NetAdapter -ErrorAction Stop |
        Where-Object { $_.Status -eq "Up" } |
        Select-Object Name, InterfaceDescription, Status, LinkSpeed, InterfaceIndex
    }
    defaultRoutes = Invoke-AgentVisCollect {
      Get-NetRoute -ErrorAction Stop |
        Where-Object { $_.DestinationPrefix -in @("0.0.0.0/0", "::/0") } |
        Sort-Object RouteMetric, InterfaceMetric |
        Select-Object DestinationPrefix, InterfaceAlias, NextHop, RouteMetric, InterfaceMetric, AddressFamily
    }
    dnsServers = Invoke-AgentVisCollect {
      Get-DnsClientServerAddress -ErrorAction Stop |
        Where-Object { $_.ServerAddresses -and $_.ServerAddresses.Count -gt 0 } |
        Select-Object InterfaceAlias, AddressFamily, ServerAddresses
    }
    dnsSamples = Invoke-AgentVisCollect { Get-AgentVisDnsSamples }
  }
  proxy = [ordered]@{
    winHttp = Invoke-AgentVisCollect {
      ConvertTo-AgentVisRedactedValue ((netsh winhttp show proxy) -join "`n")
    }
    winInet = Invoke-AgentVisCollect { Get-AgentVisWinInetProxy }
    environment = Invoke-AgentVisCollect { Get-AgentVisEnvProxySnapshot }
  }
  security = [ordered]@{
    firewallProfiles = Invoke-AgentVisCollect {
      Get-NetFirewallProfile -ErrorAction Stop |
        Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction, NotifyOnListen, AllowInboundRules, AllowLocalFirewallRules
    }
    defender = Invoke-AgentVisCollect {
      Get-MpComputerStatus -ErrorAction Stop |
        Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, NISEnabled, IsTamperProtected, AntivirusSignatureLastUpdated
    }
    interestingProcesses = Invoke-AgentVisCollect { Get-AgentVisInterestingProcesses }
    interestingServices = Invoke-AgentVisCollect { Get-AgentVisInterestingServices }
  }
}

$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$dnsSampleStatus = "enabled"
if ($SkipDnsSamples) {
  $dnsSampleStatus = "skipped"
}

$lines = @()
$lines += "# AgentVis Enterprise Network Snapshot"
$lines += ""
$lines += "- Scenario: $ScenarioName"
$lines += "- Generated at: $($report.generatedAt)"
$lines += "- Read-only: true"
$lines += "- DNS samples: $dnsSampleStatus"
$lines += "- JSON: $jsonPath"
$lines += ""
$lines += "## System"
$lines += ""
$lines += "| Field | Value |"
$lines += "| --- | --- |"
$lines += "| OS | $(ConvertTo-AgentVisOneLine $report.system.os) |"
$lines += "| PowerShell | $($report.system.powershell.edition) $($report.system.powershell.version) |"
$lines += "| Administrator | $($report.system.isAdministrator) |"
$lines += ""
$lines += "## Proxy And Network"
$lines += ""
$lines += "| Field | Value |"
$lines += "| --- | --- |"
$lines += "| WinHTTP | $(ConvertTo-AgentVisOneLine $report.proxy.winHttp) |"
$lines += "| WinINET | $(ConvertTo-AgentVisOneLine $report.proxy.winInet) |"
$lines += "| Environment proxy vars | $(ConvertTo-AgentVisOneLine $report.proxy.environment) |"
$lines += "| Active adapters | $(ConvertTo-AgentVisOneLine $report.network.activeAdapters) |"
$lines += "| Default routes | $(ConvertTo-AgentVisOneLine $report.network.defaultRoutes) |"
$lines += "| DNS Servers | $(ConvertTo-AgentVisOneLine $report.network.dnsServers) |"
$lines += "| DNS Samples | $(ConvertTo-AgentVisOneLine $report.network.dnsSamples) |"
$lines += ""
$lines += "## Security Proxy VPN Signals"
$lines += ""
$lines += "| Field | Value |"
$lines += "| --- | --- |"
$lines += "| Firewall Profiles | $(ConvertTo-AgentVisOneLine $report.security.firewallProfiles) |"
$lines += "| Defender | $(ConvertTo-AgentVisOneLine $report.security.defender) |"
$lines += "| Related processes | $(ConvertTo-AgentVisOneLine $report.security.interestingProcesses) |"
$lines += "| Related services | $(ConvertTo-AgentVisOneLine $report.security.interestingServices) |"
$lines += ""
$lines += "## Suggested Next Steps"
$lines += ""
$lines += "1. Run the ControlledNetwork A/B/G/H baseline in the same scenario."
$lines += "2. Run ``cargo test --manifest-path src-tauri/Cargo.toml broker_canary``."
$lines += "3. Record failures together with proxy/PAC/VPN/DNS/EDR signals from this snapshot."

$lines | Set-Content -LiteralPath $markdownPath -Encoding UTF8

Write-Host "AgentVis enterprise network snapshot written:"
Write-Host "JSON: $jsonPath"
Write-Host "Markdown: $markdownPath"
