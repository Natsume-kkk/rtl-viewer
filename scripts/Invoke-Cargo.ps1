param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CargoArgs)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Initialize-BuildEnvironment.ps1')

Set-Location (Join-Path $PSScriptRoot '..')
cargo @CargoArgs
exit $LASTEXITCODE
