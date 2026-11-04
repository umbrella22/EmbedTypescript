import * as brain from "@dango/sdk/brain";
import { create } from "@dango/sdk/default-brain";
let app: ReturnType<typeof create> | undefined;
export function main(): void {
  app = create(brain.nowMs());
}
export function onEvent(): void {
  if (!app) throw new Error("brain not initialized");
  const c = brain.input();
  if (c.op === "tick" && typeof c.input === "number") {
    app.tick(c.input);
    brain.respond();
  } else if (c.op === "event" && typeof c.input === "object") {
    brain.respond(app.on_event(c.input) ?? null);
  } else throw new Error("unknown brain command");
}
