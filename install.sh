#!/usr/bin/env bash
set -euo pipefail

# speckit-sdd Installer — Linux / macOS / Git Bash
# Usage: curl -fsSL https://raw.githubusercontent.com/Nemryz/opencode-sdd-kit/master/install.sh | bash
# Or:   ./install.sh

REPO="Nemryz/opencode-sdd-kit"
BRANCH="master"
CONFIG_DIR="${HOME}/.config/opencode"
TMP_DIR=$(mktemp -d)

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "==> Cloning opencode-sdd-kit (${BRANCH})..."
git clone --depth 1 --branch "${BRANCH}" "https://github.com/${REPO}.git" "${TMP_DIR}/opencode-sdd-kit"

echo "==> Installing files..."
mkdir -p "${CONFIG_DIR}"
cp "${TMP_DIR}/opencode-sdd-kit/AGENTS.md" "${CONFIG_DIR}/AGENTS.md"
if [ ! -f "${CONFIG_DIR}/opencode.jsonc" ]; then
  cp "${TMP_DIR}/opencode-sdd-kit/opencode.jsonc.example" "${CONFIG_DIR}/opencode.jsonc"
fi
cp "${TMP_DIR}/opencode-sdd-kit/package.json" "${CONFIG_DIR}/package.json"
cp "${TMP_DIR}/opencode-sdd-kit/package-lock.json" "${CONFIG_DIR}/package-lock.json" 2>/dev/null || true

cp -r "${TMP_DIR}/opencode-sdd-kit/agents" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-kit/commands" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-kit/templates" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-kit/skills" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-kit/tools" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-kit/plugins" "${CONFIG_DIR}/"
cp -r "${TMP_DIR}/opencode-sdd-kit/docs" "${CONFIG_DIR}/"

echo "==> Installing dependencies..."
cd "${CONFIG_DIR}"
npm install --ignore-scripts 2>/dev/null || echo "    (npm install skipped, manual install may be needed)"

echo ""
echo "==> Done! opencode-sdd-kit installed to ${CONFIG_DIR}"
echo "    Restart opencode and run /status to verify."
