#!/usr/bin/env python3
"""Validate pinned third-party bytes and a standalone engine dependency graph."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
vendor = ROOT / "rust/engine/vendor"
provenance = json.loads((vendor / "quickjs-ng.json").read_text())
for name, expected in provenance["files"].items():
    assert hashlib.sha256((vendor / "quickjs-ng" / name).read_bytes()).hexdigest() == expected, name
tree = subprocess.check_output(["cargo", "tree", "-p", "embedts-engine", "--edges", "normal", "--locked", "--offline"], cwd=ROOT / "rust", text=True)
assert not any(name in tree for name in ("app-host", "esp-hal", "rs_lvgl", "lua-engine", "embedts-builder")), tree
print(f"{len(provenance['files'])} QuickJS-NG files verified; engine dependencies are independent of the OS")
