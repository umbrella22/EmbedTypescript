#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 scripts/check_sources.py
(
  cd rust
  cargo fmt --all --check
  cargo test --workspace --features embedts-engine/compiler --locked --offline
)
export EMBEDTS_TEST_COMPILER
EMBEDTS_TEST_COMPILER="$(cd rust && cargo metadata --format-version=1 --no-deps --locked --offline | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"] + "/debug/embedts")')"
export EMBEDTS_BIN="$EMBEDTS_TEST_COMPILER"
python3 -m unittest discover -s tests/integration -p 'test_*.py'
python3 -m unittest discover -s tests/integration/benchmarks -p 'test_*.py'
pnpm -C typescript test
pnpm -C typescript typecheck
pnpm -C typescript check:apps
