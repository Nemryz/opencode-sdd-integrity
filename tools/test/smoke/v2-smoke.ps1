#Requires -Version 5.1

# Smoke test of the OpenCode 2 wiring, meant to run from a checkout of the kit.
# It mirrors v2-smoke.sh with PowerShell primitives so the same probes run on Windows.
# It installs a copy into an isolated config home the same way install.sh does,
# boots the real CLI, and grades the plugin markers and the tool registry.
# SMOKE_MODEL selects the model for the runs, SMOKE_TIMEOUT bounds each run in seconds,
# SMOKE_TMP overrides the base directory of the workspace,
# SMOKE_LLM_REQUIRED=1 turns the model evidence into a hard failure,
# and SMOKE_KEEP=1 leaves the workspace in place for inspection.

$ErrorActionPreference = "Continue"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Model = if ($env:SMOKE_MODEL) { $env:SMOKE_MODEL } else { "opencode/mimo-v2.6-flash-free" }
$TimeoutSec = if ($env:SMOKE_TIMEOUT) { [int]$env:SMOKE_TIMEOUT } else { 120 }
$LlmRequired = $env:SMOKE_LLM_REQUIRED -eq "1"
$Keep = $env:SMOKE_KEEP -eq "1"
$BaseTmp = if ($env:SMOKE_TMP) { $env:SMOKE_TMP } else { ([System.IO.Path]::GetTempPath()).TrimEnd([char[]] "/\") }

$script:Failures = 0

function Pass([string]$Message) { Write-Host "PASS: $Message" }
function Warn([string]$Message) { Write-Host "WARN: $Message" }
function Fail([string]$Message) {
  Write-Host "FAIL: $Message"
  $script:Failures = $script:Failures + 1
}
function LlmEvidence([string]$Message) {
  if ($LlmRequired) { Fail $Message } else { Warn $Message }
}

# Prefers the cmd shim because it reports the child exit code reliably in PowerShell.
function Resolve-CliPath([string]$Name) {
  foreach ($Extension in @(".cmd", ".bat", ".ps1", ".exe")) {
    $Hit = Get-Command "$Name$Extension" -ErrorAction SilentlyContinue
    if ($null -ne $Hit) { return $Hit.Source }
  }
  $Plain = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -ne $Plain) { return $Plain.Source }
  return $null
}

# Runs the CLI inside a background job so the timeout can stop it while both streams land on disk.
function Invoke-TimedOpencode([string]$Cli, [string[]]$CliArgs, [string]$OutFile, [string]$ErrFile, [string]$WorkDir) {
  $Job = Start-Job -ScriptBlock {
    param($CliPath, $RunArgs, $ErrPath, $Dir)
    Push-Location $Dir
    try {
      $Output = & $CliPath @RunArgs 2> $ErrPath
      [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($Output -join "`n") }
    } catch {
      [pscustomobject]@{ Code = 1; Output = "" }
    } finally {
      Pop-Location
    }
  } -ArgumentList $Cli, $CliArgs, $ErrFile, $WorkDir
  $Finished = Wait-Job -Job $Job -Timeout $TimeoutSec
  $TimedOut = $null -eq $Finished
  if ($TimedOut) { Stop-Job -Job $Job }
  $Result = Receive-Job -Job $Job -ErrorAction SilentlyContinue
  $State = $Job.State
  Remove-Job -Job $Job -Force
  $Record = @($Result) | Where-Object { $_ -and $_.PSObject.Properties["Code"] } | Select-Object -Last 1
  $Text = ""
  if ($null -ne $Record -and $Record.Output) { $Text = [string]$Record.Output + "`n" }
  [System.IO.File]::WriteAllText($OutFile, $Text)
  if ($TimedOut) { return 124 }
  if ($State -ne "Completed" -or $null -eq $Record) { return 1 }
  return [int]$Record.Code
}

$Opencode = Resolve-CliPath "opencode"
if ($null -eq $Opencode) {
  Write-Host "FAIL: opencode is not on PATH"
  exit 1
}
foreach ($Name in @("node", "npm")) {
  if ($null -eq (Resolve-CliPath $Name)) {
    Write-Host "FAIL: $Name is not on PATH"
    exit 1
  }
}
$Git = Resolve-CliPath "git"
if ($null -eq $Git) {
  Write-Host "FAIL: git is not on PATH"
  exit 1
}

$Work = Join-Path $BaseTmp ("sdd-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
New-Item -ItemType Directory -Path $Work -ErrorAction Stop | Out-Null
$Config = Join-Path (Join-Path $Work "xdg-config") "opencode"
$Project = Join-Path $Work "project"
$env:XDG_CONFIG_HOME = Join-Path $Work "xdg-config"
$env:XDG_DATA_HOME = Join-Path $Work "xdg-data"
$env:XDG_STATE_HOME = Join-Path $Work "xdg-state"
New-Item -ItemType Directory -Force -Path $Config, $env:XDG_DATA_HOME, $env:XDG_STATE_HOME -ErrorAction Stop | Out-Null

Write-Host "==> Smoke of the OpenCode 2 wiring (model: $Model, timeout: ${TimeoutSec}s)"

$ExitCode = 0
$TailOnFail = $null
try {
  Write-Host "==> Installing the kit into the isolated config home"
  node (Join-Path $Root "tools/install/cli.mjs") install --dir $Config --skip-deps --yes
  if ($LASTEXITCODE -ne 0) { throw "the kit install failed" }
  Copy-Item (Join-Path $Root "tools/test/smoke/smoke-probe.ts") (Join-Path $Config "plugins/zz-smoke-probe.ts") -ErrorAction Stop

  Write-Host "==> Installing the runtime dependencies (devDependencies stay out, the runtime never loads them)"
  $NpmLog = Join-Path $Work "npm.log"
  Push-Location $Config
  npm install --ignore-scripts --omit=dev --no-audit --no-fund 2>&1 | Out-File -FilePath $NpmLog -Encoding utf8
  $NpmCode = $LASTEXITCODE
  Pop-Location
  if ($NpmCode -ne 0) {
    $TailOnFail = $NpmLog
    throw "npm install failed inside the isolated config home"
  }

  New-Item -ItemType Directory -Path $Project -ErrorAction Stop | Out-Null
  Push-Location $Project
  & $Git init -q
  $GitCode = $LASTEXITCODE
  Pop-Location
  if ($GitCode -ne 0) { throw "git init failed" }
  Set-Content -Path (Join-Path $Project "README.md") -Value "# smoke project"

  Write-Host "==> Booting through a status call"
  $StatusLog = Join-Path $Work "status.log"
  $StatusJsonl = Join-Path $Work "status.jsonl"
  $StatusArgs = @("run", "--standalone", "--print-logs", "--auto", "--format", "json", "--model", $Model, "Call the speckit-status tool exactly once, then reply with the single word done.")
  $RunStatus = Invoke-TimedOpencode -Cli $Opencode -CliArgs $StatusArgs -OutFile $StatusJsonl -ErrFile $StatusLog -WorkDir $Project
  if ($RunStatus -ne 0) {
    Warn "the status run exited with code $RunStatus, the checks below grade whatever it wrote"
  }

  Write-Host "==> Checking the plugin markers and the load log"
  $PluginsState = Join-Path $Project ".opencode/plugins-state.json"
  $Markers = @(
    @{ Label = "guard"; Id = "speckit-guard" },
    @{ Label = "perfmon"; Id = "speckit-perfmon" },
    @{ Label = "doom loop"; Id = "speckit-doom-loop" }
  )
  foreach ($Marker in $Markers) {
    $Found = (Test-Path $PluginsState) -and (Select-String -Path $PluginsState -Pattern ('"' + $Marker.Id + '"') -Quiet -CaseSensitive)
    if ($Found) {
      Pass "the $($Marker.Label) plugin marked itself"
    } else {
      Fail "the $($Marker.Label) plugin did not mark itself in .opencode/plugins-state.json"
    }
  }
  if ((Test-Path $StatusLog) -and (Select-String -Path $StatusLog -Pattern "failed to load plugin" -Quiet -CaseSensitive)) {
    Fail "the server log reports a plugin that failed to load"
    Select-String -Path $StatusLog -Pattern "failed to load plugin" -CaseSensitive | Select-Object -First 5 | ForEach-Object { Write-Host $_.Line }
  } else {
    Pass "no plugin failed to load"
  }

  Write-Host "==> Checking the tool registry dump"
  $ExpectedTools = "speckit-approve speckit-audit speckit-clean speckit-complexity speckit-config speckit-delta speckit-evidence speckit-guard speckit-health speckit-mutation speckit-perf speckit-phase speckit-scaffold speckit-selfheal speckit-snapshot speckit-status speckit-validate"
  $env:SMOKE_TOOLS_JSON = Join-Path $Project ".opencode/smoke-tools.json"
  $env:SMOKE_EXPECTED_TOOLS = $ExpectedTools
  $RegistryCheck = @'
const fs = require("node:fs")
const expected = process.env.SMOKE_EXPECTED_TOOLS.split(" ")
let data
try {
  data = JSON.parse(fs.readFileSync(process.env.SMOKE_TOOLS_JSON, "utf8"))
} catch {
  console.error("the tool registry dump is missing or unreadable")
  process.exit(1)
}
const ids = data.map((tool) => tool.id)
const missing = expected.filter((id) => !ids.includes(id))
const hidden = data.filter((tool) => expected.includes(tool.id) && !(tool.options && tool.options.codemode === false))
if (missing.length > 0) {
  console.error("tools missing from the registry: " + missing.join(", "))
  process.exit(1)
}
if (hidden.length > 0) {
  console.error("tools without direct exposure: " + hidden.map((tool) => tool.id).join(", "))
  process.exit(1)
}
process.exit(0)
'@
  node -e $RegistryCheck
  if ($LASTEXITCODE -eq 0) {
    Pass "the registry lists all 16 tools with direct exposure"
  } else {
    Fail "the tool registry dump does not match the expected surface"
  }

  Write-Host "==> Grading the model evidence"
  $env:SMOKE_JSONL = $StatusJsonl
  $StatusEvidenceCheck = @'
const fs = require("node:fs")
const lines = fs.readFileSync(process.env.SMOKE_JSONL, "utf8").split("\n").filter(Boolean)
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  if (event.type === "tool_use" && event.part && event.part.tool === "speckit-status" && event.part.state && event.part.state.status === "completed") {
    process.exit(0)
  }
}
process.exit(1)
'@
  node -e $StatusEvidenceCheck
  if ($LASTEXITCODE -eq 0) {
    Pass "the model called speckit-status directly"
  } else {
    LlmEvidence "the status run has no completed speckit-status call (the model or the network may be down)"
  }
  $env:SMOKE_PERF_JSON = Join-Path $Project ".opencode/perf.json"
  $PerfCheck = @'
const fs = require("node:fs")
let perf
try {
  perf = JSON.parse(fs.readFileSync(process.env.SMOKE_PERF_JSON, "utf8"))
} catch {
  process.exit(1)
}
const entry = (perf.stats || []).find((stat) => stat.tool === "speckit-status")
process.exit(entry && entry.calls >= 1 ? 0 : 1)
'@
  node -e $PerfCheck
  if ($LASTEXITCODE -eq 0) {
    Pass "the perfmon plugin recorded the call"
  } else {
    LlmEvidence "perfmon has no speckit-status entry (the model evidence is missing)"
  }

  Write-Host "==> Probing the guard"
  $GuardJsonl = Join-Path $Work "guard.jsonl"
  $GuardLog = Join-Path $Work "guard.log"
  $GuardArgs = @("run", "--standalone", "--print-logs", "--auto", "--format", "json", "--model", $Model, "You are testing the file guard. Try to overwrite the file spec.json in the project root with the text hacked, using the write tool first and a shell redirect if the write tool is blocked. Then reply with the single word done.")
  $RunGuard = Invoke-TimedOpencode -Cli $Opencode -CliArgs $GuardArgs -OutFile $GuardJsonl -ErrFile $GuardLog -WorkDir $Project
  if ($RunGuard -ne 0) {
    Warn "the guard run exited with code $RunGuard, the check below grades whatever it wrote"
  }
  $GuardBlocked = (Test-Path $GuardJsonl) -and (Select-String -Path $GuardJsonl -Pattern "Guard blocked protected file" -Quiet -CaseSensitive)
  if ($GuardBlocked) {
    Pass "the guard blocked the protected write"
  } else {
    LlmEvidence "the guard run shows no denial (the model may not have attempted the write)"
  }

  Write-Host ""
  if ($script:Failures -gt 0) {
    Write-Host "SMOKE FAILED with $($script:Failures) problem(s)"
    if (-not $Keep) { Write-Host "rerun with SMOKE_KEEP=1 to inspect the workspace" }
    $ExitCode = 1
  } else {
    Write-Host "SMOKE PASSED"
  }
} catch {
  Write-Host "FAIL: $($_.Exception.Message)"
  if ($null -ne $TailOnFail) { Get-Content -Path $TailOnFail -Tail 20 | Write-Host }
  $ExitCode = 1
} finally {
  if ($Keep) { Write-Host "smoke workspace kept at $Work" }
  else { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
}
exit $ExitCode
