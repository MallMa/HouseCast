<#
Read-only inspection and control-read timing for one explicitly addressed speaker.
Example: ./scripts/Inspect-Speaker.ps1 -Address 192.168.1.50 -Samples 30
Never changes playback, volume, grouping, pairing, or configuration.
Timings are HTTP/SOAP read round trips, NOT audible latency or switching time.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Address,
    [ValidateRange(1,100)][int]$Samples = 30
)
$ErrorActionPreference = 'Stop'
$taskIP = $null
if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$taskIP) -or $taskIP.AddressFamily -ne 'InterNetwork') {
    throw 'Supply an IPv4 address from your home network.'
}
$taskBytes = $taskIP.GetAddressBytes()
if (-not ($taskBytes[0] -eq 10 -or ($taskBytes[0] -eq 172 -and $taskBytes[1] -ge 16 -and $taskBytes[1] -le 31) -or ($taskBytes[0] -eq 192 -and $taskBytes[1] -eq 168))) {
    throw 'Only private LAN addresses are accepted.'
}
Add-Type -AssemblyName System.Net.Http
$taskHandler = [System.Net.Http.HttpClientHandler]::new()
$taskHandler.UseProxy = $false
$taskHandler.AllowAutoRedirect = $false
$script:taskClient = [System.Net.Http.HttpClient]::new($taskHandler)
$script:taskClient.Timeout = [TimeSpan]::FromSeconds(3)
$script:taskBase = [Uri]"http://${Address}:1400/"
$script:taskServices = @{}
$taskOutput = Join-Path (Get-Location) ('diagnostics/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Address)
[void](New-Item -ItemType Directory -Path $taskOutput -Force)

function Read-SafeXml([string]$Value) {
    $settings = [System.Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $textReader = [System.IO.StringReader]::new($Value)
    $reader = [System.Xml.XmlReader]::Create($textReader, $settings)
    try {
        $document = [System.Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        return ,$document
    } finally { $reader.Dispose(); $textReader.Dispose() }
}
function Read-Sonos([string]$Service, [string]$Action, [string]$Arguments = '') {
    if ($Action -notin @('GetZoneGroupState','GetZoneAttributes','GetZoneInfo','GetTransportInfo','GetMediaInfo','GetTransportSettings','GetRoomCalibrationStatus','GetVolume','GetMute','GetProtocolInfo')) {
        throw 'This tool only permits its fixed list of read actions.'
    }
    if (-not $script:taskServices.ContainsKey($Service)) { return [pscustomobject]@{Action=$Action;Success=$false;Error='Service not advertised'} }
    $entry = $script:taskServices[$Service]
    $uri = [Uri]::new($script:taskBase, $entry.Control)
    if ($uri.Host -ne $script:taskBase.Host -or $uri.Port -ne 1400 -or $uri.Scheme -ne 'http') { throw 'Unexpected control address.' }
    $body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:' + $Action + ' xmlns:u="' + $entry.Type + '">' + $Arguments + '</u:' + $Action + '></s:Body></s:Envelope>'
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $uri)
    [void]$request.Headers.TryAddWithoutValidation('SOAPACTION', ('"' + $entry.Type + '#' + $Action + '"'))
    $request.Content = [System.Net.Http.StringContent]::new($body, [System.Text.Encoding]::UTF8, 'text/xml')
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $response = $null
    try {
        $response = $script:taskClient.SendAsync($request).GetAwaiter().GetResult()
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $watch.Stop()
        $data = Read-SafeXml $text
        $fault = $data.SelectSingleNode("//*[local-name()='Fault']")
        return [pscustomobject]@{Action=$Action;Success=($response.IsSuccessStatusCode -and $null -eq $fault);Status=[int]$response.StatusCode;Ms=$watch.Elapsed.TotalMilliseconds;Xml=$text}
    } catch {
        $watch.Stop()
        return [pscustomobject]@{Action=$Action;Success=$false;Ms=$watch.Elapsed.TotalMilliseconds;Error=$_.Exception.Message}
    } finally { $request.Dispose(); if ($null -ne $response) { $response.Dispose() } }
}

try {
    $taskDescription = $script:taskClient.GetStringAsync([Uri]::new($script:taskBase, 'xml/device_description.xml')).GetAwaiter().GetResult()
    $taskXml = Read-SafeXml $taskDescription
    if (-not $taskDescription.Contains('Sonos')) { throw 'Endpoint did not identify as Sonos.' }
    Set-Content -LiteralPath (Join-Path $taskOutput 'device.xml') -Value $taskDescription -Encoding utf8
    foreach ($service in $taskXml.SelectNodes("//*[local-name()='service']")) {
        $type = $service.SelectSingleNode("*[local-name()='serviceType']").InnerText
        $control = $service.SelectSingleNode("*[local-name()='controlURL']").InnerText
        $script:taskServices[$type.Split(':')[-2]] = @{Type=$type;Control=$control}
    }
    $taskReads = @(
        (Read-Sonos 'DeviceProperties' 'GetZoneAttributes')
        (Read-Sonos 'DeviceProperties' 'GetZoneInfo')
        (Read-Sonos 'ZoneGroupTopology' 'GetZoneGroupState')
        (Read-Sonos 'AVTransport' 'GetTransportInfo' '<InstanceID>0</InstanceID>')
        (Read-Sonos 'AVTransport' 'GetMediaInfo' '<InstanceID>0</InstanceID>')
        (Read-Sonos 'AVTransport' 'GetTransportSettings' '<InstanceID>0</InstanceID>')
        (Read-Sonos 'RenderingControl' 'GetMute' '<InstanceID>0</InstanceID><Channel>Master</Channel>')
        (Read-Sonos 'RenderingControl' 'GetRoomCalibrationStatus' '<InstanceID>0</InstanceID>')
        (Read-Sonos 'ConnectionManager' 'GetProtocolInfo')
    )
    $taskTiming = @()
    for ($index = 0; $index -lt $Samples; $index++) {
        $taskTiming += Read-Sonos 'RenderingControl' 'GetVolume' '<InstanceID>0</InstanceID><Channel>Master</Channel>'
        if ($index -lt ($Samples - 1)) { Start-Sleep -Milliseconds 100 }
    }
    $taskSuccessful = @($taskTiming | Where-Object Success | ForEach-Object Ms | Sort-Object)
    $taskStats = [ordered]@{Samples=$Samples;Successful=$taskSuccessful.Count;Failed=($Samples - $taskSuccessful.Count);Kind='Read-only GetVolume HTTP round-trip, includes first request; not audio latency';P50Ms=$null;P95Ms=$null;MaxMs=$null}
    if ($taskSuccessful.Count) {
        $taskStats.P50Ms = [Math]::Round($taskSuccessful[[Math]::Ceiling($taskSuccessful.Count*0.5)-1],2)
        $taskStats.P95Ms = [Math]::Round($taskSuccessful[[Math]::Ceiling($taskSuccessful.Count*0.95)-1],2)
        $taskStats.MaxMs = [Math]::Round($taskSuccessful[-1],2)
    }
    $taskReport = [ordered]@{Timestamp=(Get-Date -Format o);Address=$Address;Services=$script:taskServices;Reads=$taskReads;Timing=$taskTiming;Stats=$taskStats}
    $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'inspection.json') -Encoding utf8
    [pscustomobject]@{Output=$taskOutput;Stats=$taskStats} | ConvertTo-Json -Depth 4
} finally { $script:taskClient.Dispose(); $taskHandler.Dispose() }
