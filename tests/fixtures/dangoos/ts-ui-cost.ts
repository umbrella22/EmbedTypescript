import * as ui from "@dango/sdk/ui";
import { argument, print } from "@dango/sdk/system";

export async function main(): Promise<number> {
  const batched = argument("mode") === "batch";
  await ui.init();
  const screen = await ui.createScreen();
  await screen.style({ bg_color: "#101820", bg_opa: 255, pad: 0 });
  const labels: ui.Widget[] = [];
  if (batched) {
    const nodes: ui.BuildNode[] = [];
    for (let i = 0; i < 8; i++)
      nodes.push({
        kind: "button",
        options: {
          x: (i % 4) * 120,
          y: Math.floor(i / 4) * 100,
          w: 110,
          h: 90,
          pad: 4,
        },
        on: [{ event: "clicked", handler: () => {} }],
        children: [
          { kind: "label", key: "label-" + i, options: { text: "Item " + i } },
        ],
      });
    const view = await ui.build(screen, nodes, { publish: false });
    for (let i = 0; i < 8; i++) labels.push(view.get("label-" + i));
  } else {
    for (let i = 0; i < 8; i++) {
      const button = await ui.create("button", screen, {
        x: (i % 4) * 120,
        y: Math.floor(i / 4) * 100,
        w: 110,
        h: 90,
        pad: 4,
      });
      await button.on("clicked", () => {});
      labels.push(await ui.create("label", button, { text: "Item " + i }));
    }
  }
  await screen.load();
  await ui.frameEnd();
  print("ui-cost:mounted");
  for (let step = 0; step < 32; step++) {
    if (batched) {
      const updates: ui.Update[] = [];
      for (const widget of labels)
        updates.push({ widget, text: "Value " + step });
      await ui.batch(updates);
    } else {
      for (const widget of labels) await widget.text("Value " + step);
      await ui.frameEnd();
    }
  }
  print("ui-cost:updated");
  await ui.deinit();
  return 42;
}
