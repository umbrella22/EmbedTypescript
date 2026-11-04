#!/usr/bin/env python3
"""Build paired benchmark apps, measure host engines, or compare device logs."""
import argparse
import datetime
import hashlib
import json
import math
import platform
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import sys
import uuid

from reference import CASES, expected

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
RUST = REPO / "rust"
DANGO_REPO = None
PREFIX = "DANGO_BENCH "
SUITE = json.loads((HERE / "suite.json").read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_receipt():
    return {name: sha(HERE / name) for name in ("suite.json", "reference.py", "lua/main.lua", "ts/main.ts")}


def fingerprint():
    return hashlib.sha256(json.dumps(source_receipt(), sort_keys=True).encode()).hexdigest()


def config(profile, engine, samples=None, run_id=None):
    definition = SUITE["profiles"][profile]
    return {"suite": SUITE["suite"], "profile": profile, "fingerprint": fingerprint(),
            "run_id": run_id or f"{profile}-{engine}-{uuid.uuid4().hex[:12]}",
            "units": definition["units"], "expected": [expected(c, u) for c, u in zip(CASES, definition["units"])],
            "samples": samples if samples is not None else definition["samples"],
            "yield_every": definition["yield_every"]}


def command(args, log, cwd=None):
    with log.open("ab") as stream:
        stream.write(("$ " + " ".join(map(str, args)) + "\n").encode())
        stream.flush()
        subprocess.run(list(map(str, args)), cwd=cwd or REPO, stdout=stream, stderr=subprocess.STDOUT, check=True)


def target_dir(repo=RUST):
    raw = subprocess.check_output(["cargo", "metadata", "--format-version=1", "--no-deps", "--offline"], cwd=repo)
    return Path(json.loads(raw)["target_directory"])


def build(output, profile, samples=None):
    output.mkdir(parents=True, exist_ok=False)
    log = output / "build.log"
    command(["cargo", "build", "-p", "embedts-builder", "--locked", "--offline"], log, cwd=RUST)
    command(["cargo", "build", "-p", "app-pack", "--locked", "--offline"], log, cwd=DANGO_REPO)
    target = target_dir()
    applications = {}
    (output / "bundles").mkdir()
    for engine in ("lua", "ts"):
        app = output / engine / "script-bench"
        (app / "scripts").mkdir(parents=True)
        args = config(profile, engine, samples)
        if engine == "lua":
            entry = "scripts/main.lua"
            shutil.copyfile(HERE / "lua/main.lua", app / entry)
        else:
            entry = "scripts/main.etb"
            command([target / "debug/embedts", "build", HERE / "ts/main.ts", "--out", app / entry], log)
        manifest = {"schema_version": 1, "id": "script-bench", "entry": entry,
                    "display_name": f"Script Bench {engine.upper()}", "args": args, "order": 99, "visible": True}
        write_json(app / "launcher.json", manifest)
        command([target_dir(DANGO_REPO) / "debug/app-pack", "bundle", app, output / "bundles" / engine], log)
        applications[engine] = {"directory": str(app.relative_to(output)), "entry": entry,
                                "sha256": sha(app / entry), "args": args}
    receipt = {"status": "built", "profile": profile, "fingerprint": fingerprint(), "sources": source_receipt(),
               "compiler": json.loads(subprocess.check_output([target / "debug/embedts", "--version"], cwd=REPO)),
               "quickjs": json.loads((REPO / "rust/engine/vendor/quickjs-ng.json").read_text())["commit"],
               "applications": applications, "device_executed": False}
    write_json(output / "build.json", receipt)
    return receipt


def integer(value, low=0, high=None):
    if type(value) is not int or value < low or (high is not None and value > high):
        raise ValueError(f"invalid integer: {value!r}")
    return value


def duration(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError(f"invalid duration: {value!r}")
    return value


def validate(events, engine, host=False):
    """Accept exactly one complete run in case/sample order, including warmups."""
    if not isinstance(events, list) or not events or not all(isinstance(e, dict) for e in events):
        raise ValueError("no benchmark events")
    start = events[0]
    profile = start.get("profile")
    if start.get("event") != "start" or start.get("engine") != engine or start.get("suite") != SUITE["suite"]:
        raise ValueError("missing or mismatched run identity")
    if profile not in SUITE["profiles"] or start.get("fingerprint") != fingerprint():
        raise ValueError("unknown profile or different benchmark sources; rebuild both payloads")
    definition = SUITE["profiles"][profile]
    if start.get("units") != definition["units"] or start.get("yield_every") != definition["yield_every"] or start.get("warmup") != 1:
        raise ValueError("workload or scheduling parameters differ")
    if not isinstance(start.get("run_id"), str) or not start["run_id"]:
        raise ValueError("missing run id")
    samples = integer(start.get("samples"), 1, 9)
    cursor, measurements = 1, []
    for case, units in zip(CASES, definition["units"]):
        checksum = expected(case, units)
        for sample in range(-1, samples):
            if sample >= 0:
                if cursor >= len(events) or events[cursor] != {"event": "begin", "case": case, "sample": sample, "units": units}:
                    raise ValueError(f"missing/duplicate/out-of-order begin: {case}/{sample}")
                cursor += 1
            if cursor >= len(events):
                raise ValueError(f"incomplete run: {case}/{sample}")
            row = events[cursor]
            cursor += 1
            if (row.get("event"), row.get("case"), row.get("sample"), row.get("units")) != (
                    "warmup" if sample < 0 else "sample", case, sample, units):
                raise ValueError(f"missing/duplicate/out-of-order sample: {case}/{sample}")
            if integer(row.get("checksum")) != checksum:
                raise ValueError(f"bad checksum: {case}/{sample}")
            duration(row.get("elapsed_ms"))
            if sample >= 0:
                if host:
                    elapsed = integer(row.get("host_vm_ns"), 1)
                    wall = integer(row.get("host_wall_ns"), elapsed)
                else:
                    if "host_vm_ns" in row or "host_wall_ns" in row:
                        raise ValueError("host timings in a device log")
                    elapsed = wall = row["elapsed_ms"] * 1_000_000
                measurements.append({**row, "elapsed_ns": elapsed, "wall_ns": wall})
    if cursor + 1 != len(events) or events[cursor] != {"event": "done", "samples": samples * len(CASES)}:
        raise ValueError("missing completion marker or trailing/duplicate runs")
    return start, measurements


def read_run(path, engine):
    raw = path.read_text()
    if raw.lstrip().startswith("{"):
        report = json.loads(raw)
        if "events" in report:
            if report.get("engine") != engine:
                raise ValueError("host report engine mismatch")
            start, samples = validate(report["events"], engine, host=True)
            return "host", start, samples
    decoder = EventDecoder()
    events = []
    for line in raw.splitlines():
        event = decoder.feed(line)
        if event is not None:
            events.append(event)
    decoder.finish()
    start, samples = validate(events, engine)
    return "device", start, samples


class EventDecoder:
    """Reassemble ASCII benchmark events within the device's 158-byte log limit."""
    def __init__(self):
        self.sequence = 0
        self.parts = []
        self.total = 0

    def feed(self, line):
        line = re.sub(r"\x1b\[[0-9;]*m", "", line)
        marker = "DANGO_BENCH_PART "
        if marker in line:
            raw = line.split(marker, 1)[1]
            header, separator, content = raw.partition(" ")
            match = re.fullmatch(r"([1-9][0-9]*)/([1-9][0-9]*)/([1-9][0-9]*)", header)
            if not match or not separator:
                raise ValueError("invalid benchmark fragment header")
            sequence, index, total = map(int, match.groups())
            if sequence != self.sequence + 1 or index != len(self.parts) + 1 or not 1 <= index <= total <= 64:
                raise ValueError("missing, duplicate or out-of-order benchmark fragment")
            if self.parts and total != self.total:
                raise ValueError("benchmark fragment count changed")
            if not content.isascii() or not 1 <= len(content) <= 64 or (index < total and len(content) != 64):
                raise ValueError("truncated or invalid benchmark fragment")
            self.parts.append(content)
            self.total = total
            if index == total:
                event = json.loads("".join(self.parts))
                self.parts = []
                self.sequence = sequence
                return event
        elif PREFIX in line:
            if self.parts:
                raise ValueError("incomplete benchmark fragment")
            return json.loads(line.split(PREFIX, 1)[1])
        return None

    def finish(self):
        if self.parts:
            raise ValueError("incomplete benchmark fragment")


def stats(values):
    return {"n": len(values), "median_ms": statistics.median(values) / 1e6,
            "min_ms": min(values) / 1e6, "max_ms": max(values) / 1e6,
            "cv_percent": statistics.stdev(values) / statistics.mean(values) * 100 if len(values) > 1 and any(values) else 0}


def compare_runs(runs, environment):
    baselines, rows, all_samples, seen = [], [], {"lua": [], "ts": []}, set()
    counts = {}
    for engine in ("lua", "ts"):
        counts[engine] = len(runs[engine])
        for kind, start, samples in runs[engine]:
            identity = (engine, start["run_id"])
            if identity in seen:
                raise ValueError("duplicate run id")
            seen.add(identity)
            baselines.append((kind, start["suite"], start["profile"], start["fingerprint"], start["units"],
                              start["yield_every"], start["samples"]))
            all_samples[engine].extend(samples)
    if not baselines or any(value != baselines[0] for value in baselines) or counts["lua"] != counts["ts"]:
        raise ValueError("cannot compare different environments, profiles, units, samples or yield policies")
    for case in CASES:
        timing = {}
        for engine in ("lua", "ts"):
            values = [s for s in all_samples[engine] if s["case"] == case]
            timing[engine] = {**stats([s["elapsed_ns"] for s in values]),
                              "wall_median_ms": statistics.median(s["wall_ns"] for s in values) / 1e6,
                              "checksum": values[0]["checksum"], "units": values[0]["units"]}
        lua, ts = timing["lua"]["median_ms"], timing["ts"]["median_ms"]
        rows.append({"case": case, **timing, "ts_over_lua": ts / lua if lua > 0 and ts > 0 else None})
    return {"status": "passed", "environment": environment, "measurement": baselines[0][0],
            "profile": baselines[0][2], "fingerprint": baselines[0][3], "results": rows,
            "samples": all_samples, "device_executed": baselines[0][0] == "device",
            "preliminary": any(row["lua"]["n"] < 3 for row in rows)}


def markdown(report):
    lines = ["# Lua / TypeScript computation benchmark", "",
             f"Environment: **{report['measurement']}**. Profile: `{report['profile']}`.", "",
             "The ratio is TS time / Lua time; values above 1 mean Lua completed sooner.", "",
             "| Workload | Lua median ms | TS median ms | TS / Lua | Lua CV % | TS CV % | Samples / engine |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for row in report["results"]:
        ratio = f"{row['ts_over_lua']:.2f}" if row["ts_over_lua"] is not None else "below timer resolution"
        lines.append(f"| {row['case']} | {row['lua']['median_ms']:.3f} | {row['ts']['median_ms']:.3f} | {ratio} | "
                     f"{row['lua']['cv_percent']:.2f} | {row['ts']['cv_percent']:.2f} | {row['lua']['n']} |")
    lines += ["", "Host times measure wall time inside VM calls, including host callbacks, cooperative yields and natural GC.",
              "Compilation, loading, setup, warmup and time outside VM calls are excluded from host medians.",
              "Host wall medians and every raw sample are retained in report.json. Host CPU preemption remains included.",
              "Device times use the app's monotonic millisecond clock and include scheduling and zero-duration sleeps.",
              "The two measurement methods must be assessed separately. Host results do not predict ESP32 ranking.", ""]
    if report["preliminary"]:
        lines += ["Fewer than three samples: smoke validation only.", ""]
    return "\n".join(lines)


def save_report(output, report):
    write_json(output / "report.json", report)
    (output / "report.md").write_text(markdown(report))
    print(markdown(report))


def environment():
    info = {"system": platform.platform(), "machine": platform.machine(), "processor": platform.processor(),
            "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "rust": subprocess.check_output(["rustc", "-Vv"], cwd=REPO, text=True).strip(),
            "git_head": subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, text=True, capture_output=True).stdout.strip() or "uncommitted",
            "git_status": subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO, text=True),
            "release": True, "jit": False, "thermal_control": "uncontrolled", "clock_control": "uncontrolled"}
    if sys.platform == "darwin":
        info["cpu"] = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
    sources = {}
    for root in ("rust/engine", "rust/builder", "typescript/packages/sdk", "tests/integration/benchmarks"):
        for path in sorted((REPO / root).rglob("*")):
            if path.is_file() and not any(p in ("node_modules", "target") for p in path.relative_to(REPO / root).parts):
                sources[path.relative_to(REPO).as_posix()] = sha(path)
    sources["Cargo.lock"] = sha(REPO / "Cargo.lock")
    if DANGO_REPO is not None:
        info["dangoos_git_head"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=DANGO_REPO, text=True).strip()
        info["dangoos_git_status"] = subprocess.check_output(["git", "status", "--porcelain"], cwd=DANGO_REPO, text=True)
        for component in ("crates/lua-engine", "crates/app-host", "tests/benchmarks/script-engines/runner"):
            for path in sorted((DANGO_REPO / component).rglob("*")):
                if path.is_file() and not any(part in ("target", "node_modules") for part in path.relative_to(DANGO_REPO).parts):
                    sources["dangoos/" + path.relative_to(DANGO_REPO).as_posix()] = sha(path)
        sources["dangoos/Cargo.lock"] = sha(DANGO_REPO / "Cargo.lock")
    info["source_hashes"] = sources
    return info


def host(output, profile, rounds):
    output.mkdir(parents=True, exist_ok=False)
    receipt = build(output / "apps", profile, samples=1)
    log = output / "runner-build.log"
    binaries = output / "bin"
    binaries.mkdir()
    target = target_dir(DANGO_REPO)
    for engine in ("lua", "ts"):
        command(["cargo", "build", "-p", "script-bench-runner", "--release", "--no-default-features",
                 "--features", engine, "--locked", "--offline"], log, cwd=DANGO_REPO)
        shutil.copy2(target / "release/script-bench-runner", binaries / engine)
    env = environment()
    env["runners"] = {e: sha(binaries / e) for e in ("lua", "ts")}
    env["compiler"] = receipt["compiler"]
    env["quickjs"] = receipt["quickjs"]
    write_json(output / "environment.json", env)
    raw = output / "raw"
    raw.mkdir()
    runs = {"lua": [], "ts": []}
    order = []
    for trial in range(rounds):
        # A fresh VM/process for every round; each case warms up immediately before its sample.
        engines = ("lua", "ts") if trial % 2 == 0 else ("ts", "lua")
        for engine in engines:
            order.append(engine)
            app = receipt["applications"][engine]
            args_path = raw / f"{engine}-{trial + 1:02d}-args.json"
            write_json(args_path, {**app["args"], "run_id": f"{engine}-{trial + 1}-{uuid.uuid4().hex[:12]}"})
            entry = output / "apps" / app["directory"] / app["entry"]
            completed = subprocess.run([binaries / engine, entry, args_path], cwd=REPO, capture_output=True, text=True, timeout=320)
            path = raw / f"{engine}-{trial + 1:02d}.json"
            path.write_text(completed.stdout)
            (raw / f"{engine}-{trial + 1:02d}.stderr").write_text(completed.stderr)
            completed.check_returncode()
            runs[engine].append(read_run(path, engine))
            print(f"round {trial + 1}/{rounds}: {engine} checksums passed", flush=True)
    report = compare_runs(runs, env)
    report["run_order"] = order
    report["memory"] = {e: [json.loads((raw / f"{e}-{i + 1:02d}.json").read_text())["memory"] for i in range(rounds)] for e in runs}
    save_report(output, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("build", "host"):
        sub = commands.add_parser(action)
        sub.add_argument("output", type=Path, help="new output directory")
        sub.add_argument("--dango-root", type=Path, required=True, help="OS checkout with the Lua/TS benchmark runner and app-pack")
        sub.add_argument("--profile", choices=tuple(SUITE["profiles"]), default="device" if action == "build" else "host")
        if action == "host":
            sub.add_argument("--rounds", type=int, choices=range(1, 10), default=5)
    sub = commands.add_parser("compare")
    sub.add_argument("lua_log", type=Path)
    sub.add_argument("ts_log", type=Path)
    sub.add_argument("--out", type=Path, required=True, help="new output directory")
    sub.add_argument("--device-info", type=Path, help="JSON record of board, firmware hashes, clock, power and background services")
    args = parser.parse_args()
    global DANGO_REPO
    if args.action in ("build", "host"):
        DANGO_REPO = args.dango_root.resolve()
    if args.action == "build":
        build(args.output.resolve(), args.profile)
        print(f"paired payloads: {args.output}")
    elif args.action == "host":
        host(args.output.resolve(), args.profile, args.rounds)
    else:
        runs = {"lua": [read_run(args.lua_log, "lua")], "ts": [read_run(args.ts_log, "ts")]}
        info = json.loads(args.device_info.read_text()) if args.device_info else {"conditions": "not supplied"}
        report = compare_runs(runs, info)
        report["input_logs"] = {str(p.resolve()): sha(p) for p in (args.lua_log, args.ts_log)}
        args.out.mkdir(parents=True, exist_ok=False)
        save_report(args.out, report)


if __name__ == "__main__":
    main()
