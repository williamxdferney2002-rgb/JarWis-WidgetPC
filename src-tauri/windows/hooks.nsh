; Hooks del instalador NSIS de JarWis (JW-8-04).
; El desinstalador de Tauri borra el valor de Run del inicio automático, pero no
; la marca que Windows guarda en StartupApproved\Run. Se borra aquí, salvo en una
; actualización ($UpdateMode = 1). Va tras desinstalar: si se cancela por «app en
; ejecución», no se toca nada (JW-8-06).
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  ${EndIf}
!macroend
