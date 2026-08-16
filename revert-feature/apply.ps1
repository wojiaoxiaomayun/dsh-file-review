# apply.ps1 — deploy the file-revert ("撤回") feature into the installed DSH Desktop
#
# Copies the two patched modules from this folder into the DSH Desktop install and
# backs up the originals first. Requires Administrator rights because the install
# lives under `C:\Program Files` (ACL: BUILTIN\Users is read-only there).
#
# Usage:
#     powershell -ExecutionPolicy Bypass -File .\apply.ps1
#
# What it does:
#   1. Checks it runs elevated; if not, relaunches itself with `-Verb RunAs`
#      (a UAC prompt appears — approve it).
#   2. Verifies the install paths exist and the backup folder is writable.
#   3. Backs up the two original modules to .\backup\<timestamp>\ (unmodified).
#   4. Copies the patched modules from .\final\ over the install.
#   5. Prints the restart instructions.
#
# IMPORTANT: close DSH Desktop BEFORE running this, and restart it afterwards.
# The server half (dsh-tool-fs) is loaded by the running process, and the web
# client bundle (dsh-client-ui-tool/lib/client.js) is served to the browser with
# a content-hash rev computed at startup — only a restart makes the browser fetch
# the new bundle (a hard refresh alone may still hit the cached rev URL).
#
# Note: any DSH Desktop update re-extracts the install and overwrites these
# patches. The proper home for this feature is the deepseek-harness source repo;
# these files are a drop-in for the compiled packages until then.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$FeatureRoot = $PSScriptRoot
$FinalDir = Join-Path $FeatureRoot "final"
$BackupDir = Join-Path $FeatureRoot "backup"
$InstallRoot = "C:\Program Files\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai"

$Targets = @(
    @{ Name = "dsh-tool-fs";        Rel = "dsh-tool-fs\lib\index.js" },
    @{ Name = "dsh-client-ui-tool"; Rel = "dsh-client-ui-tool\lib\client.js" }
)

function Test-Admin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "Not running as Administrator. Relaunching elevated (approve the UAC prompt)..."
    Start-Process -FilePath "powershell.exe" -Verb RunAs `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    exit 0
}

if (-not (Test-Path $FinalDir)) { throw "final/ not found next to this script: $FinalDir" }
if (-not (Test-Path $InstallRoot)) { throw "install root not found: $InstallRoot" }

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $BackupDir $Stamp
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

foreach ($t in $Targets) {
    $rel = "@deepseek-ai\" + $t.Rel
    $src = Join-Path $FinalDir $rel
    $dst = Join-Path $InstallRoot $t.Rel
    if (-not (Test-Path $src)) { throw "patched file missing: $src" }
    if (-not (Test-Path $dst)) { throw "install target missing: $dst" }
    $bak = Join-Path $BackupDir $t.Rel
    New-Item -ItemType Directory -Force -Path (Split-Path $bak) | Out-Null
    Copy-Item $dst $bak -Force
    Copy-Item $src $dst -Force
    Write-Host "OK  patched $($t.Rel)"
}

Write-Host ""
Write-Host "Backups: $BackupDir"
Write-Host 'Next steps:'
Write-Host '  1. Restart DSH Desktop.'
Write-Host '  2. In a conversation, ask the agent to edit a file, then click the'
Write-Host '     new "撤回" button on the edit/write row (click once to arm, again to confirm).'
Write-Host '  Revert is also available as the /fs_revert <callId> command.'
