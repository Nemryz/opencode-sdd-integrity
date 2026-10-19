# speckit-sdd Installer — Windows PowerShell 5.1+
# Usage: irm https://raw.githubusercontent.com/Nemryz/opencode-sdd-kit/master/install.ps1 | iex
# Or:    .\install.ps1

$Repo     = "Nemryz/opencode-sdd-kit"
$Branch   = "master"
$ConfigDir = "$env:USERPROFILE\.config\opencode"
$TmpDir   = "$env:TEMP\opencode-sdd-kit-install"

if (Test-Path $TmpDir) { Remove-Item -Recurse -Force $TmpDir }
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

Write-Host "==> Cloning opencode-sdd-kit ($Branch)..."
git clone --depth 1 --branch $Branch "https://github.com/$Repo.git" "$TmpDir\opencode-sdd-kit"

Write-Host "==> Installing files..."
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
Copy-Item -Force "$TmpDir\opencode-sdd-kit\AGENTS.md" "$ConfigDir\AGENTS.md"
if (-not (Test-Path "$ConfigDir\opencode.jsonc")) {
    Copy-Item "$TmpDir\opencode-sdd-kit\opencode.jsonc.example" "$ConfigDir\opencode.jsonc"
}
Copy-Item -Force "$TmpDir\opencode-sdd-kit\package.json" "$ConfigDir\package.json"
Copy-Item -Force "$TmpDir\opencode-sdd-kit\package-lock.json" "$ConfigDir\package-lock.json" -ErrorAction SilentlyContinue

Copy-Item -Recurse -Force "$TmpDir\opencode-sdd-kit\agents" "$ConfigDir"
Copy-Item -Recurse -Force "$TmpDir\opencode-sdd-kit\commands" "$ConfigDir"
Copy-Item -Recurse -Force "$TmpDir\opencode-sdd-kit\templates" "$ConfigDir"
Copy-Item -Recurse -Force "$TmpDir\opencode-sdd-kit\skills" "$ConfigDir"
Copy-Item -Recurse -Force "$TmpDir\opencode-sdd-kit\tools" "$ConfigDir"
Copy-Item -Recurse -Force "$TmpDir\opencode-sdd-kit\plugins" "$ConfigDir"
Copy-Item -Recurse -Force "$TmpDir\opencode-sdd-kit\docs" "$ConfigDir"

Write-Host "==> Installing dependencies..."
Push-Location $ConfigDir
npm install --ignore-scripts 2>$null
Pop-Location

Remove-Item -Recurse -Force $TmpDir

Write-Host ""
Write-Host "==> Done! opencode-sdd-kit installed to $ConfigDir"
Write-Host "    Restart opencode and run /status to verify."
