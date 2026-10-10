param(
    [string]$ExePath,
    [string]$OutPng
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$proc = Start-Process -FilePath $ExePath -WindowStyle Hidden -PassThru
$oldDpi = [Win32]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $proc.Refresh()
    } while ([string]::IsNullOrEmpty($proc.MainWindowTitle) -and (Get-Date) -lt $deadline)
    Start-Sleep -Seconds 3
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 1 }
    $rect = New-Object Win32+RECT
    [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    Write-Output "TITLE=$($proc.MainWindowTitle) SIZE=${w}x${h}"
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [Win32]::PrintWindow($hwnd, $hdc, 2) | Out-Null
    $g.ReleaseHdc($hdc)
    $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "SAVED $OutPng"
}
finally {
    if ($oldDpi -ne [IntPtr]::Zero) { [Win32]::SetThreadDpiAwarenessContext($oldDpi) | Out-Null }
    if (-not $proc.HasExited) {
        if ($proc.CloseMainWindow() -and $proc.WaitForExit(5000)) { Write-Output "NORMAL_EXIT" }
        else { $proc.Kill(); Write-Output "FORCED_EXIT" }
    }
}
