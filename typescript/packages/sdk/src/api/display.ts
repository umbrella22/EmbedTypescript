import { sync, syncVoid, rpc, Json } from "./bridge.js";
import { Frame, Format } from "./image.js";
import { draw } from "dango:host";
export interface Point {
  id: number;
  x: number;
  y: number;
}
export interface Info {
  width: number;
  height: number;
  bpp: number;
  framebuffer_count: number;
}
export interface Stats {
  native_bytes: number;
  limit_bytes: number;
  fonts: number;
  images: number;
  publication_bytes: number;
  publication_allocations: number;
  publication_copied_bytes: number;
}
export interface TextOptions {
  font?: Font;
  fontSize?: number;
  color?: number;
}
export interface BitmapOptions {
  mode?: "raw" | "contain" | "cover" | "stretch" | "crop";
  width?: number;
  height?: number;
  sourceX?: number;
  sourceY?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  opacity?: number;
}
export function color(
  r: number,
  g: number,
  b: number,
  a: number = 255,
): number {
  for (const v of [r, g, b, a])
    if (!Number.isInteger(v) || v < 0 || v > 255)
      throw new Error("color channels must be 0..255");
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
}
export function rgb(hex: number, alpha: number = 255): number {
  return color((hex >>> 16) & 255, (hex >>> 8) & 255, hex & 255, alpha);
}
export class Font {
  private closed = false;
  constructor(private readonly handle: number) {}
  nativeId(): number {
    if (this.closed) throw new Error("closed font handle");
    return this.handle;
  }
  close(): void {
    if (this.closed) return;
    syncVoid("font.close", [this.handle]);
    this.closed = true;
  }
}
export async function loadFont(path: string): Promise<Font> {
  return new Font(await rpc<number>("font.load_file", [path]));
}
export function decodeFont(bytes: Uint8Array): Font {
  return new Font(sync("font.decode", [], bytes));
}
export function measure(
  text: string,
  options: TextOptions = {},
): { width: number; height: number } {
  return sync("display.measure", [
    text,
    options.fontSize ?? 16,
    options.font?.nativeId() ?? null,
  ]);
}
function bitmap(o: BitmapOptions): Json[] {
  return [
    ["raw", "contain", "cover", "stretch", "crop"].indexOf(o.mode ?? "raw"),
    o.width ?? 0,
    o.height ?? 0,
    o.sourceX ?? 0,
    o.sourceY ?? 0,
    o.sourceWidth ?? 0,
    o.sourceHeight ?? 0,
    o.opacity ?? 255,
  ];
}
export class Screen {
  private closed = false;
  private live(): void {
    if (this.closed) throw new Error("closed display handle");
  }
  info(): Info {
    this.live();
    return sync("display.info");
  }
  stats(): Stats {
    this.live();
    return sync("display.stats");
  }
  begin(clear?: number): void {
    this.live();
    syncVoid("display.begin", [clear ?? null]);
  }
  present(full: boolean = false): Promise<boolean> {
    this.live();
    return rpc<boolean>("display.present", [full]);
  }
  save(): void {
    this.live();
    syncVoid("display.save");
  }
  restore(): void {
    this.live();
    syncVoid("display.restore");
  }
  translate(x: number, y: number): void {
    this.live();
    syncVoid("display.translate", [x, y]);
  }
  clip(x: number, y: number, width: number, height: number): void {
    this.live();
    syncVoid("display.clip", [x, y, width, height]);
  }
  private draw(
    op: number,
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
    color: number,
    start: number = 0,
    end: number = 0,
  ): void {
    this.live();
    draw(op, x0, y0, x1, y1, x2, y2, color, start, end);
  }
  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    this.draw(0, x, y, w, h, 0, 0, color);
  }
  rect(x: number, y: number, w: number, h: number, color: number): void {
    this.draw(1, x, y, w, h, 0, 0, color);
  }
  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    this.draw(2, x0, y0, x1, y1, 0, 0, color);
  }
  fillCircle(x: number, y: number, r: number, color: number): void {
    this.draw(3, x, y, r, 0, 0, 0, color);
  }
  circle(x: number, y: number, r: number, color: number): void {
    this.draw(4, x, y, r, 0, 0, 0, color);
  }
  arc(
    x: number,
    y: number,
    r: number,
    start: number,
    end: number,
    color: number,
  ): void {
    this.draw(5, x, y, r, 0, 0, 0, color, start, end);
  }
  fillRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: number,
  ): void {
    this.draw(6, x, y, w, h, r, 0, color);
  }
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: number,
  ): void {
    this.draw(7, x, y, w, h, r, 0, color);
  }
  fillTriangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void {
    this.draw(8, x0, y0, x1, y1, x2, y2, color);
  }
  text(x: number, y: number, text: string, options: TextOptions = {}): void {
    this.live();
    syncVoid("display.text", [
      x,
      y,
      text,
      options.fontSize ?? 16,
      options.color ?? 0xffffffff,
      options.font?.nativeId() ?? null,
    ]);
  }
  blit(
    x: number,
    y: number,
    width: number,
    height: number,
    format: Format,
    bytes: Uint8Array,
    options: BitmapOptions = {},
  ): void {
    this.live();
    syncVoid("display.blit", [width, height, format, x, y, bitmap(options)], bytes);
  }
  image(frame: Frame, x: number, y: number, options: BitmapOptions = {}): void {
    this.live();
    syncVoid("display.image", [frame.nativeId(), x, y, bitmap(options)]);
  }
  touch(): Point[] {
    this.live();
    return sync("display.touch");
  }
  close(): void {
    if (this.closed) return;
    syncVoid("display.close");
    this.closed = true;
  }
}
export function open(options: { framebufferCount?: 1 | 2 } = {}): Screen {
  syncVoid("display.open", [options.framebufferCount ?? 1]);
  return new Screen();
}
