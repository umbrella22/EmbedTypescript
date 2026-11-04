#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 scripts/check_sources.py
(
  cd rust
  cargo fmt --all --check
  cargo test --workspace --features embedts-engine/compiler --locked --offline
)
python3 -m unittest discover -s tests/integration/benchmarks -p 'test_*.py'
pnpm -C typescript typecheck
pnpm -C typescript check:apps
