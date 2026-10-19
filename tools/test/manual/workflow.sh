#!/usr/bin/env bash
set -euo pipefail

# Manual SDD workflow test — Linux / macOS / Git Bash
# Run from the OpenCode SDD Integrity root directory:
#   bash tools/test/manual/workflow.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$KIT_DIR"

echo ""
echo "========================================"
echo "  OpenCode SDD Integrity — Manual Workflow Test"
echo "========================================"
echo ""

# 1. Verify dependencies
echo "==> Checking dependencies..."
node --version >/dev/null 2>&1 || { echo "FAIL: Node.js required"; exit 1; }
npm --version >/dev/null 2>&1 || { echo "FAIL: npm required"; exit 1; }

# 2. Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "==> Installing dependencies..."
  npm install --ignore-scripts
fi

# 3. Run full vitest suite
echo "==> Running full vitest suite..."
npx vitest run
TEST_EXIT=$?

# 4. Run manual workflow test
echo ""
echo "==> Running manual workflow test..."
npx vitest run tools/test/manual/workflow.test.ts
WORKFLOW_EXIT=$?

echo ""
if [ $TEST_EXIT -eq 0 ] && [ $WORKFLOW_EXIT -eq 0 ]; then
  echo "All tests PASSED"
  exit 0
else
  echo "Some tests FAILED (vitest: $TEST_EXIT, workflow: $WORKFLOW_EXIT)"
  exit 1
fi
