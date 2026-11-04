import * as thread from "@dango/sdk/thread";
import { sleep, print, delayUs, argument } from "@dango/sdk/system";
export async function main(): Promise<void> {
  const mode = argument("mode");
  if (mode === "fault") throw new Error("worker:expected fault");
  if (!(await thread.lock("l", 500).then((r) => r.ok)))
    throw new Error("worker lock");
  if (mode === "hold") {
    await thread.give("s");
    await sleep(60000);
    return;
  }
  if (
    !(await thread
      .send("q", new Uint8Array([0, 255, 42]), 500)
      .then((r) => r.ok))
  )
    throw new Error("worker send");
  await delayUs(500);
  await sleep(10);
  await thread.unlock("l");
  await thread.give("s");
  print("worker:ok");
}
