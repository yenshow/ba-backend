param(
  [string]$Configuration = "Release",
  [switch]$Arming,
  [switch]$ArmingIntercom,
  [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"
$SdkRoot = Split-Path $PSScriptRoot -Parent
$BridgeDir = Join-Path $SdkRoot "dotnet\bridge"
$HcNetSdkRoot = Join-Path $SdkRoot "hcnet-sdk"

function Resolve-SdkLibDir {
  param([string]$Root)
  foreach ($rel in @("lib", "Lib", "lib\win64", "lib\Win64", "lib\x64")) {
    $dir = Join-Path $Root $rel
    if (Test-Path (Join-Path $dir "HCNetSDK.dll")) { return $dir }
  }
  return $null
}

function Stop-HcNetSdkBridge {
  $procs = Get-Process -Name "HcNetSdkBridge" -ErrorAction SilentlyContinue
  if (-not $procs) { return }
  Write-Host "Stopping $($procs.Count) HcNetSdkBridge process(es)..."
  $procs | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

function Copy-SdkRuntime {
  param([string]$LibDir, [string]$TargetDir)
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  Get-ChildItem -Path $LibDir -Filter "*.dll" -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $TargetDir $_.Name) -Force
  }
  $comDir = Join-Path $LibDir "HCNetSDKCom"
  if (Test-Path $comDir) {
    $targetCom = Join-Path $TargetDir "HCNetSDKCom"
    New-Item -ItemType Directory -Force -Path $targetCom | Out-Null
    Get-ChildItem -Path $comDir -Filter "*.dll" -File | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $targetCom $_.Name) -Force
    }
  }
}

if ($env:HCNETSDK_ROOT -and (Test-Path $env:HCNETSDK_ROOT)) {
  $HcNetSdkRoot = $env:HCNETSDK_ROOT
}

$libDir = Resolve-SdkLibDir $HcNetSdkRoot
if (-not $libDir) {
  Write-Host "[ERROR] HCNetSDK.dll not found under $HcNetSdkRoot"
  exit 1
}

$env:HCNETSDK_ROOT = $HcNetSdkRoot
$dotnetProj = Join-Path $BridgeDir "HcNetSdkBridge.csproj"
$dotnetOut = Join-Path $BridgeDir "bin\$Configuration\net8.0\win-x64"
$dotnetExe = Join-Path $dotnetOut "HcNetSdkBridge.exe"
$commonDir = Join-Path $SdkRoot "dotnet\common"

function Test-NeedsBuild {
  param([string]$ExePath)
  if (-not (Test-Path $ExePath)) { return $true }
  $exeTime = (Get-Item $ExePath).LastWriteTimeUtc
  $sources = @(
    Get-ChildItem $BridgeDir -Filter "*.cs" -File -ErrorAction SilentlyContinue
    Get-ChildItem $commonDir -Filter "*.cs" -File -ErrorAction SilentlyContinue
    Get-Item $dotnetProj
  )
  foreach ($source in $sources) {
    if ($source.LastWriteTimeUtc -gt $exeTime) { return $true }
  }
  return $false
}

Stop-HcNetSdkBridge

if (Test-NeedsBuild -ExePath $dotnetExe) {
  Write-Host "Building HcNetSdkBridge..."
  dotnet publish $dotnetProj -c $Configuration -r win-x64 --self-contained false
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Copy-SdkRuntime -LibDir $libDir -TargetDir $dotnetOut

if ($BuildOnly) {
  Write-Host "HcNetSdkBridge ready: $dotnetExe"
  exit 0
}

Push-Location $dotnetOut
try {
  if ($Arming) {
    & $dotnetExe --arming
  } elseif ($ArmingIntercom) {
    & $dotnetExe --arming-intercom
  } else {
    & $dotnetExe
  }
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
