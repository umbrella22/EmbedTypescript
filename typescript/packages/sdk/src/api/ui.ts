import { type Json } from "./bridge.js";
import { sleep, log } from "./system.js";
import { callbacks, call, callbackId } from "./ui/transport.js";
export { build, batch, BuiltView } from "./ui/batch.js";
export type {
  BuildNode,
  BuildOptions,
  FooterButton,
  Binding,
  Update,
  BatchOptions,
} from "./ui/batch.js";
export type Align =
  | "default"
  | "top_left"
  | "top_mid"
  | "top_right"
  | "bottom_left"
  | "bottom_mid"
  | "bottom_right"
  | "left_mid"
  | "right_mid"
  | "center";
export type Flag = "CLICKABLE" | "PRESS_LOCK" | "SCROLLABLE" | "HIDDEN";
export type Color = number | string;
export interface Style {
  bg_color?: Color;
  text_color?: Color;
  border_color?: Color;
  bg_opa?: number;
  opa?: number;
  radius?: number;
  border_width?: number;
  pad?: number;
  pad_row?: number;
  pad_column?: number;
}
export interface Options extends Style {
  w?: number;
  h?: number;
  x?: number;
  y?: number;
  align?: Align;
  text?: string;
  src?: string;
  title?: string;
  color_format?: "rgb565";
}
export interface Flex {
  flow?: "row" | "column" | "row_wrap" | "column_wrap";
  main?: FlexAlign;
  cross?: FlexAlign;
  track?: FlexAlign;
}
export type FlexAlign =
  | "start"
  | "end"
  | "center"
  | "space_between"
  | "space_around"
  | "space_evenly";
export interface Scroll {
  dir?: "none" | "hor" | "ver" | "all";
  scrollbar?: "off" | "on" | "active" | "auto";
}
export type WidgetKind =
  | "object"
  | "container"
  | "label"
  | "button"
  | "canvas"
  | "image"
  | "msgbox";
export type Event =
  | "pressed"
  | "long_pressed"
  | "clicked"
  | "released"
  | "value_changed"
  | "ready"
  | "cancel"
  | "focused"
  | "defocused";
async function numberResult(operation: string, args: Json[]): Promise<number> {
  const value = (await call(operation, args))[0];
  if (typeof value !== "number") throw new Error("invalid UI number reply");
  return value;
}
export async function init(): Promise<void> {
  await call("init", [{}]);
}
export async function deinit(): Promise<void> {
  await call("deinit");
  callbacks.clear();
}
export async function createScreen(): Promise<Widget> {
  return new Widget(await numberResult("create", ["screen", 0, {}]));
}
export async function screen(): Promise<Widget> {
  return new Widget(await numberResult("screen", []));
}
export async function create(
  kind: WidgetKind,
  parent: Widget,
  options: Options = {},
): Promise<Widget> {
  return new Widget(
    await numberResult("create", [kind, parent.id, options as Json]),
  );
}
export class Widget {
  /** Runtime-local token. Native pointers never enter JavaScript. */
  constructor(readonly id: number) {}
  async setSize(w: number, h: number): Promise<void> {
    await call("set_size", [this.id, w, h]);
  }
  async setPos(x: number, y: number): Promise<void> {
    await call("set_pos", [this.id, x, y]);
  }
  async size(): Promise<[number, number]> {
    return (await call("get_size", [this.id])) as [number, number];
  }
  async pos(): Promise<[number, number]> {
    return (await call("get_pos", [this.id])) as [number, number];
  }
  async align(value: Align, x: number = 0, y: number = 0): Promise<void> {
    await call("align", [this.id, value, x, y]);
  }
  async valid(): Promise<boolean> {
    return (await call("is_valid", [this.id]))[0] === true;
  }
  async style(value: Style): Promise<void> {
    await call("set_style", [this.id, value as Json]);
  }
  async flex(value: Flex): Promise<void> {
    await call("set_flex", [this.id, value as Json]);
  }
  async scroll(value: Scroll): Promise<void> {
    await call("set_scroll", [this.id, value as Json]);
  }
  async text(value: string): Promise<void> {
    await call("set_text", [this.id, value]);
  }
  async load(): Promise<void> {
    await call("load", [this.id]);
  }
  async clean(): Promise<void> {
    await call("clean", [this.id]);
  }
  async delete(): Promise<void> {
    await call("delete", [this.id]);
  }
  async close(): Promise<void> {
    await call("close", [this.id]);
  }
  async closeAsync(): Promise<void> {
    await call("close_async", [this.id]);
  }
  async flag(value: Flag, enabled: boolean = true): Promise<void> {
    await call(enabled ? "add_flag" : "clear_flag", [this.id, value]);
  }
  async moveForeground(): Promise<void> {
    await call("move_foreground", [this.id]);
  }
  async fill(color: Color, opacity: number = 255): Promise<void> {
    await call("fill_bg", [this.id, color, opacity]);
  }
  async setPixel(
    x: number,
    y: number,
    color: Color,
    opacity: number = 255,
  ): Promise<void> {
    await call("set_px", [this.id, x, y, color, opacity]);
  }
  async pixel(
    x: number,
    y: number,
  ): Promise<{ r: number; g: number; b: number; a: number }> {
    return (await call("get_px", [this.id, x, y]))[0] as {
      r: number;
      g: number;
      b: number;
      a: number;
    };
  }
  async rgb565(bytes: Uint8Array, order: "le" | "be" = "le"): Promise<void> {
    await call("set_rgb565_data", [this.id, order], bytes);
  }
  async rawRgb565(
    width: number,
    height: number,
    bytes: Uint8Array,
    swapped: boolean = false,
  ): Promise<void> {
    await call("set_raw_rgb565", [this.id, width, height, { swapped }], bytes);
  }
  async pivot(x: number, y: number): Promise<void> {
    await call("set_pivot", [this.id, x, y]);
  }
  async rotation(tenths: number): Promise<void> {
    await call("set_rotation", [this.id, tenths]);
  }
  async footerButton(text: string): Promise<Widget> {
    return new Widget(await numberResult("add_footer_button", [this.id, text]));
  }
  async on(event: Event, fn: () => void | Promise<void>): Promise<number> {
    const id = callbackId();
    await call("on", [this.id, event, id]);
    callbacks.set(id, { obj: this, event, fn });
    return id;
  }
  async off(selector?: number | Event): Promise<number> {
    const count = await numberResult("off", [this.id, selector ?? null]);
    for (const [id, c] of callbacks)
      if (
        c.obj.id === this.id &&
        (selector === undefined || selector === id || selector === c.event)
      )
        callbacks.delete(id);
    return count;
  }
}
export async function frameEnd(): Promise<void> {
  await call("frame_end");
}
export async function processEvents(timeoutMs: number = 0): Promise<number> {
  const ids = await call("events");
  let count = 0;
  try {
    for (const id of ids) {
      if (typeof id !== "number") continue;
      const callback = callbacks.get(id);
      if (callback && (await callback.obj.valid())) {
        try {
          await callback.fn();
        } catch (error) {
          log(
            "LVGL callback failed: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
        count++;
      }
    }
  } finally {
    await frameEnd();
  }
  if (timeoutMs > 0) await sleep(timeoutMs);
  return count;
}
export async function run(periodMs: number = 20): Promise<void> {
  while (true) await processEvents(periodMs);
}
