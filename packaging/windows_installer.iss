; Inno Setup script -> release\KFUPM-Planner-Setup.exe
; Per-user install (no admin rights needed), Start menu + optional desktop shortcut, uninstaller.
#define AppName "KFUPM Planner"
#define AppVersion "1.0.0"
#define AppExe "KFUPM Planner.exe"

[Setup]
AppId={{8C2F2B6E-4C9B-4F2A-9E57-6A3F0C1D2B11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=KFUPM Planner (unofficial student tool)
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\release
OutputBaseFilename=KFUPM-Planner-Setup
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\release\KFUPM Planner\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent
