#!/usr/bin/env bash
# Run every multianchor_comment test target (Java + Jest) from the Gerrit repo root.
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
cd "$REPO_ROOT"
exec bazel test //plugins/multianchor_comment:multianchor_comment_all_tests "$@"
