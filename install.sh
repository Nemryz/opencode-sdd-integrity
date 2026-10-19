#!/usr/bin/env bash
set -euo pipefail

# OpenCode SDD Integrity Installer — Linux / macOS / Git Bash
# Usage: curl -fsSL https://raw.githubusercontent.com/Nemryz/opencode-sdd-integrity/V2/install.sh | bash -s -- [options]
# Or:   ./install.sh [options]
# Options:
#   --ref <branch|tag>   Git ref to install, defaults to V2 and accepts V1 for the OpenCode 1 toolkit
#   --dir <path>         Configuration directory, defaults to ~/.config/opencode
#   --skip-deps          Copy the files without running npm install
#   -h, --help           Print this usage block

REPO="Nemryz/opencode-sdd-integrity"
REF="V2"
CONFIG_DIR="${HOME}/.config/opencode"
SKIP_DEPS=0
TMP_DIR=$(mktemp -d)

usage() {
  echo "Usage: install.sh [--ref <branch|tag>] [--dir <path>] [--skip-deps]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a branch or tag}"; shift 2 ;;
    --dir) CONFIG_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Expands the tilde a quoted --dir keeps literal.
CONFIG_DIR="${CONFIG_DIR/#\~/$HOME}"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "==> Cloning opencode-sdd-integrity (${REF})..."
git clone --depth 1 --branch "${REF}" "https://github.com/${REPO}.git" "${TMP_DIR}/opencode-sdd-integrity"

echo "==> Installing files..."
mkdir -p "${CONFIG_DIR}"

# Copies every file this run is about to replace into a timestamped backup folder.
ITEMS="AGENTS.md package.json npm-shrinkwrap.json agents commands templates skills tools plugins docs"
BACKUP_DIR=""
for item in $ITEMS; do
  [ -e "${CONFIG_DIR}/${item}" ] || continue
  if [ -z "${BACKUP_DIR}" ]; then
    mkdir -p "${CONFIG_DIR}/.install-backups"
    BACKUP_DIR=$(mktemp -d "${CONFIG_DIR}/.install-backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  fi
  cp -r "${CONFIG_DIR}/${item}" "${BACKUP_DIR}/${item}"
done
if [ -n "${BACKUP_DIR}" ]; then
  echo "    Previous files saved to ${BACKUP_DIR}"
fi

cp "${TMP_DIR}/opencode-sdd-integrity/AGENTS.md" "${CONFIG_DIR}/AGENTS.md"
if [ ! -f "${CONFIG_DIR}/opencode.jsonc" ]; then
  cp "${TMP_DIR}/opencode-sdd-integrity/opencode.jsonc.example" "${CONFIG_DIR}/opencode.jsonc"
fi
cp "${TMP_DIR}/opencode-sdd-integrity/package.json" "${CONFIG_DIR}/package.json"
cp "${TMP_DIR}/opencode-sdd-integrity/npm-shrinkwrap.json" "${CONFIG_DIR}/npm-shrinkwrap.json" 2>/dev/null || true

cp -r "${TMP_DIR}/opencode-sdd-integrity/agents" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-integrity/commands" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-integrity/templates" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-integrity/skills" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-integrity/tools" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-integrity/plugins" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-integrity/docs" "${CONFIG_DIR}/"

if [ "${SKIP_DEPS}" = "1" ]; then
  echo "==> Skipping dependencies (--skip-deps)"
else
  echo "==> Installing dependencies..."
  cd "${CONFIG_DIR}"
  npm install --ignore-scripts 2>/dev/null || echo "    (npm install skipped, manual install may be needed)"
fi

echo ""
echo "==> Done! opencode-sdd-integrity installed to ${CONFIG_DIR}"
echo "    Restart opencode and run /status to verify."
