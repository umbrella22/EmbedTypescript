import { rpc, type Json } from "../bridge.js";

interface EventTarget {
  readonly id: number;
  valid(): Promise<boolean>;
}
interface Callback {
  obj: EventTarget;
  event: string;
  fn: () => void | Promise<void>;
}
export const callbacks = new Map<number, Callback>();
let nextCallback = 0;
export function callbackId(): number {
  return ++nextCallback;
}
export async function call(
  operation: string,
  args: Json[] = [],
  bytes?: Uint8Array,
): Promise<Json[]> {
  const value = await rpc<{ values: Json[]; retired: number[] }>(
    "ui." + operation,
    args,
    bytes,
  );
  for (const id of value.retired) callbacks.delete(id);
  return value.values;
}
