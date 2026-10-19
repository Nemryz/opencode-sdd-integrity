# speckit-sdd Installer — Windows PowerShell 5.1+
# Usage: irm https://raw.githubusercontent.com/Nemryz/opencode-sdd-kit/master/install.ps1 | iex
# Or:    .\install.ps1 [-Ref <branch|tag>] [-Dir <path>] [-SkipDeps]
# Options:
#   -Ref <branch|tag>   Git ref to install, defaults to master and accepts V2 for the OpenCode 2 toolkit
#   -Dir <path>         Configuration directory, defaults to $env:USERPROFILE\.config\opencode
#   -SkipDeps           Copy the files without running npm install

param(
    [string]$Ref = "master",
    [string]$Dir = "$env:USERPROFILE\.config\opencode",
    [switch]$SkipDeps
)

$Repo      = "Nemryz/opencode-sdd-kit"
$ConfigDir = $Dir
$TmpDir    = Join-Path ([System.IO.Path]::GetTempPath()) "opencode-sdd-kit-install"
$CloneDir  = Join-Path $TmpDir "opencode-sdd-kit"

if (Test-Path $TmpDir) { Remove-Item -Recurse -Force $TmpDir }
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

Write-Host "==> Cloning opencode-sdd-kit ($Ref)..."
git clone --depth 1 --branch $Ref "https://github.com/$Repo.git" $CloneDir

Write-Host "==> Installing files..."
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null

# Copies every file this run is about to replace into a timestamped backup folder.
$Items     = "AGENTS.md", "package.json", "package-lock.json", "agents", "commands", "templates", "skills", "tools", "plugins", "docs"
$BackupDir = $null
foreach ($item in $Items) {
    $existing = Join-Path $ConfigDir $item
    if (-not (Test-Path $existing)) { continue }
    if (-not $BackupDir) {
        $stamp     = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
        $BackupDir = Join-Path (Join-Path $ConfigDir ".install-backups") "$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    }
    Copy-Item -Recurse -Force $existing (Join-Path $BackupDir $item)
}
if ($BackupDir) {
    Write-Host "    Previous files saved to $BackupDir"
}

Copy-Item -Force (Join-Path $CloneDir "AGENTS.md") (Join-Path $ConfigDir "AGENTS.md")
if (-not (Test-Path (Join-Path $ConfigDir "opencode.jsonc"))) {
    Copy-Item (Join-Path $CloneDir "opencode.jsonc.example") (Join-Path $ConfigDir "opencode.jsonc")
}
Copy-Item -Force (Join-Path $CloneDir "package.json") (Join-Path $ConfigDir "package.json")
Copy-Item -Force (Join-Path $CloneDir "package-lock.json") (Join-Path $ConfigDir "package-lock.json") -ErrorAction SilentlyContinue

Copy-Item -Recurse -Force (Join-Path $CloneDir "agents") $ConfigDir
Copy-Item -Recurse -Force (Join-Path $CloneDir "commands") $ConfigDir
Copy-Item -Recurse -Force (Join-Path $CloneDir "templates") $ConfigDir
Copy-Item -Recurse -Force (Join-Path $CloneDir "skills") $ConfigDir
Copy-Item -Recurse -Force (Join-Path $CloneDir "tools") $ConfigDir
Copy-Item -Recurse -Force (Join-Path $CloneDir "plugins") $ConfigDir
Copy-Item -Recurse -Force (Join-Path $CloneDir "docs") $ConfigDir

if ($SkipDeps) {
    Write-Host "==> Skipping dependencies (-SkipDeps)"
} else {
    Write-Host "==> Installing dependencies..."
    Push-Location $ConfigDir
    npm install --ignore-scripts 2>$null
    Pop-Location
}

Remove-Item -Recurse -Force $TmpDir

Write-Host ""
Write-Host "==> Done! opencode-sdd-kit installed to $ConfigDir"
Write-Host "    Restart opencode and run /status to verify."
