"""Benchmark evidence validation. Fixtures are protocol tests, never timings."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

SUITE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SUITE_DIR))
try:
    spec = importlib.util.spec_from_file_location("script_bench", SUITE_DIR / "bench.py")
    BENCH = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(BENCH)
finally:
    sys.path.remove(str(SUITE_DIR))


def events(engine, host=False, milliseconds=20):
    args = BENCH.config("smoke", engine, run_id=f"fixture-{engine}")
    rows = [{k: v for k, v in args.items() if k != "expected"}]
    rows[0].update(event="start", engine=engine, warmup=1)
    for case, units, checksum in zip(BENCH.CASES, args["units"], args["expected"]):
        rows.append({"event": "warmup", "case": case, "sample": -1, "units": units,
                     "checksum": checksum, "elapsed_ms": milliseconds})
        rows.append({"event": "begin", "case": case, "sample": 0, "units": units})
        row = {"event": "sample", "case": case, "sample": 0, "units": units,
               "checksum": checksum, "elapsed_ms": milliseconds}
        if host:
            row.update(host_vm_ns=milliseconds * 1000000, host_wall_ns=(milliseconds + 1) * 1000000)
        rows.append(row)
    rows.append({"event": "done", "samples": 6})
    return rows


def run(engine, host=False, milliseconds=20):
    start, samples = BENCH.validate(events(engine, host, milliseconds), engine, host)
    return "host" if host else "device", start, samples


class ScriptBenchmarksTests(unittest.TestCase):
    def test_framed_log_roundtrip_stays_within_device_line_capacity(self):
        decoder = BENCH.EventDecoder()
        decoded = []
        for sequence, event in enumerate(events("ts"), 1):
            text = json.dumps(event)
            chunks = [text[i:i + 64] for i in range(0, len(text), 64)]
            for index, chunk in enumerate(chunks, 1):
                line = f"[INFO] ts[script-bench]> DANGO_BENCH_PART {sequence}/{index}/{len(chunks)} {chunk}"
                self.assertLessEqual(len(line.encode()), 158)
                self.assertIsNone(decoder.feed("[INFO] background interleaved log"))
                value = decoder.feed(line)
                if value is not None:
                    decoded.append(value)
        decoder.finish()
        self.assertEqual(decoded, events("ts"))
        BENCH.validate(decoded, "ts")

    def test_fragment_loss_truncation_and_duplicate_are_rejected(self):
        first = "DANGO_BENCH_PART 1/1/3 " + "x" * 64
        for second in (first, "DANGO_BENCH_PART 1/3/3 tail", "DANGO_BENCH_PART 1/2/3 short",
                       "DANGO_BENCH_PART 2/2/3 " + "x" * 64):
            decoder = BENCH.EventDecoder()
            decoder.feed(first)
            with self.subTest(second=second), self.assertRaises(ValueError):
                decoder.feed(second)
        decoder = BENCH.EventDecoder()
        decoder.feed(first)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            decoder.finish()

    def test_reference_vectors_are_stable(self):
        self.assertEqual(tuple(BENCH.SUITE["cases"]), BENCH.CASES)
        self.assertEqual(BENCH.config("smoke", "lua")["expected"],
                         [681793758, 12818, 574190, 56749842, 191847521, 22774896])
        self.assertEqual(BENCH.config("device", "lua")["expected"],
                         [67087475, 9653762, 84582425, 815994937, 593473801, 81715629])
        self.assertEqual(BENCH.config("host", "ts")["expected"],
                         [877803200, 77230096, 39501453, 482536860, 36631989, 570035991])

    def test_complete_prefixed_device_log_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "device.log"
            path.write_text("booting\n" + "\n".join("[app] \x1b[32mDANGO_BENCH " + json.dumps(e) + "\x1b[0m" for e in events("lua")))
            kind, start, samples = BENCH.read_run(path, "lua")
            self.assertEqual(kind, "device")
            self.assertEqual(start["engine"], "lua")
            self.assertEqual(len(samples), 6)

    def test_partial_duplicate_and_misordered_runs_are_rejected(self):
        valid = events("lua")
        invalid = [valid[:-1], valid + valid, valid[:3] + valid[4:], valid[:3] + [valid[2]] + valid[3:]]
        for rows in invalid:
            with self.subTest(rows=len(rows)), self.assertRaises(ValueError):
                BENCH.validate(rows, "lua")

    def test_wrong_workload_and_corrupted_warmup_are_rejected(self):
        for index, key, value in ((0, "fingerprint", "0" * 64), (0, "units", [1] * 6),
                                  (0, "yield_every", 32), (0, "engine", "ts"),
                                  (1, "checksum", 123), (3, "checksum", 123),
                                  (3, "elapsed_ms", float("nan")), (3, "elapsed_ms", -1)):
            rows = copy.deepcopy(events("lua"))
            rows[index][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                BENCH.validate(rows, "lua")

    def test_host_timings_require_positive_vm_time_with_larger_wall_time(self):
        for vm_ns, wall_ns in ((0, 1), (20, 10), (True, 30)):
            rows = events("ts", True)
            rows[3].update(host_vm_ns=vm_ns, host_wall_ns=wall_ns)
            with self.assertRaises(ValueError):
                BENCH.validate(rows, "ts", host=True)
        with self.assertRaisesRegex(ValueError, "host timings"):
            BENCH.validate(events("ts", True), "ts", host=False)

    def test_ratios_use_medians_and_keep_raw_samples(self):
        lua_runs, ts_runs = [], []
        for i, (lua_ms, ts_ms) in enumerate(((10, 30), (20, 40), (900, 50))):
            for engine, ms, target in (("lua", lua_ms, lua_runs), ("ts", ts_ms, ts_runs)):
                item = run(engine, True, ms)
                item[1]["run_id"] += str(i)
                target.append(item)
        report = BENCH.compare_runs({"lua": lua_runs, "ts": ts_runs}, {"fixture": True})
        self.assertEqual(report["results"][0]["ts_over_lua"], 2)
        self.assertEqual(report["results"][0]["lua"]["median_ms"], 20)
        self.assertEqual(len(report["samples"]["ts"]), 18)
        self.assertFalse(report["preliminary"])
        self.assertFalse(report["device_executed"])

    def test_mixed_measurement_methods_and_unbalanced_rounds_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "cannot compare"):
            BENCH.compare_runs({"lua": [run("lua")], "ts": [run("ts", True)]}, {})
        second = run("lua")
        second[1]["run_id"] += "-second"
        with self.assertRaisesRegex(ValueError, "cannot compare"):
            BENCH.compare_runs({"lua": [run("lua"), second], "ts": [run("ts")]}, {})

    def test_duplicate_run_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate run id"):
            BENCH.compare_runs({"lua": [run("lua")] * 2, "ts": [run("ts")] * 2}, {})

    def test_millisecond_resolution_never_produces_fake_winner(self):
        report = BENCH.compare_runs({"lua": [run("lua", milliseconds=0)],
                                    "ts": [run("ts", milliseconds=0)]}, {})
        self.assertIsNone(report["results"][0]["ts_over_lua"])
        self.assertIn("below timer resolution", BENCH.markdown(report))


if __name__ == "__main__":
    unittest.main()
