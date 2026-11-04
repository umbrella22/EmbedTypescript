#!/usr/bin/env python3
"""Build the physical TS parity probe and restricted brain fixtures. No device IO."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new directory")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    app = args.output / "app"
    (app / "scripts").mkdir(parents=True)
    (app / "assets").mkdir()
    shutil.copyfile(SOURCE / "launcher.json", app / "launcher.json")
    for name in ("alpha.png", "one.dfn"):
        shutil.copyfile(SOURCE / "assets" / name, app / "assets" / name)
    builds = [(source, app / "scripts" / (source.stem + ".etb"))
              for source in sorted((SOURCE / "scripts").glob("*.ts"))]
    brain = args.output / "brain"
    brain.mkdir()
    builds += [(source, brain / (source.stem + ".etb"))
               for source in sorted((SOURCE / "brain").glob("*.ts"))]
    reports = []
    for source, target in builds:
        run = subprocess.run(["cargo", "run", "-p", "embedts-builder", "--locked", "--offline", "--",
                              "build", str(source), "--out", str(target.resolve())],
                             cwd=ROOT, text=True, capture_output=True)
        if run.returncode:
            raise SystemExit(run.stdout + run.stderr)
        data = target.read_bytes()
        reports.append({"source": str(source.relative_to(ROOT)),
                        "package": str(target.relative_to(args.output)),
                        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    (args.output / "build-report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"app": str(app), "brain": str(brain), "packages": len(reports)}))


if __name__ == "__main__":
    main()
