import { rpcReply, Json } from "./bridge.js";
import * as storage from "./storage.js";
import { args as appArgs } from "./system.js";
export interface Result {
  ok: boolean;
  message: string;
}
interface Reply {
  values?: Json[];
  binary?: boolean;
  error?: string;
}
function command(
  op: string,
  args: Json[] = [],
  bytes?: Uint8Array,
): Promise<{ value: Reply; bytes: Uint8Array }> {
  return rpcReply<Reply>("thread." + op, args, bytes);
}
async function result(
  op: string,
  args: Json[] = [],
  bytes?: Uint8Array,
): Promise<Result> {
  const r = (await command(op, args, bytes)).value;
  if (r.error) throw new Error(r.error);
  return {
    ok: r.values?.[0] === true,
    message:
      typeof r.values?.[1] === "string" ? r.values[1] : "invalid worker reply",
  };
}
export interface Options {
  name?: string;
  exclusive?: string;
  replace?: boolean;
  timeout_ms?: number;
}
export function args(): unknown {
  return appArgs();
}
export async function start(
  path: string,
  args: Json = null,
  options: Options = {},
): Promise<Result> {
  return result(
    "start",
    [path, args, { ...options }],
    await storage.read(path),
  );
}
export async function run(
  path: string,
  args: Json = null,
  options: Options = {},
): Promise<Result> {
  return result("run", [path, args, { ...options }], await storage.read(path));
}
export async function get(job: number | string): Promise<Result> {
  return result("get", [job]);
}
export async function list(
  status:
    | "all"
    | "queued"
    | "running"
    | "done"
    | "failed"
    | "timeout"
    | "stopped" = "all",
): Promise<Result> {
  return result("list", [status]);
}
export async function stop(job: number | string): Promise<Result> {
  return result("stop", [job]);
}
export async function createQueue(
  name: string,
  options: { depth?: number; item_size?: number } = {},
): Promise<Result> {
  return result("queue_create", [name, { ...options }]);
}
export async function send(
  name: string,
  bytes: Uint8Array,
  timeoutMs: number = 0,
): Promise<Result> {
  return result("queue_send", [name, timeoutMs], bytes);
}
export async function receive(
  name: string,
  timeoutMs: number = 0,
): Promise<{ data: Uint8Array | null; reason: string }> {
  const r = await command("queue_recv", [name, timeoutMs]);
  if (r.value.error) throw new Error(r.value.error);
  return {
    data: r.value.binary ? r.bytes : null,
    reason:
      typeof r.value.values?.[1] === "string" ? r.value.values[1] : "received",
  };
}
export async function deleteQueue(name: string): Promise<Result> {
  return result("queue_delete", [name]);
}
export async function createSemaphore(
  name: string,
  options: { max?: number; initial?: number } = {},
): Promise<Result> {
  return result("sem_create", [name, { ...options }]);
}
export async function take(
  name: string,
  timeoutMs: number = 0,
): Promise<Result> {
  return result("sem_take", [name, timeoutMs]);
}
export async function give(name: string): Promise<Result> {
  return result("sem_give", [name]);
}
export async function deleteSemaphore(name: string): Promise<Result> {
  return result("sem_delete", [name]);
}
export async function createLock(name: string): Promise<Result> {
  return result("lock_create", [name]);
}
export async function lock(
  name: string,
  timeoutMs: number = 0,
): Promise<Result> {
  return result("lock", [name, timeoutMs]);
}
export async function unlock(name: string): Promise<Result> {
  return result("unlock", [name]);
}
export async function deleteLock(name: string): Promise<Result> {
  return result("lock_delete", [name]);
}
