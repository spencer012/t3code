[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if (-not ('T3CustomIconRefresh' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class T3CustomIconRefresh {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);
}
'@
}

$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs/T3 Code (Custom).lnk'),
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'T3 Code (Custom).lnk')
)
$iconItems = @(
    (Join-Path $env:LOCALAPPDATA 'Programs/t3code/T3 Code (Custom).exe')
)
$shortcutReader = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in $shortcutPaths) {
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { continue }
    $shortcut = $shortcutReader.CreateShortcut($shortcutPath)
    if ([IO.Path]::GetFileName($shortcut.TargetPath) -eq 'T3 Code (Custom).exe') {
        $iconItems += $shortcut.TargetPath
        $iconItems += $shortcutPath
    }
}
foreach ($iconItem in ($iconItems | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $iconItem -PathType Leaf) {
        # Notify only T3 items. Keep Explorer and unrelated icon caches untouched.
        [T3CustomIconRefresh]::SHChangeNotify(0x2000,0x5,$iconItem,[IntPtr]::Zero)
    }
}
Write-Host 'Refreshed T3 Code (Custom) icon references.' -ForegroundColor Green
