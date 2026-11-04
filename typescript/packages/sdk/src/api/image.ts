import { binary, sync, syncVoid, rpc, rpcVoid } from "./bridge.js";
export type Format =
  | "RGBP"
  | "RGBR"
  | "RGB3"
  | "BGR3"
  | "GREY"
  | "JPEG"
  | "MJPG";
export const RGB565: Format = "RGBP",
  RGB565_BE: Format = "RGBR",
  RGB888: Format = "RGB3",
  BGR888: Format = "BGR3",
  GRAY8: Format = "GREY",
  JPEG: Format = "JPEG",
  MJPEG: Format = "MJPG";
export interface Info {
  width: number;
  height: number;
  format: Format;
  bytes: number;
}
export class Frame {
  private closed = false;
  constructor(private readonly handle: number) {}
  /** SDK-internal native ID. All host operations validate its lifetime. */
  nativeId(): number {
    if (this.closed) throw new Error("closed image handle");
    return this.handle;
  }
  info(): Info {
    return sync("image.info", [this.nativeId()]);
  }
  bytes(): Uint8Array {
    return binary("image.bytes", [this.nativeId()]);
  }
  convert(format: Format): Frame {
    return new Frame(sync("image.convert", [this.nativeId(), format]));
  }
  resize(
    width: number,
    height: number,
    options: { format?: Format; filter?: "nearest" | "bilinear" } = {},
  ): Frame {
    return new Frame(
      sync("image.resize", [
        this.nativeId(),
        options.format ?? (this.info().format === "GREY" ? GRAY8 : RGB565),
        width,
        height,
        options.filter === "bilinear",
      ]),
    );
  }
  async saveFile(
    path: string,
    options: { quality?: number } = {},
  ): Promise<void> {
    if (
      !path.toLowerCase().endsWith(".jpg") &&
      !path.toLowerCase().endsWith(".jpeg")
    )
      throw new Error("image output must be .jpg or .jpeg");
    await rpcVoid("image.save_file", [
      this.nativeId(),
      path,
      options.quality ?? 90,
    ]);
  }
  close(): void {
    if (this.closed) return;
    syncVoid("image.close", [this.handle]);
    this.closed = true;
  }
}
export function decode(bytes: Uint8Array): Frame {
  return new Frame(sync("image.decode", [], bytes));
}
export function raw(
  width: number,
  height: number,
  format: Format,
  bytes: Uint8Array,
): Frame {
  return new Frame(sync("image.raw", [width, height, format], bytes));
}
export async function loadFile(path: string): Promise<Frame> {
  return new Frame(await rpc<number>("image.load_file", [path]));
}
