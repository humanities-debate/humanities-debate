!include "LogicLib.nsh"
!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
  ${If} $0 != 1
  ${OrIf} $1 < 44
    DetailPrint "Installing Microsoft Visual C++ runtime for offline speech recognition..."
    ExecWait '"$INSTDIR\resources\whisper\vc_redist.x64.exe" /install /passive /norestart' $0
    ${If} $0 != 0
    ${AndIf} $0 != 3010
    ${AndIf} $0 != 1638
      MessageBox MB_OK|MB_ICONEXCLAMATION "Microsoft Visual C++ runtime setup did not finish. Run resources\whisper\vc_redist.x64.exe in the app installation folder to enable local speech recognition. Text input remains available."
    ${EndIf}
  ${EndIf}
  SetRegView 32
!macroend
