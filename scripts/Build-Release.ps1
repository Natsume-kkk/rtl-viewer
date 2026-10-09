$ErrorActionPreference = 'Stop'
$env:CARGO_HOME = 'D:\workspace\toolchains\rust\cargo'
$env:RUSTUP_HOME = 'D:\workspace\toolchains\rust\rustup'
$env:PATH = 'D:\workspace\toolchains\rust\cargo\bin;' + $env:PATH
& 'D:\workspace\toolchains\msvc-2022\Common7\Tools\Launch-VsDevShell.ps1' -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null

Set-Location (Join-Path $PSScriptRoot '..')
npm run tauri build -- --no-bundle

# 交付物归位：cargo 输出埋在 target 深处，统一复制到项目根 release/
$built = 'src-tauri\target\release\rtl-viewer.exe'
if (-not (Test-Path $built)) { throw "build succeeded but $built not found" }
New-Item -ItemType Directory -Force 'release' | Out-Null
Copy-Item $built 'release\rtl-viewer.exe' -Force
$item = Get-Item 'release\rtl-viewer.exe'
$hash = (Get-FileHash $item -Algorithm SHA256).Hash
Write-Output ("deliverable: release\rtl-viewer.exe  {0:N0} bytes  sha256={1}" -f $item.Length, $hash)
