#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 scripts/check_sources.py
cargo fmt --all --check
cargo test --workspace --features embedts-engine/compiler --locked --offline
python3 -m unittest discover -s tests/benchmarks -p 'test_*.py'
pnpm typecheck
pnpm check:apps
