declare module "dango:host" {
  /** Low-level transport. Application code normally uses the typed SDK modules. */
  export interface Reply {
    value: unknown;
    bytes: Uint8Array;
  }
  export function emit(value: number): void;
  export function call(
    operation: string,
    args: string,
    bytes?: Uint8Array,
  ): unknown;
  export function request(
    operation: string,
    args: string,
    bytes?: Uint8Array,
  ): Promise<unknown>;
  export function callBytes(operation: string, args: string, bytes?: Uint8Array): Uint8Array;
  export function callVoid(operation: string, args: string, bytes?: Uint8Array): void;
  export function requestBytes(operation: string, args: string, bytes?: Uint8Array): Promise<Uint8Array>;
  export function requestReply(operation: string, args: string, bytes?: Uint8Array): Promise<Reply>;
  export function requestVoid(operation: string, args: string, bytes?: Uint8Array): Promise<void>;
  export function sleep(milliseconds: number): Promise<void>;
  export function delayUs(microseconds: number): Promise<void>;
  export function nowMs(): number;
  export function draw(operation: number, x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, color: number, start: number, end: number): void;
}
