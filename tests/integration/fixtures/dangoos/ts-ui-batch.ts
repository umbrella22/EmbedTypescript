import * as ui from "@dango/sdk/ui";
import { sleep, print } from "@dango/sdk/system";

function check(ok: boolean): void {
  if (!ok) throw new Error("UI batch assertion");
}
export async function main(): Promise<number> {
  await ui.init();
  const screen = await ui.createScreen();
  await screen.load();
  let clicks = 0;
  const view: ui.BuiltView = await ui.build(
    screen,
    [
      {
        kind: "container",
        key: "root",
        options: { w: 80, h: 80, pad: 0 },
        children: [
          { kind: "label", key: "温度", options: { text: "温度 21°C" } },
          {
            kind: "button",
            key: "button",
            options: { y: 30, w: 60, h: 35 },
            on: [
              {
                event: "clicked",
                handler: async () => {
                  clicks++;
                  await ui.batch([
                    { widget: view.get("温度"), text: "clicked " + clicks },
                  ]);
                },
              },
            ],
          },
        ],
      },
    ],
    { publish: false },
  );
  await ui.batch(
    [
      { widget: view.get("温度"), text: "ready", pos: [2, 3] },
      { widget: view.get("button"), style: { bg_color: "#102030" } },
    ],
    { publish: false },
  );
  await ui.frameEnd();
  await sleep(1);
  check((await ui.processEvents()) === 1 && clicks === 1);
  let rejected = 0;
  try {
    await ui.build(screen, [
      {
        kind: "button",
        on: [
          {
            event: "clicked",
            handler: () => {
              clicks += 100;
            },
          },
        ],
      },
      { kind: "label", options: { bg_color: 0x1000000 } },
    ]);
  } catch {
    rejected++;
  }
  try {
    await ui.build(screen, [
      { kind: "label", key: "same" },
      { kind: "label", key: "same" },
    ]);
  } catch {
    rejected++;
  }
  const excessive: ui.BuildNode[] = [];
  for (let i = 0; i < 17; i++) excessive.push({ kind: "label" });
  try {
    await ui.build(screen, excessive);
  } catch {
    rejected++;
  }
  check(rejected === 3);
  for (let i = 0; i < 24; i++) {
    const temporary = await ui.build(screen, [
      {
        kind: "button",
        key: "temporary",
        options: { x: 60, y: 60, w: 10, h: 10 },
        on: [
          {
            event: "clicked",
            handler: () => {
              clicks += 100;
            },
          },
        ],
        children: [{ kind: "label", options: { text: "x" } }],
      },
    ]);
    const widget = temporary.get("temporary");
    await widget.delete();
    check(!(await widget.valid()));
    check((await ui.processEvents()) === 0);
  }
  await view.get("root").delete();
  check(!(await view.get("button").valid()));
  try {
    await ui.batch([{ widget: view.get("button"), text: "gone" }]);
  } catch {
    rejected++;
  }
  check(rejected === 4 && clicks === 1);
  await ui.deinit();
  print("ui-batch:ok");
  return 42;
}
