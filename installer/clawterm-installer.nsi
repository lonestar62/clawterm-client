; ClawTerm NSIS Installer Script
; App: ClawTerm v1.0.0
; Publisher: DeepTx AI

Unicode True

!include "MUI2.nsh"
!include "LogicLib.nsh"

;--------------------------------
; General
Name "ClawTerm"
OutFile "..\ClawTermSetup-1.0.0.exe"
InstallDir "$PROGRAMFILES64\ClawTerm"
InstallDirRegKey HKLM "Software\ClawTerm" "InstallDir"
RequestExecutionLevel admin
BrandingText "DeepTx AI"

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "ClawTerm"
VIAddVersionKey "CompanyName" "DeepTx AI"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2024 DeepTx AI"
VIAddVersionKey "FileDescription" "ClawTerm VT220 Terminal Client"
VIAddVersionKey "FileVersion" "1.0.0.0"
VIAddVersionKey "ProductVersion" "1.0.0.0"

;--------------------------------
; MUI Settings
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch ClawTerm"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchClawTerm

;--------------------------------
; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

;--------------------------------
; Languages
!insertmacro MUI_LANGUAGE "English"

;--------------------------------
; Installer Section
Section "ClawTerm" SecMain
  SectionIn RO

  SetOutPath "$INSTDIR"
  File "..\clawterm.exe"

  ; Write install dir to registry
  WriteRegStr HKLM "Software\ClawTerm" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\ClawTerm" "Version" "1.0.0"

  ; Add install dir to system PATH via PowerShell (idempotent)
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "[Environment]::SetEnvironmentVariable(\"Path\", ([Environment]::GetEnvironmentVariable(\"Path\",\"Machine\") + \";$INSTDIR\"), \"Machine\")"'

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Add to Add/Remove Programs
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm" \
    "DisplayName" "ClawTerm"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm" \
    "DisplayVersion" "1.0.0"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm" \
    "Publisher" "DeepTx AI"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm" \
    "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm" \
    "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm" \
    "DisplayIcon" "$INSTDIR\clawterm.exe"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm" \
    "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm" \
    "NoRepair" 1

  ; Start Menu shortcut — opens cmd /k clawterm.exe
  CreateDirectory "$SMPROGRAMS\ClawTerm"
  CreateShortcut "$SMPROGRAMS\ClawTerm\ClawTerm.lnk" \
    "$WINDIR\System32\cmd.exe" '/k "$INSTDIR\clawterm.exe"' \
    "$INSTDIR\clawterm.exe" 0 SW_SHOWNORMAL \
    "" "ClawTerm VT220 Terminal Client"
  CreateShortcut "$SMPROGRAMS\ClawTerm\Uninstall ClawTerm.lnk" \
    "$INSTDIR\uninstall.exe"

  ; Desktop shortcut
  CreateShortcut "$DESKTOP\ClawTerm.lnk" \
    "$WINDIR\System32\cmd.exe" '/k "$INSTDIR\clawterm.exe"' \
    "$INSTDIR\clawterm.exe" 0 SW_SHOWNORMAL \
    "" "ClawTerm VT220 Terminal Client"

SectionEnd

;--------------------------------
; Uninstaller Section
Section "Uninstall"

  ; Remove install dir from system PATH via PowerShell
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "[Environment]::SetEnvironmentVariable(\"Path\", ((([Environment]::GetEnvironmentVariable(\"Path\",\"Machine\") -split \";\") -ne \"$INSTDIR\") -join \";\"), \"Machine\")"'

  ; Remove files
  Delete "$INSTDIR\clawterm.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; Remove shortcuts
  Delete "$SMPROGRAMS\ClawTerm\ClawTerm.lnk"
  Delete "$SMPROGRAMS\ClawTerm\Uninstall ClawTerm.lnk"
  RMDir "$SMPROGRAMS\ClawTerm"
  Delete "$DESKTOP\ClawTerm.lnk"

  ; Remove registry entries
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawTerm"
  DeleteRegKey HKLM "Software\ClawTerm"

SectionEnd

;--------------------------------
; Finish page launch function
Function LaunchClawTerm
  Exec '"$WINDIR\System32\cmd.exe" /k "$INSTDIR\clawterm.exe"'
FunctionEnd
