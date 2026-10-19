# Manual SDD workflow test — Windows PowerShell 5.1+
# Run from the OpenCode SDD Integrity root directory:
#   .\tools\test\manual\workflow.ps1

$KitDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Push-Location $KitDir

Write-Host ""
Write-Host "========================================"
Write-Host "  OpenCode SDD Integrity - Manual Workflow Test"
Write-Host "========================================"
Write-Host ""

# 1. Verify dependencies
Write-Host "==> Checking dependencies..."
$nodeVer = node --version 2>$null
if (-not $nodeVer) { Write-Host "FAIL: Node.js required"; Pop-Location; exit 1 }
$npmVer = npm --version 2>$null
if (-not $npmVer) { Write-Host "FAIL: npm required"; Pop-Location; exit 1 }

# 2. Install deps if needed
if (-not (Test-Path "node_modules")) {
  Write-Host "==> Installing dependencies..."
  npm install --ignore-scripts 2>$null
}

# 3. Run full vitest suite
Write-Host "==> Running full vitest suite..."
$testOutput = & npx vitest run 2>&1
$testExit = $LASTEXITCODE
Write-Host $testOutput

# 4. Run manual workflow test
Write-Host "==> Running manual workflow test..."
$workflowOutput = & npx vitest run tools/test/manual/workflow.test.ts 2>&1
$workflowExit = $LASTEXITCODE
Write-Host $workflowOutput

Write-Host ""
if ($testExit -eq 0 -and $workflowExit -eq 0) {
  Write-Host "All tests PASSED"
  Pop-Location
  exit 0
} else {
  Write-Host "Some tests FAILED (vitest: $testExit, workflow: $workflowExit)"
  Pop-Location
  exit 1
}
