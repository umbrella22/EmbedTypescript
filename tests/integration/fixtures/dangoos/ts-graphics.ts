import * as display from "@dango/sdk/display";
import * as image from "@dango/sdk/image";
import * as system from "@dango/sdk/system";
import * as schema from "@dango/sdk/schema";
import { Imu, FuelGauge, Magnetometer, LedStrip, Haptic } from "@dango/sdk/hardware";
import * as thread from "@dango/sdk/thread";
function check(value: boolean): void {
  if (!value) throw new Error("graphics parity assertion");
}
export async function main(): Promise<number> {
  const cfg = schema.parse(
    { count: 40, enabled: false },
    {
      count: schema.int({ default: 2, max: 10 }),
      enabled: schema.bool({ default: true }),
    },
  );
  check(cfg.count === 10 && !cfg.enabled);
  check(system.date("%Y-%m-%d") === "1970-01-01");
  check(system.runtimeLimits().memory_bytes === 2 * 1024 * 1024);
  const d = display.open({ framebufferCount: 2 });
  try {
    d.begin(display.rgb(0x000000));
    d.fillRect(0, 0, 4, 4, display.rgb(0xff0000));
    d.save();
    d.translate(4, 0);
    d.clip(0, 0, 2, 2);
    d.fillRect(0, 0, 4, 4, display.rgb(0x00ff00));
    d.restore();
    d.rect(0, 0, 8, 8, display.rgb(0xffffff));
    d.line(0, 7, 7, 0, display.rgb(0x0000ff));
    d.circle(10, 10, 2, display.rgb(0xffff00));
    d.fillCircle(12, 4, 2, display.rgb(0x00ffff));
    d.arc(7, 7, 3, 0, 90, display.rgb(0x00ff00));
    d.fillRoundRect(0, 10, 4, 4, 1, display.rgb(0xff00ff));
    d.roundRect(8, 0, 6, 5, 1, display.rgb(0xffff00));
    d.fillTriangle(8, 8, 15, 8, 12, 15, display.rgb(0xffffff));
    const m = display.measure("TS", { fontSize: 8 });
    check(m.width > 0 && m.height === 8);
    d.text(0, 0, "TS", { fontSize: 8, color: display.rgb(0xffffff) });
    check(await d.present());
    d.begin();
    check(!(await d.present()));
    const f = image.raw(
      2,
      1,
      image.RGB888,
      new Uint8Array([255, 0, 0, 0, 255, 0]),
    );
    try {
      const rgb = f.convert(image.RGB565);
      try {
        const b = rgb.bytes();
        check(
          b.length === 4 &&
            b[0] === 0 &&
            b[1] === 248 &&
            b[2] === 224 &&
            b[3] === 7,
        );
        const resized = f.resize(4, 2, { filter: "bilinear" });
        try {
          check(resized.bytes().length === 16);
          d.begin();
          d.image(resized, 2, 2, { mode: "contain", width: 10, height: 10 });
          check(await d.present());
        } finally {
          resized.close();
        }
      } finally {
        rgb.close();
      }
      const jpeg = f.convert(image.JPEG);
      try {
        const decoded = jpeg.convert(image.RGB888);
        try {
          check(decoded.info().width === 2);
        } finally {
          decoded.close();
        }
      } finally {
        jpeg.close();
      }
    } finally {
      f.close();
    }
    d.close();
    d.close();
  } finally {
    d.close();
  }
  const i = new Imu();
  check(i.read().accel.z === 1000);
  i.close();
  i.close();
  const fuel = new FuelGauge();
  check(fuel.read().soc === 50);
  fuel.close();
  const mag = new Magnetometer();
  mag.calibrationClear();
  for (let n = 0; n < 16; n++) mag.calibrationAddSample();
  mag.close();
  const leds = new LedStrip();
  leds.setPixel(1, 255, 0, 0);
  leds.refresh();
  leds.close();
  leds.close();
  const h = new Haptic();
  h.play("happy");
  h.close();
  const q = await thread.createQueue("q");
  check(q.ok);
  check((await thread.send("q", new Uint8Array([0, 255, 0]))).ok);
  const r = await thread.receive("q");
  check(r.data?.length === 3);
  check((await thread.deleteQueue("q")).ok);
  system.print("graphics-parity:ok");
  return 42;
}
