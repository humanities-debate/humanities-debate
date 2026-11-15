$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($profileName in @('A', 'B')) {
  $shortcut = $shortcutShell.CreateShortcut((Join-Path $projectRoot "Chrome-Prototype-$profileName.lnk"))
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $shortcut.Arguments = '"' + (Join-Path $projectRoot 'desktop\chrome-launch.vbs') + '" ' + $profileName
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.IconLocation = (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe') + ',0'
  $shortcut.Save()
}
Write-Output 'Chrome prototype shortcuts A/B created in project folder.'
