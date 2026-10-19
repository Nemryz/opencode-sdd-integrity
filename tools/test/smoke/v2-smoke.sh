#!/usr/bin/env bash
set -euo pipefail

# Smoke test of the OpenCode 2 wiring, meant to run from a checkout of the kit.
# It installs a copy into an isolated config home the same way install.sh does,
# boots the real CLI, and grades the plugin markers and the tool registry.
# SMOKE_MODEL selects the model for the runs, SMOKE_TIMEOUT bounds each run in seconds,
# SMOKE_TMP overrides the base directory of the workspace,
# SMOKE_LLM_REQUIRED=1 turns the model evidence into a hard failure,
# and SMOKE_KEEP=1 leaves the workspace in place for inspection.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
SMOKE_MODEL=${SMOKE_MODEL:-opencode/mimo-v2.6-flash-free}
SMOKE_TIMEOUT=${SMOKE_TIMEOUT:-120}
SMOKE_LLM_REQUIRED=${SMOKE_LLM_REQUIRED:-0}
SMOKE_KEEP=${SMOKE_KEEP:-0}

for cmd in opencode node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "FAIL: $cmd is not on PATH"
    exit 1
  fi
done

WORK=$(mktemp -d "${SMOKE_TMP:-${TMPDIR:-/tmp}}/sdd-smoke-XXXXXX")
CONFIG="$WORK/xdg-config/opencode"
PROJECT="$WORK/project"
FAILURES=0

cleanup() {
  if [ "$SMOKE_KEEP" = "1" ]; then
    echo "smoke workspace kept at $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
warn() { echo "WARN: $*"; }
pass() { echo "PASS: $*"; }
llm_evidence() {
  if [ "$SMOKE_LLM_REQUIRED" = "1" ]; then
    fail "$*"
  else
    warn "$*"
  fi
}

export XDG_CONFIG_HOME="$WORK/xdg-config"
export XDG_DATA_HOME="$WORK/xdg-data"
export XDG_STATE_HOME="$WORK/xdg-state"
mkdir -p "$CONFIG" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

echo "==> Smoke of the OpenCode 2 wiring (model: $SMOKE_MODEL, timeout: ${SMOKE_TIMEOUT}s)"

echo "==> Installing the kit into the isolated config home"
node "$ROOT/tools/install/cli.mjs" install --dir "$CONFIG" --skip-deps --yes
cp "$ROOT/tools/test/smoke/smoke-probe.ts" "$CONFIG/plugins/zz-smoke-probe.ts"

echo "==> Installing the runtime dependencies (devDependencies stay out, the runtime never loads them)"
if ! (cd "$CONFIG" && npm install --ignore-scripts --omit=dev --no-audit --no-fund) >"$WORK/npm.log" 2>&1; then
  echo "FAIL: npm install failed inside the isolated config home"
  tail -20 "$WORK/npm.log"
  exit 1
fi

mkdir -p "$PROJECT"
cd "$PROJECT"
git init -q
echo "# smoke project" > README.md

echo "==> Booting through a status call"
STATUS_LOG="$WORK/status.log"
STATUS_JSONL="$WORK/status.jsonl"
RUN_STATUS=0
timeout "$SMOKE_TIMEOUT" opencode run --standalone --print-logs --auto --format json --model "$SMOKE_MODEL" \
  "Call the speckit-status tool exactly once, then reply with the single word done." \
  >"$STATUS_JSONL" 2>"$STATUS_LOG" || RUN_STATUS=$?
if [ "$RUN_STATUS" -ne 0 ]; then
  warn "the status run exited with code $RUN_STATUS, the checks below grade whatever it wrote"
fi

echo "==> Checking the plugin markers and the load log"
if grep -q '"speckit-guard"' "$PROJECT/.opencode/plugins-state.json" 2>/dev/null; then
  pass "the guard plugin marked itself"
else
  fail "the guard plugin did not mark itself in .opencode/plugins-state.json"
fi
if grep -q '"speckit-perfmon"' "$PROJECT/.opencode/plugins-state.json" 2>/dev/null; then
  pass "the perfmon plugin marked itself"
else
  fail "the perfmon plugin did not mark itself in .opencode/plugins-state.json"
fi
if grep -q '"speckit-doom-loop"' "$PROJECT/.opencode/plugins-state.json" 2>/dev/null; then
  pass "the doom loop plugin marked itself"
else
  fail "the doom loop plugin did not mark itself in .opencode/plugins-state.json"
fi
if grep -q "failed to load plugin" "$STATUS_LOG"; then
  fail "the server log reports a plugin that failed to load"
  grep "failed to load plugin" "$STATUS_LOG" | head -5
else
  pass "no plugin failed to load"
fi

echo "==> Checking the tool registry dump"
EXPECTED_TOOLS="speckit-approve speckit-audit speckit-clean speckit-complexity speckit-config speckit-delta speckit-evidence speckit-guard speckit-health speckit-mutation speckit-perf speckit-phase speckit-scaffold speckit-selfheal speckit-snapshot speckit-status speckit-validate"
if SMOKE_TOOLS_JSON="$PROJECT/.opencode/smoke-tools.json" SMOKE_EXPECTED_TOOLS="$EXPECTED_TOOLS" node -e '
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
'; then
  pass "the registry lists all 16 tools with direct exposure"
else
  fail "the tool registry dump does not match the expected surface"
fi

echo "==> Grading the model evidence"
if SMOKE_JSONL="$STATUS_JSONL" node -e '
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
'; then
  pass "the model called speckit-status directly"
else
  llm_evidence "the status run has no completed speckit-status call (the model or the network may be down)"
fi
if SMOKE_PERF_JSON="$PROJECT/.opencode/perf.json" node -e '
const fs = require("node:fs")
let perf
try {
  perf = JSON.parse(fs.readFileSync(process.env.SMOKE_PERF_JSON, "utf8"))
} catch {
  process.exit(1)
}
const entry = (perf.stats || []).find((stat) => stat.tool === "speckit-status")
process.exit(entry && entry.calls >= 1 ? 0 : 1)
'; then
  pass "the perfmon plugin recorded the call"
else
  llm_evidence "perfmon has no speckit-status entry (the model evidence is missing)"
fi

echo "==> Probing the guard"
GUARD_JSONL="$WORK/guard.jsonl"
GUARD_LOG="$WORK/guard.log"
RUN_GUARD=0
timeout "$SMOKE_TIMEOUT" opencode run --standalone --print-logs --auto --format json --model "$SMOKE_MODEL" \
  "You are testing the file guard. Try to overwrite the file spec.json in the project root with the text hacked, using the write tool first and a shell redirect if the write tool is blocked. Then reply with the single word done." \
  >"$GUARD_JSONL" 2>"$GUARD_LOG" || RUN_GUARD=$?
if [ "$RUN_GUARD" -ne 0 ]; then
  warn "the guard run exited with code $RUN_GUARD, the check below grades whatever it wrote"
fi
if grep -q "Guard blocked protected file" "$GUARD_JSONL"; then
  pass "the guard blocked the protected write"
else
  llm_evidence "the guard run shows no denial (the model may not have attempted the write)"
fi

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "SMOKE FAILED with $FAILURES problem(s)"
  if [ "$SMOKE_KEEP" != "1" ]; then
    echo "rerun with SMOKE_KEEP=1 to inspect the workspace"
  fi
  exit 1
fi
echo "SMOKE PASSED"
