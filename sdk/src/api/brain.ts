/** Restricted resident callbacks; this module grants no foreground services. */
import { sync, Json } from "./bridge.js";
export interface SensorKind {
  type: string;
  args?: Json[];
  ax_mg?: number;
  ay_mg?: number;
  az_mg?: number;
  gx_dps?: number;
  gy_dps?: number;
  gz_dps?: number;
  confidence?: number;
}
export interface Event {
  type: string;
  at_ms: number;
  source?: string;
  kind?: string | SensorKind;
  x?: number;
  y?: number;
  pressed?: boolean;
}
export interface Command {
  op: string;
  input: number | Event;
}
export function input(): Command {
  return sync("brain.input");
}
export function nowMs(): number {
  return sync("now_ms");
}
export function respond(value: Json = null): void {
  sync("brain.respond", [value]);
}
export function setExpression(name: string): void {
  sync("brain.expression", [name]);
}
export function play(pose: string, durationMs: number): void {
  sync("brain.play", [pose, durationMs]);
}
export function visual(
  look: number,
  pulse: number,
  pet: number,
  lean: number,
): void {
  sync("brain.visual", [look, pulse, pet, lean]);
}
export function haptic(preset: string): void {
  sync("brain.haptic", [preset]);
}
export function command(
  value: "Hub" | "StopActivity" | "StartListening",
): void {
  sync("brain.command", [value]);
}
export function led(index: number, r: number, g: number, b: number): void {
  sync("brain.led", [index, r, g, b]);
}
export function clearLeds(): void {
  sync("brain.led_clear");
}
