import * as brain from "@dango/sdk/brain";
let deadline = 0;
export function main(): void {
  deadline = brain.nowMs() + 3000;
}
export function onEvent(): void {
  brain.setExpression("Angry");
  if (brain.nowMs() >= deadline) throw new Error("probe:later fault");
  brain.respond(false);
}
