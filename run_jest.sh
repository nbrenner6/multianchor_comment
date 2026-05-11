#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -n "${TEST_SRCDIR:-}" && -n "${TEST_WORKSPACE:-}" ]]; then
  SOURCE_DIR="${TEST_SRCDIR}/${TEST_WORKSPACE}/plugins/multianchor_comment"
else
  SOURCE_DIR="$SCRIPT_DIR"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
export npm_config_cache="$WORK_DIR/.npm-cache"

mkdir -p "$WORK_DIR/src/main/resources/static"
mkdir -p "$WORK_DIR/src/test/frontend"

cp "${SOURCE_DIR}/src/main/resources/static/multianchor_comment.js" \
  "$WORK_DIR/src/main/resources/static/multianchor_comment.js"
cp "${SOURCE_DIR}/src/test/frontend/multianchor_comment.test.js" \
  "$WORK_DIR/src/test/frontend/multianchor_comment.test.js"
cp "${SOURCE_DIR}/package.json" "$WORK_DIR/package.json"
cp "${SOURCE_DIR}/package-lock.json" "$WORK_DIR/package-lock.json"
cp "${SOURCE_DIR}/jest.config.cjs" "$WORK_DIR/jest.config.cjs"

cd "$WORK_DIR"

if [[ ! -d node_modules ]]; then
  npm ci --no-audit --no-fund
fi

npm test
