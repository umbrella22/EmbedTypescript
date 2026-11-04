import { argument } from "@dango/sdk/system";
import { Screen, measure, rgb } from "@dango/sdk/display";
export const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));
export function numberArg(
  name: string,
  fallback: number,
  min: number = -Infinity,
  max: number = Infinity,
): number {
  const v = argument(name);
  return typeof v === "number" && Number.isFinite(v)
    ? clamp(v, min, max)
    : fallback;
}
export function boolArg(name: string, fallback: boolean): boolean {
  const v = argument(name);
  return typeof v === "boolean" ? v : fallback;
}
export function stringArg(name: string, fallback: string): string {
  const v = argument(name);
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
export function at<T>(values: T[], index: number): T {
  const v = values[index];
  if (v === undefined) throw new Error("invalid array index " + index);
  return v;
}
export function colorArg(name: string, fallback: number): number {
  const value = argument(name);
  if (
    typeof value === "string" &&
    value.startsWith("#") &&
    value.length === 7
  ) {
    const n = Number.parseInt(value.slice(1), 16);
    if (Number.isFinite(n)) return rgb(n);
  }
  return rgb(fallback);
}
export function centered(
  s: Screen,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  fontSize: number,
  color: number,
): void {
  const m = measure(text, { fontSize });
  s.text(
    Math.floor(x + (w - m.width) / 2),
    Math.floor(y + (h - m.height) / 2),
    text,
    { fontSize, color },
  );
}
export class Random {
  constructor(private state: number) {
    this.state = state >>> 0 || 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
  int(lo: number, hi: number): number {
    return Math.floor(this.next() * (hi - lo + 1)) + lo;
  }
}
