import * as system from "@dango/sdk/system";
import * as display from "@dango/sdk/display";
import { callVoid } from "dango:host";

export async function main(): Promise<void> {
  const mode = system.argument("mode");
  if (mode !== "sdk" && mode !== "generic") throw new Error("draw mode required");
  const screen = display.open();
  const info = screen.info();
  const reports: string[] = [];
  for (let sample = -1; sample < 5; sample++) {
    screen.begin(0xff000000);
    let checksum = 0;
    const started = system.nowMs();
    for (let i = 0; i < 256; i++) {
      const x = (i * 7) % (info.width - 8), y = (i * 11) % (info.height - 8);
      if (mode === "sdk") screen.fillRect(x, y, 6, 6, 0xff12ab34);
      else callVoid("display.draw", JSON.stringify([0, [x, y, 6, 6, 0, 0], 0xff12ab34, 0, 0]));
      checksum += i;
      if ((i + 1) % 8 === 0) await system.sleep(0);
    }
    const elapsed = system.nowMs() - started;
    if (checksum !== 32640) throw new Error("draw checksum");
    reports.push(JSON.stringify({mode, sample, count: 256, elapsed_ms: elapsed, checksum}));
    await screen.present();
  }
  screen.close();
  for (const report of reports) system.print("DRAW_BENCH " + report);
  system.print("DRAW_DONE");
}
