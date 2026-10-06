param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CargoArgs)

$ErrorActionPreference = 'Stop'
$env:CARGO_HOME = 'D:\workspace\toolchains\rust\cargo'
$env:RUSTUP_HOME = 'D:\workspace\toolchains\rust\rustup'
$env:PATH = 'D:\workspace\toolchains\rust\cargo\bin;' + $env:PATH
& 'D:\workspace\toolchains\msvc-2022\Common7\Tools\Launch-VsDevShell.ps1' -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null

Set-Location (Join-Path $PSScriptRoot '..')
cargo @CargoArgs
