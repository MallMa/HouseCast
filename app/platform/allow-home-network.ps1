param(
  [Parameter(Mandatory=$true)][string]$ExecutablePath,
  [Parameter(Mandatory=$true)][System.Net.IPAddress]$Address,
  [Parameter(Mandatory=$true)][System.Net.IPAddress]$Netmask
)
$ErrorActionPreference = 'Stop'
try {
  $appExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
  if ([IO.Path]::GetExtension($appExecutable) -ne '.exe') { throw 'Expected an application executable.' }
  $addressBytes = $Address.GetAddressBytes()
  $maskBytes = $Netmask.GetAddressBytes()
  if ($addressBytes.Length -ne 4 -or $maskBytes.Length -ne 4) { throw 'An IPv4 home network is required.' }
  $maskBits = ($maskBytes | ForEach-Object { [Convert]::ToString($_,2).PadLeft(8,'0') }) -join ''
  if ($maskBits -notmatch '^1+0+$') { throw 'Invalid subnet mask.' }
  $prefixLength = ($maskBits -replace '0','').Length
  if ($prefixLength -lt 8) { throw 'The network scope is too broad.' }
  $subnetBytes = for ($i=0; $i -lt 4; $i++) { $addressBytes[$i] -band $maskBytes[$i] }
  $homeSubnet = ($subnetBytes -join '.') + '/' + $prefixLength
  $hash = [Security.Cryptography.SHA256]::Create()
  $pathHash = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($appExecutable.ToLowerInvariant())))).Replace('-','').Substring(0,16)
  $ruleName = 'Housecast-HomeTCP-' + $pathHash
  # Replace only this executable's local Windows prompt-denial rules. Other programs
  # and organization-managed firewall policies are outside this helper's scope.
  Get-NetFirewallApplicationFilter -Program $appExecutable -ErrorAction SilentlyContinue |
    Get-NetFirewallRule |
    Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.PolicyStoreSourceType -eq 'Local' -and $_.Name -like '*Query User*' } |
    Remove-NetFirewallRule
  Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Name $ruleName -DisplayName 'Housecast - home audio and speaker events' -Description 'TCP from the selected home subnet to this Housecast executable only.' -Direction Inbound -Action Allow -Program $appExecutable -Protocol TCP -RemoteAddress $homeSubnet -LocalAddress $Address.IPAddressToString -Profile Any | Out-Null
  exit 0
} catch {
  Write-Error $_
  exit 1
}
