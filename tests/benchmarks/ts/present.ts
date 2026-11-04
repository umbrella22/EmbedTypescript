import * as display from "@dango/sdk/display";
import * as system from "@dango/sdk/system";

export async function main(): Promise<void> {
  const screen = display.open();
  const reports: string[] = [];
  const info = screen.info();
  for (let sample = -1; sample < 5; sample++) {
    screen.begin(0xff000000);
    await screen.present();
    let checksum = 0;
    const started = system.nowMs();
    for (let frame = 0; frame < 32; frame++) {
      screen.begin();
      screen.fillRect((frame * 7) % (info.width - 8), (frame * 11) % (info.height - 8), 6, 6, 0xff12ab34);
      if (!(await screen.present())) throw new Error("dirty frame lost");
      checksum += frame;
    }
    const elapsed = system.nowMs() - started;
    if (checksum !== 496) throw new Error("frame checksum");
    reports.push(JSON.stringify({sample, count: 32, elapsed_ms: elapsed, checksum}));
    screen.begin();
    if (await screen.present()) throw new Error("clean frame changed");
  }
  const stats = screen.stats();
  system.print("PRESENT_STATS " + JSON.stringify({native: stats.native_bytes,
    publication: stats.publication_bytes, allocations: stats.publication_allocations,
    copied: stats.publication_copied_bytes}));
  screen.close();
  for (const report of reports) system.print("PRESENT_BENCH " + report);
  system.print("PRESENT_DONE");
}
