#!/usr/bin/env python3
"""Physical TS brain transaction/persistence/fallback check; restores bundled brain.

Run only on a TS device with the bundled default selected. This replaces the
resident behavior temporarily and reboots once; no ROM flashing or NAND format.
Redirect stdout to a new evidence log. Build fixtures with build.py first.
"""
import argparse
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
api = None


def collect(dev, seconds):
    for line in dev.lines(time.monotonic() + seconds):
        print(line, flush=True)


def wait_ready(dev):
    # USB comes up before storage and the persisted brain selection. The VM
    # self-test only runs after the UI has resolved that selection and apps.
    deadline = time.monotonic() + 60
    while True:
        health = dev.command("ota-status")
        print(health, flush=True)
        fields = api.response_fields(health)
        if all(fields.get(key) == "1" for key in ("sys", "data", "frame", "vm")):
            return
        if time.monotonic() >= deadline:
            raise AssertionError("device boot did not become ready")
        collect(dev, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("--dango-root", type=Path, required=True, help="OS checkout providing scripts/device/console.py")
    parser.add_argument("--port", default="/dev/cu.usbmodemmosaico_s31_r11")
    args = parser.parse_args()
    global api
    sys.path.insert(0, str(args.dango_root.resolve() / "scripts/device"))
    import console as api
    dev = api.Device(args.port, True)
    wait_ready(dev)
    original = dev.command("brain-status")
    print(original, flush=True)
    if "active=ts source=default" not in original:
        dev.ser.close()
        raise SystemExit("requires active TS bundled default; existing selection preserved")
    try:
        print(dev.command("stop"), flush=True)
        api.push_brain(dev, api.read_brain(args.fixtures / "happy.etb"))
        happy = dev.command("brain-status")
        print(happy, flush=True)
        assert "active=ts source=custom" in happy and "error=0" in happy
        for name in ("bad-init", "bad-first"):
            try:
                api.push_brain(dev, api.read_brain(args.fixtures / (name + ".etb")))
            except SystemExit as error:
                print("EXPECTED_REJECTION", name, error, flush=True)
            else:
                raise AssertionError("bad candidate committed: " + name)
            after = dev.command("brain-status")
            print(after, flush=True)
            assert after == happy, (name, happy, after)
        try:
            dev.command("reboot", timeout=3)
        except (OSError, api.serial.SerialException, SystemExit):
            pass
        dev.ser.close()
        deadline = time.monotonic() + 60
        while True:
            try:
                dev = api.Device(args.port, True)
                dev.command("hello", timeout=5)
                break
            except (OSError, api.serial.SerialException, SystemExit):
                dev.ser.close()
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.2)
        wait_ready(dev)
        persisted = dev.command("brain-status")
        print("PERSISTED", persisted, flush=True)
        assert persisted == happy
        api.push_brain(dev, api.read_brain(args.fixtures / "later-fault.etb"))
        collect(dev, 6)
        fallen = dev.command("brain-status")
        print(fallen, flush=True)
        assert "active=native source=custom" in fallen and "error=1" in fallen
    finally:
        try:
            wait_ready(dev)
            print(dev.command("brain-default", timeout=30), flush=True)
            restored = dev.command("brain-status")
            print("RESTORED", restored, flush=True)
            assert restored == original
        finally:
            dev.ser.close()
    print("TS_BRAIN_DEVICE_PASS", flush=True)


if __name__ == "__main__":
    main()
