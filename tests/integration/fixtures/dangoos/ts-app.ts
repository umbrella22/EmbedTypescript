import * as ui from "@dango/sdk/ui";
import * as storage from "@dango/sdk/storage";
import * as system from "@dango/sdk/system";
import * as hardware from "@dango/sdk/hardware";

export async function main(): Promise<number> {
  const args = system.args();
  if (
    typeof args !== "object" ||
    args === null ||
    !("probe" in args) ||
    args.probe !== "yes"
  )
    throw new Error("args");
  const state = system.services();
  if (
    !state.audio?.available ||
    state.audio.volume !== 40 ||
    state.network?.ip?.[3] !== 9
  )
    throw new Error("services");
  const sample = hardware.snapshot();
  if (
    sample.accel[0] !== -123 ||
    sample.soc !== 0 ||
    sample.onboard.edges[1]?.pressed !== 1
  )
    throw new Error("hardware");
  const heap = system.heapInfo();
  if (heap.free_size !== 0 || heap.largest_free_block !== undefined)
    throw new Error("heap validity");
  system.setVolume(0);
  system.setMuted(true);
  hardware.haptic("happy");
  hardware.ledFrame([
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [0, 0, 0],
    [1, 2, 3],
    [255, 255, 255],
  ]);
  hardware.ledRelease();
  await storage.mkdir("子目录");
  await storage.writeText("子目录/团子.txt", "团子\0\n");
  if ((await storage.readText("子目录/团子.txt")) !== "团子\0\n")
    throw new Error("text round trip");
  const bytes = new Uint8Array([99, 0, 255, 88]);
  await storage.write("bytes", bytes.subarray(1, 3));
  await storage.write("empty", new Uint8Array(0));
  if ((await storage.read("empty")).length !== 0)
    throw new Error("empty bytes");
  const read = await storage.read("bytes");
  if (read.length !== 2 || read[0] !== 0 || read[1] !== 255)
    throw new Error("byte view");
  await storage.rename("bytes", "renamed");
  if (
    (await storage.stat("renamed")).size !== 2 ||
    (await storage.exists("absent"))
  )
    throw new Error("metadata");
  try {
    await storage.stat("absent");
    throw new Error("expected NOENT");
  } catch (error) {
    if (!system.isHostError(error) || error.code !== 2) throw error;
  }
  const entries = await storage.list("子目录");
  if (entries[0]?.name !== "团子.txt") throw new Error("list");
  await storage.remove("子目录/团子.txt");
  await storage.rmdir("子目录");
  await ui.init();
  const screen = await ui.createScreen();
  await screen.load();
  await screen.style({ bg_color: "#000000", bg_opa: 255, pad: 0 });
  const button = await ui.create("button", screen, {
    w: 80,
    h: 80,
    text: "Tap",
  });
  let clicked = 0;
  await button.on("clicked", async () => {
    clicked++;
    await screen.clean();
    await ui.create("container", screen, {
      w: 80,
      h: 80,
      bg_color: "#00ff00",
      bg_opa: 255,
      border_width: 0,
      radius: 0,
    });
    // The OS publishes clean/rebuild before a delay even inside a callback.
    await system.sleep(1);
    throw new Error("expected callback failure");
  });
  await ui.frameEnd();
  await system.sleep(1);
  if ((await ui.processEvents()) !== 1 || clicked !== 1)
    throw new Error("native callback");
  const canvas = await ui.create("canvas", screen, { w: 2, h: 1 });
  await canvas.rgb565(new Uint8Array([0, 248, 224, 7]));
  const px = await canvas.pixel(0, 0);
  if (px.r !== 255 || px.g !== 0) throw new Error("canvas RGB565");
  await ui.deinit();
  system.print("parity:ok");
  return 42;
}
