import * as brain from "@dango/sdk/brain";
export function main(): void {}
export function onEvent(): void {
  brain.setExpression("Happy");
  brain.respond(false);
}
