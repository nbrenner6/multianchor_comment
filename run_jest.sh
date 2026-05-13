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
shopt -s nullglob
for f in "${SOURCE_DIR}/src/test/frontend/"*.js; do
  cp "$f" "$WORK_DIR/src/test/frontend/"
done
shopt -u nullglob
cp "${SOURCE_DIR}/package.json" "$WORK_DIR/package.json"
cp "${SOURCE_DIR}/package-lock.json" "$WORK_DIR/package-lock.json"
cp "${SOURCE_DIR}/jest.config.cjs" "$WORK_DIR/jest.config.cjs"

cd "$WORK_DIR"

if [[ ! -d node_modules ]]; then
  npm ci --no-audit --no-fund
fi

npm test

# Emit machine-readable Jest totals for logs / CI (Istanbul json-summary).
if [[ -f coverage/coverage-summary.json ]]; then
  echo "=== multianchor_comment Jest coverage (totals) ==="
  node -e "
    const t = require('./coverage/coverage-summary.json').total;
    const fmt = (k) => {
      const x = t[k];
      return x ? x.pct.toFixed(2) + '% (' + x.covered + '/' + x.total + ')' : 'n/a';
    };
    console.log('  statements: ' + fmt('statements'));
    console.log('  branches:   ' + fmt('branches'));
    console.log('  functions:  ' + fmt('functions'));
    console.log('  lines:      ' + fmt('lines'));
  " || true
fi

# Bazel collects undeclared outputs for inspection after the run.
if [[ -n "${TEST_UNDECLARED_OUTPUTS_DIR:-}" ]] && [[ -d coverage ]]; then
  mkdir -p "${TEST_UNDECLARED_OUTPUTS_DIR}/jest-coverage"
  cp coverage/coverage-summary.json "${TEST_UNDECLARED_OUTPUTS_DIR}/jest-coverage/" 2>/dev/null || true
  cp coverage/lcov.info "${TEST_UNDECLARED_OUTPUTS_DIR}/jest-coverage/" 2>/dev/null || true
fi
