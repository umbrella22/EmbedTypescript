import { Button, Magnetometer, LedStrip, Imu } from "@dango/sdk/hardware";
import { sleep, print } from "@dango/sdk/system";
function check(ok: boolean): void {
  if (!ok) throw new Error("hardware edge assertion");
}
function rejects(fn: () => void): void {
  let failed = false;
  try {
    fn();
  } catch {
    failed = true;
  }
  check(failed);
}
export async function main(): Promise<number> {
  const imu = new Imu();
  rejects(() => new Imu());
  imu.close();
  rejects(() => imu.read());
  new Imu().close();
  const mag = new Magnetometer();
  mag.calibrationReset();
  rejects(() => mag.calibrationFinish());
  for (let i = 1; i <= 16; i++) mag.calibrationAddSample([i, 2 * i, 3 * i]);
  const c = mag.calibrationFinish();
  check(
    c.calibrated &&
      c.sample_count === 16 &&
      !c.collecting &&
      c.hard_iron[0] === 8.5,
  );
  c.hard_iron[0] = 1000;
  check(mag.calibrationGet().hard_iron[0] === 8.5);
  mag.calibrationReset();
  for (let i = 1; i <= 16; i++) mag.calibrationAddSample([0, i, i]);
  rejects(() => mag.calibrationFinish());
  mag.close();
  const led = new LedStrip(),
    button = new Button(7);
  let down = 0,
    up = 0,
    click = 0;
  button.on("press_down", () => {
    down++;
    throw new Error("expected callback failure");
  });
  button.on("press_up", () => {
    up++;
  });
  button.on("single_click", () => {
    click++;
  });
  await sleep(1);
  let failed = false;
  try {
    await Button.dispatch();
  } catch {
    failed = true;
  }
  check(failed && down === 1);
  await Button.dispatch();
  check(down === 1);
  await sleep(1);
  await Button.dispatch();
  check(up === 1 && click === 0);
  await sleep(1);
  await Button.dispatch();
  check(click === 1);
  button.close();
  const overflow = new Button(7);
  await sleep(1);
  rejects(() => led.refresh());
  led.close();
  led.close();
  await sleep(1);
  failed = false;
  try {
    await Button.dispatch();
  } catch {
    failed = true;
  }
  check(failed);
  overflow.close();
  print("hardware-edge:ok");
  return 42;
}
