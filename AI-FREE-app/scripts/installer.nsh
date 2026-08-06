!macro customInstall
  ; AI 统一从此目录读取上传资产，内置 Chromium 的下载也写入这里。
  ; 仅开放这个工作区的修改权限，不扩大安装目录其他文件的权限。
  CreateDirectory "$INSTDIR\AI-Workspace"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR\AI-Workspace" /grant *S-1-5-32-545:(OI)(CI)(M) /T /C /Q'
  ; Chromium 的 Network Service/AppContainer 必须能读取整个内核目录。
  ; 仅授予读取与执行，不开放写权限。
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR\resources\chromium" /grant *S-1-15-2-1:(OI)(CI)(RX) *S-1-15-2-2:(OI)(CI)(RX) /T /C /Q'
!macroend
