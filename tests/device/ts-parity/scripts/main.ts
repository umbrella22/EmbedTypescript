import * as system from "@dango/sdk/system";
import * as hardware from "@dango/sdk/hardware";
import * as display from "@dango/sdk/display";
import * as image from "@dango/sdk/image";
import * as storage from "@dango/sdk/storage";
import * as thread from "@dango/sdk/thread";
import * as ui from "@dango/sdk/ui";
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error("probe:" + what);
}
export async function main(): Promise<number> {
  system.print("TS_PROBE_START " + JSON.stringify(system.runtimeLimits()));
  system.print(
    "TS_PROBE_HEAP_BEFORE " +
      JSON.stringify(system.heapInfo(system.caps.SPIRAM)),
  );
  system.print("TS_PROBE_SERVICES " + JSON.stringify(system.services()));
  system.print(
    "TS_PROBE_CAPABILITIES " + JSON.stringify(system.capabilities()),
  );
  system.print("TS_PROBE_DATE " + system.date());
  const audio = system.audioStatus();
  if (audio?.controls_available) {
    try {
      system.setVolume(37);
      system.setMuted(true);
      await system.sleep(100);
      check(system.audioStatus()?.volume === 37, "audio volume");
      check(system.audioStatus()?.muted === true, "audio mute");
      system.print("TS_PROBE_AUDIO_CONTROLS_OK");
    } finally {
      system.setVolume(audio.volume);
      system.setMuted(audio.muted);
    }
  }
  await storage.mkdir("probe");
  const bytes = new Uint8Array([0, 255, 42, 0]);
  await storage.write("probe/bytes", bytes);
  check((await storage.read("probe/bytes"))[1] === 255, "storage bytes");
  await storage.writeText("probe/text", "团子 TS\u0000运行时");
  await storage.rename("probe/text", "probe/renamed");
  check(
    (await storage.readText("probe/renamed")) === "团子 TS\u0000运行时",
    "storage text",
  );
  await storage.remove("probe/bytes");
  await storage.remove("probe/renamed");
  const font = await display.loadFont("/data/apps/ts-parity/assets/one.dfn");
  try {
    check(display.measure("A", { font }).height === 8, "DFN1 font");
  } finally {
    font.close();
  }
  const png = await image.loadFile("/data/apps/ts-parity/assets/alpha.png");
  try {
    check(png.bytes()[0] === 128 && png.bytes()[4] === 255, "PNG alpha");
  } finally {
    png.close();
  }
  const h = hardware.snapshot();
  system.print("TS_PROBE_HARDWARE " + JSON.stringify(h));
  let onboardButton: hardware.Button | undefined;
  if ((h.available & 1) !== 0) {
    const imu = new hardware.Imu();
    try {
      system.print("TS_PROBE_IMU " + JSON.stringify(imu.read()));
    } finally {
      imu.close();
    }
  }
  if ((h.available & 2) !== 0) {
    const mag = new hardware.Magnetometer();
    try {
      system.print("TS_PROBE_MAG " + JSON.stringify(mag.read()));
      mag.calibrationReset();
      for (let i = 0; i < 16; i++) mag.calibrationAddSample([i, i * 2, i * 3]);
      check(mag.calibrationFinish().calibrated, "calibration");
    } finally {
      mag.close();
    }
  }
  if ((h.available & 4) !== 0) {
    const fuel = new hardware.FuelGauge();
    try {
      system.print("TS_PROBE_FUEL " + JSON.stringify(fuel.read()));
    } finally {
      fuel.close();
    }
  }
  if (h.onboard.ready !== 0) {
    onboardButton = new hardware.Button(7);
    system.print("TS_PROBE_BUTTON level=" + onboardButton.level());
    const events: hardware.ButtonEvent[] = [
      "press_down",
      "press_up",
      "single_click",
    ];
    for (const event of events)
      onboardButton.on(event, () => {
        system.print("TS_PROBE_BUTTON_EVENT " + event);
      });
  }
  if ((h.available & 16) !== 0) {
    const leds = new hardware.LedStrip();
    try {
      leds.setPixelHsv(0, 120, 255, 64);
      leds.refresh();
      await system.sleep(100);
      leds.clear();
    } finally {
      leds.close();
    }
    system.print("TS_PROBE_LED_SUBMITTED");
  } else system.print("TS_PROBE_LED_UNAVAILABLE");
  if ((h.available & 32) !== 0) {
    const buzz = new hardware.Haptic();
    buzz.play("happy");
    await system.sleep(120);
    buzz.close();
  }
  check(
    (await thread.createQueue("q", { depth: 2, item_size: 3 })).ok,
    "queue create",
  );
  check((await thread.createSemaphore("s")).ok, "sem create");
  check((await thread.createLock("l")).ok, "lock create");
  check(
    (
      await thread.start(
        "/data/apps/ts-parity/scripts/worker.etb",
        { answer: 42 },
        { name: "probe" },
      )
    ).ok,
    "worker start",
  );
  const r = await thread.receive("q", 2000);
  check(r.data?.[1] === 255 && r.data?.[2] === 42, "worker bytes");
  check((await thread.take("s", 2000)).ok, "worker semaphore");
  check((await thread.lock("l", 1000)).ok, "parent lock");
  await thread.unlock("l");
  system.print("TS_PROBE_WORKER " + (await thread.get("probe")).message);
  const workerPath = "/data/apps/ts-parity/scripts/worker.etb";
  check(
    (
      await thread.start(
        workerPath,
        { mode: "hold" },
        { name: "timed", timeout_ms: 250 },
      )
    ).ok,
    "timed worker",
  );
  check((await thread.take("s", 2000)).ok, "timed worker ready");
  check(!(await thread.unlock("l")).ok, "lock ownership");
  check((await thread.lock("l", 2000)).ok, "timeout releases lock");
  await thread.unlock("l");
  check(
    (await thread.get("timed")).message.includes("status=timeout"),
    "worker timeout",
  );
  check(
    (
      await thread.start(
        workerPath,
        { mode: "hold" },
        { name: "stopped", timeout_ms: 0 },
      )
    ).ok,
    "stoppable worker",
  );
  check((await thread.take("s", 2000)).ok, "stoppable worker ready");
  check((await thread.stop("stopped")).ok, "worker stop");
  check((await thread.lock("l", 0)).ok, "stop releases lock");
  await thread.unlock("l");
  check(
    (
      await thread.run(workerPath, { mode: "fault" }, { name: "fault" })
    ).message.includes("worker:expected fault"),
    "worker fault isolation",
  );
  system.print("TS_PROBE_WORKER_TIMEOUT_STOP_FAULT_OK");
  await thread.deleteQueue("q");
  await thread.deleteSemaphore("s");
  await thread.deleteLock("l");
  await system.sleep(20);
  const pixels = new Uint8Array(32 * 32 * 3);
  for (let i = 0; i < 32 * 32; i++) {
    pixels[i * 3] = (i % 32) * 8;
    pixels[i * 3 + 1] = Math.floor(i / 32) * 8;
    pixels[i * 3 + 2] = 100;
  }
  const raw = image.raw(32, 32, image.RGB888, pixels);
  try {
    await raw.saveFile("probe/frame.jpg", { quality: 85 });
  } finally {
    raw.close();
  }
  const frame = await image.loadFile("probe/frame.jpg");
  try {
    check(frame.info().width === 32, "jpeg load");
    const resized = frame.resize(64, 64, { filter: "bilinear" });
    try {
      const s = display.open({ framebufferCount: 2 });
      try {
        s.begin(display.rgb(0x10202b));
        s.fillRoundRect(16, 16, 448, 448, 20, display.rgb(0x193747));
        s.text(46, 52, "DANGO TS 7", {
          fontSize: 40,
          color: display.rgb(0xffffff),
        });
        s.text(46, 110, "FRAMEBUFFER / JPEG", {
          fontSize: 20,
          color: display.rgb(0x9ae4d5),
        });
        s.image(resized, 80, 170, { mode: "stretch", width: 320, height: 240 });
        s.line(40, 430, 440, 430, display.rgb(0xf7bc6d));
        await s.present();
        system.print("TS_PROBE_FRAME_READY");
        await system.sleep(4000);
        s.begin();
        check(!(await s.present()), "clean frame");
      } finally {
        s.close();
      }
    } finally {
      resized.close();
    }
  } finally {
    frame.close();
  }
  await storage.remove("probe/frame.jpg");
  await storage.rmdir("probe");
  await ui.init();
  let clicked = 0;
  try {
    const screen = await ui.createScreen();
    await screen.style({ bg_color: "#10202b" });
    await ui.create("label", screen, {
      text: "TS native LVGL",
      align: "top_mid",
      y: 70,
      text_color: "#ffffff",
    });
    const button = await ui.create("button", screen, {
        text: "Tap TS probe",
        align: "center",
        w: 260,
        h: 90,
      }),
      label = await ui.create("label", screen, {
        text: "waiting",
        align: "bottom_mid",
        y: -70,
        text_color: "#9ae4d5",
      });
    await button.on("clicked", async () => {
      clicked++;
      await label.text("clicked " + clicked);
      system.print("TS_PROBE_UI_CLICK " + clicked);
    });
    await screen.load();
    await ui.frameEnd();
    system.print("TS_PROBE_UI_READY");
    const until = system.nowMs() + 60000;
    while (system.nowMs() < until) {
      await hardware.Button.dispatch();
      await ui.processEvents(50);
    }
  } finally {
    onboardButton?.close();
    await ui.deinit();
  }
  system.print(
    "TS_PROBE_DONE clicks=" +
      clicked +
      " heap=" +
      JSON.stringify(system.heapInfo(system.caps.SPIRAM)),
  );
  return 42;
}
