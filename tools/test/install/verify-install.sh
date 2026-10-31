#!/usr/bin/env bash
set -euo pipefail

# Checks the file surface install.sh leaves behind, so the CI installation job fails loudly when a file stops shipping.
# Usage: verify-install.sh <target-dir> [--backup]

TARGET="${1:?verify-install.sh needs the target directory}"
MODE="${2:-}"

# Converts the Windows form of the path when the script runs under Git Bash on a Windows runner.
if command -v cygpath >/dev/null 2>&1; then
  TARGET=$(cygpath -u "${TARGET}")
fi

FAILURES=0

expect_path() {
  if [ -e "${TARGET}/$1" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: missing $1"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_text() {
  if grep -q -- "$2" "${TARGET}/$1" 2>/dev/null; then
    echo "PASS: $1 contains the marker"
  else
    echo "FAIL: $1 is missing the marker"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_path AGENTS.md
expect_path opencode.jsonc
expect_path package.json
expect_path agents/spec.md
expect_path commands/status.md
expect_path commands/lab.md
expect_path templates/spec-template.md
expect_path templates/constitution-template.md
expect_path skills/speckit-constitution/SKILL.md
expect_path tools/speckit-status.ts
expect_path tools/speckit-evidence.ts
expect_path tools/speckit-archive.ts
expect_path tools/speckit-lab.ts
expect_path tools/lab/core/runner.ts
expect_path tools/lab/adapters/integrity.ts
expect_path tools/lab/vitest.config.lab.ts
expect_path tools/lab/core/diff.ts
expect_path tools/lab/core/prune.ts
expect_path tools/lab/core/baseline.ts
expect_path tools/lab/core/flakes.ts
expect_path tools/shared/state/plan.ts
expect_path tools/shared/state/apply.ts
expect_path tools/shared/state/recovery.ts
expect_path tools/install/cli.mjs
expect_path plugins/speckit-tools.ts
expect_path plugins/speckit-doom-loop.ts
expect_path plugins/speckit-events.ts
expect_path docs/testing.md
expect_path docs/showcase.md
expect_path docs/lab.md
expect_path docs/state-transactions.md
expect_path npm-shrinkwrap.json

if [ "${MODE}" = "--backup" ]; then
  BACKUP_DIR=""
  BACKUP_COUNT=0
  if [ -d "${TARGET}/.install-backups" ]; then
    for candidate in "${TARGET}/.install-backups"/*/; do
      [ -d "${candidate}" ] || continue
      BACKUP_DIR="${candidate%/}"
      BACKUP_COUNT=$((BACKUP_COUNT + 1))
    done
  fi

  if [ "${BACKUP_COUNT}" -eq 1 ]; then
    echo "PASS: the reinstall created exactly one backup folder"
  else
    echo "FAIL: expected one backup folder, found ${BACKUP_COUNT}"
    FAILURES=$((FAILURES + 1))
  fi

  if [ -n "${BACKUP_DIR}" ] && grep -q "user edit" "${BACKUP_DIR}/AGENTS.md" 2>/dev/null; then
    echo "PASS: the backup holds the edited AGENTS.md"
  else
    echo "FAIL: the backup does not hold the edited AGENTS.md"
    FAILURES=$((FAILURES + 1))
  fi

  if grep -q "user edit" "${TARGET}/AGENTS.md" 2>/dev/null; then
    echo "FAIL: the reinstall kept the edited AGENTS.md"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: the reinstall replaced AGENTS.md"
  fi

  expect_text opencode.jsonc "user config"
fi

if [ "${FAILURES}" -gt 0 ]; then
  echo "VERIFY FAILED (${FAILURES} check(s))"
  exit 1
fi
echo "VERIFY PASSED"
