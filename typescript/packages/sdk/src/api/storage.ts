import { sync, rpc, rpcVoid, rpcBinary } from "./bridge.js";
export interface Stat {
  type: "file" | "dir";
  size: number;
}
export interface Entry extends Stat {
  name: string;
}
export function root(): string {
  return sync("storage_root");
}
export function join(...parts: string[]): string {
  let result = "";
  for (const part of parts) {
    if (part.length === 0) continue;
    let start = part;
    while (result.length && start.startsWith("/")) start = start.slice(1);
    result += (result.length && !result.endsWith("/") ? "/" : "") + start;
    while (result.length > 1 && result.endsWith("/"))
      result = result.slice(0, -1);
  }
  return result;
}
export function exists(path: string): Promise<boolean> {
  return rpc<boolean>("storage.exists", [path]);
}
export function stat(path: string): Promise<Stat> {
  return rpc<Stat>("storage.stat", [path]);
}
export function mkdir(path: string): Promise<void> {
  return rpcVoid("storage.mkdir", [path]);
}
export function list(path: string = "."): Promise<Entry[]> {
  return rpc<Entry[]>("storage.list", [path]);
}
export function read(path: string): Promise<Uint8Array> {
  return rpcBinary("storage.read", [path]);
}
export function write(path: string, bytes: Uint8Array): Promise<void> {
  return rpcVoid("storage.write", [path], bytes);
}
export function readText(path: string): Promise<string> {
  return rpc<string>("storage.read_text", [path]);
}
export function writeText(path: string, text: string): Promise<void> {
  return rpcVoid("storage.write_text", [path, text]);
}
export function remove(path: string): Promise<void> {
  return rpcVoid("storage.remove", [path]);
}
export function rmdir(path: string): Promise<void> {
  return rpcVoid("storage.rmdir", [path]);
}
export function rename(from: string, to: string): Promise<void> {
  return rpcVoid("storage.rename", [from, to]);
}
