import * as system from "@dango/sdk/system";
import { call, request } from "dango:host";

const names = ["sleep", "generic", "microtask", "clock", "generic-clock"];

export async function main(): Promise<void> {
  const args = system.args();
  if (typeof args !== "object" || args === null || !("mode" in args) ||
      typeof args.mode !== "string" || !names.includes(args.mode)) {
    throw new Error("host benchmark mode required");
  }
  const mode = args.mode;
  const count = mode === "clock" || mode === "generic-clock" ? 64 : 256;
  const reports: string[] = [];
  for (let sample = -1; sample < 5; sample++) {
    let checksum = 0;
    let previous = 0;
    const started = system.nowMs();
    for (let i = 0; i < count; i++) {
      if (mode === "sleep") await system.sleep(0);
      else if (mode === "generic") await request("sleep", "[0]");
      else if (mode === "microtask") await Promise.resolve();
      else {
        const now = mode === "clock" ? system.nowMs() : call("now_ms", "[]");
        if (typeof now !== "number" || now < previous) throw new Error("monotonic clock");
        previous = now;
      }
      checksum++;
    }
    const elapsed = system.nowMs() - started;
    if (checksum !== count || elapsed < 0) throw new Error("host benchmark checksum");
    reports.push(JSON.stringify({ mode, sample, count, elapsed_ms: elapsed, checksum }));
    // Split synchronous clock samples at the normal production execution boundary.
    await system.sleep(0);
  }
  for (const report of reports) system.print("HOST_BENCH " + report);
  system.print("HOST_DONE");
}
