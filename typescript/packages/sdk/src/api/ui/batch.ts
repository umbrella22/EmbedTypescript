import { type Json } from "../bridge.js";
import {
  Widget,
  type Align,
  type Event,
  type Flag,
  type Flex,
  type Options,
  type Scroll,
  type Style,
  type WidgetKind,
} from "../ui.js";
import { callbacks, call, callbackId } from "./transport.js";

// Mirrors the public app-host::ui batch contract; native validation is authoritative.
const MAX_COMMANDS = 64;
const MAX_OBJECTS = 16;
export interface BatchOptions {
  /** Publish when the request completes. False retains the existing redraw barrier. */
  publish?: boolean;
}
export interface Binding {
  event: Event;
  handler: () => void | Promise<void>;
}
export type BuildOptions = Omit<Options, "src" | "color_format">;
export interface FooterButton {
  key?: string;
  text: string;
  style?: Style;
  on?: Binding[];
}
export interface BuildNode {
  kind: Exclude<WidgetKind, "canvas">;
  key?: string;
  options?: BuildOptions;
  flex?: Flex;
  scroll?: Scroll;
  flags?: { flag: Flag; enabled: boolean }[];
  on?: Binding[];
  children?: BuildNode[];
  footer?: FooterButton[];
}
export interface Update {
  widget: Widget;
  style?: Style;
  size?: [number, number];
  pos?: [number, number];
  align?: { value: Align; x?: number; y?: number };
  text?: string;
  flex?: Flex;
  scroll?: Scroll;
  flags?: { flag: Flag; enabled: boolean }[];
}
export class BuiltView {
  constructor(private readonly named: Map<string, Widget>) {}
  get(key: string): Widget {
    const widget = this.named.get(key);
    if (widget === undefined) throw new Error("unknown UI build key: " + key);
    return widget;
  }
}

class Commands {
  readonly values: Json[] = [];
  push(operation: string, args: Json[]): void {
    if (this.values.length >= MAX_COMMANDS)
      throw new Error("UI batch command limit exceeded");
    this.values.push([operation, args]);
  }
  async submit(options: BatchOptions): Promise<Json[]> {
    return call(options.publish === false ? "batch" : "batch_commit", [
      this.values,
    ]);
  }
}

/** Create a bounded tree in one request. Keys are local names, never native IDs. */
export async function build(
  parent: Widget,
  nodes: BuildNode[],
  options: BatchOptions = {},
): Promise<BuiltView> {
  const commands = new Commands();
  const names = new Map<string, number>();
  const pending: { local: number; callback: number; binding: Binding }[] = [];
  let objects = 0;
  function created(key?: string): number {
    if (objects >= MAX_OBJECTS)
      throw new Error("UI batch creation limit exceeded");
    const local = objects++;
    if (key !== undefined) {
      if (names.has(key)) throw new Error("duplicate UI build key: " + key);
      names.set(key, local);
    }
    return local;
  }
  function bind(local: number, bindings: Binding[] = []): void {
    for (const binding of bindings) {
      const callback = callbackId();
      commands.push("on", [{ local }, binding.event, callback]);
      pending.push({ local, callback, binding });
    }
  }
  function append(parent: Json, nodes: BuildNode[]): void {
    for (const node of nodes) {
      const local = created(node.key);
      commands.push("create", [
        node.kind,
        parent,
        (node.options ?? {}) as Json,
      ]);
      const target = { local };
      if (node.flex !== undefined)
        commands.push("set_flex", [target, node.flex as Json]);
      if (node.scroll !== undefined)
        commands.push("set_scroll", [target, node.scroll as Json]);
      for (const flag of node.flags ?? [])
        commands.push(flag.enabled ? "add_flag" : "clear_flag", [
          target,
          flag.flag,
        ]);
      bind(local, node.on);
      append(target, node.children ?? []);
      if (node.footer !== undefined) {
        if (node.kind !== "msgbox")
          throw new Error("footer buttons require a msgbox");
        for (const button of node.footer) {
          const child = created(button.key);
          commands.push("add_footer_button", [target, button.text]);
          if (button.style !== undefined)
            commands.push("set_style", [
              { local: child },
              button.style as Json,
            ]);
          bind(child, button.on);
        }
      }
    }
  }
  append(parent.id, nodes);
  const values = await commands.submit(options);
  if (values.length !== objects)
    throw new Error("invalid UI batch handle count");
  const widgets = values.map((id) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      throw new Error("invalid UI batch handle");
    return new Widget(id);
  });
  const named = new Map<string, Widget>();
  for (const [key, local] of names) named.set(key, widgets[local]!);
  for (const value of pending)
    callbacks.set(value.callback, {
      obj: widgets[value.local]!,
      event: value.binding.event,
      fn: value.binding.handler,
    });
  return new BuiltView(named);
}

/** Apply ordered scalar updates in one request; existing values do not roll back on error. */
export async function batch(
  updates: Update[],
  options: BatchOptions = {},
): Promise<void> {
  const commands = new Commands();
  for (const value of updates) {
    const id = value.widget.id;
    if (value.style !== undefined)
      commands.push("set_style", [id, value.style as Json]);
    if (value.size !== undefined)
      commands.push("set_size", [id, value.size[0], value.size[1]]);
    if (value.pos !== undefined)
      commands.push("set_pos", [id, value.pos[0], value.pos[1]]);
    if (value.align !== undefined)
      commands.push("align", [
        id,
        value.align.value,
        value.align.x ?? 0,
        value.align.y ?? 0,
      ]);
    if (value.text !== undefined) commands.push("set_text", [id, value.text]);
    if (value.flex !== undefined)
      commands.push("set_flex", [id, value.flex as Json]);
    if (value.scroll !== undefined)
      commands.push("set_scroll", [id, value.scroll as Json]);
    for (const flag of value.flags ?? [])
      commands.push(flag.enabled ? "add_flag" : "clear_flag", [id, flag.flag]);
  }
  await commands.submit(options);
}
