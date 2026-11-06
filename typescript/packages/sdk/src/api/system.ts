import { sync, syncVoid } from "./bridge.js";
import { nowMs, sleep, delayUs } from "dango:host";
export { nowMs, sleep, delayUs };
/** Audio service status; PCM stream playback is not part of this SDK API. */
export interface AudioStatus {
  available: boolean;
  controls_available: boolean;
  state: string;
  sample_rate_hz: number;
  volume: number;
  output_ceiling_db: number;
  muted: boolean;
  tx_frames: number;
  rx_frames: number;
  underruns: number;
  overruns: number;
  peak: number;
  error: string | null;
}
export interface CameraStatus {
  available: boolean;
  state: string;
  sensor: string;
  width: number;
  height: number;
  frames: number;
  dropped: number;
  saved: number;
  error: string | null;
}
export interface NetworkStatus {
  wifi_state: string;
  bluetooth_state: string;
  ip: [number, number, number, number] | null;
}
export interface Services {
  audio: AudioStatus | null;
  camera: CameraStatus | null;
  network: NetworkStatus | null;
  native_ui: { objects: number; image_bytes: number } | null;
}
export interface HeapInfo {
  total_size?: number;
  free_size?: number;
  allocated_size?: number;
  minimum_free_size?: number;
  largest_free_block?: number;
  allocated_blocks?: number;
  free_blocks?: number;
  total_blocks?: number;
  sampled_minimum_free_size?: number;
}
export const caps = {
  EXEC: 1,
  BIT32: 2,
  BIT8: 4,
  DMA: 8,
  SPIRAM: 1024,
  INTERNAL: 2048,
  DEFAULT: 4096,
};
export function print(text: string): void {
  syncVoid("print", [text]);
}
export function log(text: string): void {
  syncVoid("log", [text]);
}
/** Wall clock when configured; null when unavailable. */
export function unixTimeUs(): number | null {
  return sync("unix_us");
}
export function args(): unknown {
  return sync("args");
}
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
export function services(): Services {
  return sync("services");
}
export function heapInfo(capabilities: number = caps.DEFAULT): HeapInfo {
  return sync("heap_info", [capabilities]);
}
export function heapProbe(
  capabilities: number,
  bytes: number,
  alignment: number = 8,
): boolean {
  return sync("heap_probe", [capabilities, bytes, alignment]);
}
export function setVolume(volume: number): void {
  syncVoid("volume", [volume]);
}
export function setMuted(muted: boolean): void {
  syncVoid("muted", [muted]);
}

export interface HostFailure extends Error {
  code: number;
}
export function isHostError(value: unknown): value is HostFailure {
  return (
    value instanceof Error && "code" in value && typeof value.code === "number"
  );
}

/** Array narrowing preserves unknown element types for validated JSON. */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export interface RuntimeLimits {
  memory_bytes: number;
  host_bytes: number;
  execution_us: number;
  pending_requests: number;
}
export function runtimeLimits(): RuntimeLimits {
  return sync("runtime_limits");
}
export function time(): number {
  return Math.floor((unixTimeUs() ?? nowMs() * 1000) / 1000000);
}
export function uptime(): number {
  return Math.floor(nowMs() / 1000);
}
export function date(format: string = "%Y-%m-%d %H:%M:%S"): string {
  return sync("date", [time(), format]);
}
export function ip(): string | null {
  return services().network?.ip?.join(".") ?? null;
}
export function info(): {
  uptime_s: number;
  time: number;
  date: string;
  sram_free: number | undefined;
  sram_total: number | undefined;
  sram_largest: number | undefined;
  psram_free: number | undefined;
  psram_total: number | undefined;
  psram_largest: number | undefined;
} {
  const sram = heapInfo(caps.INTERNAL),
    psram = heapInfo(caps.SPIRAM);
  return {
    uptime_s: uptime(),
    time: time(),
    date: date(),
    sram_free: sram.free_size,
    sram_total: sram.total_size,
    sram_largest: sram.largest_free_block,
    psram_free: psram.free_size,
    psram_total: psram.total_size,
    psram_largest: psram.largest_free_block,
  };
}
export function taskWatermarks(): {
  name: string;
  stack_high_water_mark_words: number;
  stack_high_water_mark_bytes: number;
}[] {
  return [];
}
export function currentTask(): {
  name: string;
  stack_high_water_mark_words: number;
  stack_high_water_mark_bytes: number;
} {
  return {
    name: "ts",
    stack_high_water_mark_words: 0,
    stack_high_water_mark_bytes: 0,
  };
}
export class Periodic {
  private last = nowMs();
  constructor(readonly periodMs: number) {
    if (!Number.isInteger(periodMs) || periodMs < 1 || periodMs > 0xffffffff)
      throw new Error("period must be 1..4294967295 ms");
  }
  async wait(): Promise<boolean> {
    const wake = this.last + this.periodMs;
    this.last = wake;
    const ms = wake - nowMs();
    if (ms <= 0) return false;
    await sleep(ms);
    return true;
  }
  reset(): void {
    this.last = nowMs();
  }
}
export interface Availability {
  supported: boolean;
  available: boolean;
}
export interface Capabilities {
  api_version: number;
  modules: { [key: string]: Availability };
  audio_controls_allowed: boolean;
  operations: { audio: string[]; camera: string[]; network: string[] };
  limits: RuntimeLimits & {
    native_ui: { objects: number; image_bytes: number } | undefined;
  };
}
export function capabilities(): Capabilities {
  const h: import("./hardware.js").HardwareSnapshot = sync("hardware"),
    s = services();
  const available = (supported: boolean, value: boolean): Availability => ({
    supported,
    available: value,
  });
  return {
    api_version: 1,
    modules: {
      imu: available(true, (h.available & 1) !== 0),
      magnetometer: available(true, (h.available & 2) !== 0),
      fuel_gauge: available(true, (h.available & 4) !== 0),
      button: available(true, (h.available & 8) !== 0 || h.onboard.ready !== 0),
      led_strip: available(true, (h.available & 16) !== 0),
      haptic: available(true, (h.available & 32) !== 0),
      audio: available(s.audio !== null, s.audio?.available ?? false),
      camera: available(s.camera !== null, s.camera?.available ?? false),
      network: available(
        s.network !== null,
        s.network?.ip !== null && s.network !== null,
      ),
      lvgl: available(s.native_ui !== null, s.native_ui !== null),
    },
    audio_controls_allowed: s.audio?.controls_available ?? false,
    operations: {
      audio: s.audio ? ["status", "set_volume", "set_muted"] : [],
      camera: s.camera ? ["status"] : [],
      network: s.network ? ["status"] : [],
    },
    limits: { ...runtimeLimits(), native_ui: s.native_ui ?? undefined },
  };
}
export function audioStatus(): AudioStatus | null {
  return services().audio;
}
export function cameraStatus(): CameraStatus | null {
  return services().camera;
}
export function networkStatus(): NetworkStatus | null {
  return services().network;
}
/** A named application argument retains unknown until narrowed by the caller. */
export function argument(name: string): unknown {
  const value = args();
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[name]
    : undefined;
}
