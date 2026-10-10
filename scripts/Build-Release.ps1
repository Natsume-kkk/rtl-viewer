$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Initialize-BuildEnvironment.ps1')

Set-Location (Join-Path $PSScriptRoot '..')
npm run tauri build -- --no-bundle
if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }

# 交付物归位：cargo 输出埋在 target 深处，统一复制到项目根 release/
$metadata = cargo metadata --no-deps --format-version 1 --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw '无法读取 Cargo 输出目录。' }
$targetDirectory = ($metadata | ConvertFrom-Json).target_directory
if ($env:CARGO_BUILD_TARGET) { $targetDirectory = Join-Path $targetDirectory $env:CARGO_BUILD_TARGET }
$built = Join-Path $targetDirectory 'release\rtl-viewer.exe'
if (-not (Test-Path $built)) { throw "build succeeded but $built not found" }
New-Item -ItemType Directory -Force 'release' | Out-Null
try {
    Copy-Item -LiteralPath $built -Destination 'release\rtl-viewer.exe' -Force
} catch {
    throw "交付失败，release\rtl-viewer.exe 未更新。请检查目标是否被运行中的窗口占用或存在权限问题，处理后重新运行本脚本；不要另存为其他名称交付。原始错误：$($_.Exception.Message)"
}
$item = Get-Item 'release\rtl-viewer.exe'
$hash = (Get-FileHash $item -Algorithm SHA256).Hash
Write-Output ("deliverable: release\rtl-viewer.exe  {0:N0} bytes  sha256={1}" -f $item.Length, $hash)
