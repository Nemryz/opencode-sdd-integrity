# Checks the file surface install.ps1 leaves behind, so the CI installation job fails loudly when a file stops shipping.
# Usage: verify-install.ps1 -Target <target-dir> [-Backup]

param(
    [Parameter(Mandatory = $true)][string]$Target,
    [switch]$Backup
)

$Failures = 0

function Expect-Path([string]$Relative) {
    $path = Join-Path $Target $Relative
    if (Test-Path $path) {
        Write-Host "PASS: $Relative"
    } else {
        Write-Host "FAIL: missing $Relative"
        $script:Failures++
    }
}

function Expect-Text([string]$Relative, [string]$Marker) {
    $path = Join-Path $Target $Relative
    if ((Test-Path $path) -and (Select-String -Path $path -SimpleMatch $Marker -Quiet)) {
        Write-Host "PASS: $Relative contains the marker"
    } else {
        Write-Host "FAIL: $Relative is missing the marker"
        $script:Failures++
    }
}

Expect-Path "AGENTS.md"
Expect-Path "opencode.jsonc"
Expect-Path "package.json"
Expect-Path "agents/spec.md"
Expect-Path "commands/status.md"
Expect-Path "templates/spec-template.md"
Expect-Path "templates/constitution-template.md"
Expect-Path "skills/speckit-constitution/SKILL.md"
Expect-Path "tools/speckit-status.ts"
Expect-Path "tools/speckit-evidence.ts"
Expect-Path "tools/speckit-archive.ts"
Expect-Path "tools/install/cli.mjs"
Expect-Path "plugins/speckit-tools.ts"
Expect-Path "plugins/speckit-doom-loop.ts"
Expect-Path "docs/testing.md"
Expect-Path "docs/showcase.md"
Expect-Path "npm-shrinkwrap.json"

if ($Backup) {
    $backupRoot = Join-Path $Target ".install-backups"
    $dirs = @()
    if (Test-Path $backupRoot) {
        $dirs = @(Get-ChildItem -Path $backupRoot -Directory)
    }

    if ($dirs.Count -eq 1) {
        Write-Host "PASS: the reinstall created exactly one backup folder"
    } else {
        Write-Host "FAIL: expected one backup folder, found $($dirs.Count)"
        $Failures++
    }

    if (($dirs.Count -ge 1) -and (Test-Path (Join-Path $dirs[0].FullName "AGENTS.md")) -and (Select-String -Path (Join-Path $dirs[0].FullName "AGENTS.md") -SimpleMatch "user edit" -Quiet)) {
        Write-Host "PASS: the backup holds the edited AGENTS.md"
    } else {
        Write-Host "FAIL: the backup does not hold the edited AGENTS.md"
        $Failures++
    }

    $current = Join-Path $Target "AGENTS.md"
    if ((Test-Path $current) -and (Select-String -Path $current -SimpleMatch "user edit" -Quiet)) {
        Write-Host "FAIL: the reinstall kept the edited AGENTS.md"
        $Failures++
    } else {
        Write-Host "PASS: the reinstall replaced AGENTS.md"
    }

    Expect-Text "opencode.jsonc" "user config"
}

if ($Failures -gt 0) {
    Write-Host "VERIFY FAILED ($Failures check(s))"
    exit 1
}
Write-Host "VERIFY PASSED"
