# 由构建入口 dot-source，只设置当前进程环境。
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw '桌面构建脚本需要 Windows 和 PowerShell 7。' }

if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
    $cargoDirectory = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cargo' }
    $cargoBin = Join-Path $cargoDirectory 'bin'
    if (-not (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe') -PathType Leaf)) {
        throw '未找到 Cargo。请安装 Rust，或设置 CARGO_HOME 并将其 bin 目录加入 PATH。'
    }
    $env:PATH = $cargoBin + [IO.Path]::PathSeparator + $env:PATH
}

if ($env:RTL_VIEWER_VSDEVSHELL -or -not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $devShell = $env:RTL_VIEWER_VSDEVSHELL
    if (-not $devShell) {
        $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
            $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
            if ($LASTEXITCODE -ne 0) { throw 'vswhere 查询 MSVC 安装失败。' }
            if ($installation) { $devShell = Join-Path $installation 'Common7\Tools\Launch-VsDevShell.ps1' }
        }
    }
    if (-not $devShell -or -not (Test-Path -LiteralPath $devShell -PathType Leaf)) {
        throw '未找到 MSVC 开发环境。请安装 C++ 桌面开发工具，使用 Developer PowerShell，或设置 RTL_VIEWER_VSDEVSHELL 为 Launch-VsDevShell.ps1 路径。'
    }
    & $devShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) { throw 'MSVC 初始化后仍未找到 cl.exe。' }
}
