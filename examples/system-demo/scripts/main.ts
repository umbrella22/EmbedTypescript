import * as ui from "@dango/sdk/ui";
import * as storage from "@dango/sdk/storage";
import { services, isHostError, print } from "@dango/sdk/system";
import { snapshot } from "@dango/sdk/hardware";

export async function main(): Promise<void> {
  let launches = 0;
  try {
    launches = Number(await storage.readText("launches.txt"));
  } catch (error) {
    if (!isHostError(error) || error.code !== 2) throw error;
  }
  if (!Number.isFinite(launches)) launches = 0;
  launches++;
  await storage.writeText("launches.txt", String(launches));
  await ui.init();
  const screen = await ui.createScreen();
  await screen.style({ bg_color: "#131b27", bg_opa: 255, pad: 20 });
  let reads = 0;
  function statusText(): string {
    const data = services();
    const hardware = snapshot();
    reads++;
    return `启动 ${launches} 次 · 读取 ${reads} 次\n音频 ${data.audio?.state ?? "不可用"}\n传感器位图 ${hardware.available}`;
  }
  const view: ui.BuiltView = await ui.build(
    screen,
    [
      {
        kind: "label",
        options: {
          x: 12,
          y: 20,
          text: "TypeScript 7 · dangoOS",
          text_color: "#ffffff",
        },
      },
      {
        kind: "label",
        key: "status",
        options: {
          x: 12,
          y: 85,
          w: 400,
          text: statusText(),
          text_color: "#a6bdd5",
        },
      },
      {
        kind: "button",
        options: { x: 12, y: 170, w: 260, h: 58, text: "刷新服务快照" },
        on: [
          {
            event: "clicked",
            handler: () => view.get("status").text(statusText()),
          },
        ],
      },
    ],
    { publish: false },
  );
  await screen.load();
  await ui.frameEnd();
  print("TS system demo ready");
  await ui.run(20);
}
