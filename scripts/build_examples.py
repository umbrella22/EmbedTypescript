#!/usr/bin/env python3
"""Build source examples into a new tree of precompiled applications."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new directory")
    parser.add_argument("--app", type=Path, help="one source application")
    parser.add_argument("--compiler", type=Path, help="existing native embedts executable")
    args = parser.parse_args()
    output = args.output.absolute()
    if output.exists(): raise ValueError(f"output already exists: {output}")
    compiler = args.compiler.resolve() if args.compiler else ROOT / "rust/target/debug/embedts"
    if not args.compiler:
        subprocess.run(["cargo", "build", "-p", "embedts-builder", "--locked", "--offline"], cwd=ROOT / "rust", check=True)
        metadata = subprocess.check_output(["cargo", "metadata", "--format-version=1", "--no-deps", "--locked", "--offline"], cwd=ROOT / "rust")
        compiler = Path(json.loads(metadata)["target_directory"]) / "debug/embedts"
    manifests = [args.app.resolve() / "launcher.json"] if args.app else sorted((ROOT / "typescript/examples").rglob("launcher.json"))
    manifests = [p for p in manifests if not any(part in ("dist", "node_modules") for part in p.relative_to(ROOT / "typescript/examples").parts)] if not args.app else manifests
    if not manifests: raise ValueError("no example launchers found")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        reports, identities = [], set()
        for manifest in manifests:
            with tempfile.TemporaryDirectory(prefix="embedts-app-") as stage:
                payload = Path(stage) / "payload"
                subprocess.run([str(compiler), "app", str(manifest.parent), "--out", str(payload)], cwd=ROOT / "rust", check=True)
                item = json.loads((payload / "build-report.json").read_text())["applications"][0]
                identity = item["id"]
                if identity in identities: raise ValueError(f"duplicate application id: {identity}")
                identities.add(identity)
                source_relative = manifest.parent.relative_to(ROOT / "typescript/examples") if not args.app else None
                relative = Path(identity) if args.app else (
                    Path(*source_relative.parts[:-1]) / identity if len(source_relative.parts) > 1
                    else Path("examples") / identity
                )
                destination = temporary / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(payload / identity, destination)
                item["source"] = str(manifest.parent) if args.app else manifest.parent.relative_to(ROOT).as_posix()
                item["directory"] = relative.as_posix()
                reports.append(item)
        (temporary / "build-report.json").write_text(json.dumps({"engine":"embedts","applications":reports},indent=2)+"\n")
        os.rename(temporary, output)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    print(f"{len(reports)} applications -> {output}")

if __name__ == "__main__": main()
