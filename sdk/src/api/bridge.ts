/// <reference path="./dango.d.ts" />
import { call, request, callBytes, callVoid, requestBytes, requestReply, requestVoid } from "dango:host";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json | undefined };
export function sync<T>(
  operation: string,
  args: Json = [],
  bytes?: Uint8Array,
): T {
  return call(operation, JSON.stringify(args), bytes) as T;
}
export function rpc<T>(
  operation: string,
  args: Json = [],
  bytes?: Uint8Array,
): Promise<T> {
  return request(operation, JSON.stringify(args), bytes) as Promise<T>;
}

export function syncVoid(operation: string, args: Json = [], bytes?: Uint8Array): void {
  callVoid(operation, JSON.stringify(args), bytes);
}
export function rpcVoid(operation: string, args: Json = [], bytes?: Uint8Array): Promise<void> {
  return requestVoid(operation, JSON.stringify(args), bytes);
}
export function rpcBinary(operation: string, args: Json = []): Promise<Uint8Array> {
  return requestBytes(operation, JSON.stringify(args));
}
export function rpcReply<T>(operation: string, args: Json = [], bytes?: Uint8Array): Promise<{value: T; bytes: Uint8Array}> {
  return requestReply(operation, JSON.stringify(args), bytes) as Promise<{value: T; bytes: Uint8Array}>;
}

export function binary(operation: string, args: Json = []): Uint8Array {
  return callBytes(operation, JSON.stringify(args));
}
