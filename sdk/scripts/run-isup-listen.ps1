# 建置 IsupCmsBridge。正式監聽由 ba-backend isupListenService 啟動。
[CmdletBinding()]
param(
    [string]$Configuration = "Release",
    [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
    $RepoRoot = Split-Path $PSScriptRoot -Parent
}
$Proj = Join-Path $RepoRoot "sdk\dotnet\isup-bridge\IsupCmsBridge.csproj"
$OutDir = Join-Path $RepoRoot "sdk\dotnet\isup-bridge\bin\$Configuration\net8.0\win-x64"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "dotnet not found. Install .NET 8 SDK."
}

Write-Host "Building IsupCmsBridge..."
Get-Process -Name "IsupCmsBridge" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
dotnet build $Proj -c $Configuration
if ($LASTEXITCODE -ne 0) {
    throw "IsupCmsBridge build failed"
}

$nativeCandidates = @(
    (Join-Path $OutDir "runtimes\win-x64\native"),
    (Join-Path $OutDir "runtimes\win7-x64\native"),
    (Join-Path $env:USERPROFILE ".nuget\packages\quicknv.hikvisionisupsdk.native\1.0.3\runtimes\win-x64\native")
)
foreach ($nativeDir in $nativeCandidates) {
    if (Test-Path (Join-Path $nativeDir "HCISUPCMS.dll")) {
        Copy-Item (Join-Path $nativeDir "*") $OutDir -Recurse -Force
        Write-Host ("Copied ISUP native DLLs from {0}" -f $nativeDir)
        break
    }
}

Write-Host ("Built {0}" -f (Join-Path $OutDir "IsupCmsBridge.exe"))
