import { sync, syncVoid } from "./bridge.js";
export interface ButtonEdge {
  sequence: number;
  at_ms: number;
  key: number;
  pressed: number;
}
export interface HardwareSnapshot {
  available: number;
  valid: number;
  accel: [number, number, number];
  gyro: [number, number, number];
  temperature: number;
  sensor_time: number;
  imu_status: number;
  magnetic: [number, number, number];
  magnet_status: number;
  magnet_state: number;
  voltage_mv: number;
  current_ma: number;
  soc: number;
  charging: number;
  button_pins: [number, number];
  button_pressed: [number, number];
  led_generation: number;
  button_generation: number;
  button_sequence: number;
  button_edges: ButtonEdge[];
  onboard: {
    ready: number;
    pressed: [number, number];
    sequence: number;
    edges: ButtonEdge[];
  };
}
export type HapticPreset =
  | "panic"
  | "angry"
  | "surprised"
  | "puzzled"
  | "happy"
  | "satisfied"
  | "confused"
  | "listening"
  | "thinking"
  | "error"
  | "module_insert"
  | "module_remove"
  | "magnetic_contact";
export type Rgb = [number, number, number];
export type LedFrame = [Rgb, Rgb, Rgb, Rgb, Rgb, Rgb];
export function snapshot(): HardwareSnapshot {
  return sync("hardware");
}
/** Acceptance queues a request in the existing output service. */
export function haptic(preset: HapticPreset): void {
  syncVoid("haptic", [preset]);
}
export function ledFrame(frame: LedFrame): void {
  syncVoid("led_frame", [frame]);
}
export function ledRelease(): void {
  syncVoid("led_release");
}

import { nowMs } from "./system.js";
function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function integer(n: number, low: number, high: number): number {
  check(
    Number.isInteger(n) && n >= low && n <= high,
    `integer must be ${low}..${high}`,
  );
  return n;
}
function sample(bit: number, valid: number = 0): HardwareSnapshot {
  const s = snapshot();
  check((s.available & bit) !== 0, "hardware unavailable");
  check((s.valid & valid) === valid, "sample unavailable");
  return s;
}
export interface Xyz {
  x: number;
  y: number;
  z: number;
}
function xyz(v: [number, number, number]): Xyz {
  return { x: v[0], y: v[1], z: v[2] };
}
const leases = new Set<string>();
class Device {
  protected open = true;
  constructor(
    readonly kind: string,
    readonly name: string,
  ) {
    check(!leases.has(kind), "device already open");
    leases.add(kind);
  }
  protected live(): void {
    check(this.open, "closed device handle");
  }
  close(): void {
    if (this.open) {
      this.open = false;
      leases.delete(this.kind);
    }
  }
}
export class Imu extends Device {
  constructor(device: "imu_sensor" = "imu_sensor") {
    sample(1);
    super("imu", device);
  }
  read(): { accel: Xyz; gyro: Xyz; sens_time: number; status: number } {
    this.live();
    const s = sample(1, 11);
    return {
      accel: xyz(s.accel),
      gyro: xyz(s.gyro),
      sens_time: s.sensor_time,
      status: s.imu_status,
    };
  }
  readTemperature(): number {
    this.live();
    return sample(1, 4).temperature;
  }
  readIntStatus(): never {
    this.live();
    throw new Error("interrupt reads are unsupported by snapshot adapter");
  }
}
export class FuelGauge extends Device {
  constructor() {
    sample(4);
    super("fuel_gauge", "fuel_gauge");
  }
  read(): {
    chip: "bq27220";
    voltage_mv: number;
    current_ma: number;
    soc: number;
    charging: boolean;
  } {
    this.live();
    const s = sample(4, 32);
    return {
      chip: "bq27220",
      voltage_mv: s.voltage_mv,
      current_ma: s.current_ma,
      soc: s.soc,
      charging: s.charging !== 0,
    };
  }
  readVoltageMv(): number {
    return this.read().voltage_mv;
  }
  readCurrentMa(): number {
    return this.read().current_ma;
  }
  readSoc(): number {
    return this.read().soc;
  }
  chip(): "bq27220" {
    this.live();
    return "bq27220";
  }
  address(): number {
    this.live();
    return 0x55;
  }
}
export interface Calibration {
  hard_iron: [number, number, number];
  soft_iron: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  calibrated: boolean;
  collecting: boolean;
  sample_count: number;
}
const identity = (): Calibration["soft_iron"] => [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
export class Magnetometer extends Device {
  private hard: [number, number, number] = [0, 0, 0];
  private soft = identity();
  private calibrated = false;
  private collecting = false;
  private count = 0;
  private min: number[] | undefined;
  private max: number[] | undefined;
  constructor(device: "magnetometer_sensor" = "magnetometer_sensor") {
    sample(2);
    super("magnetometer", device);
  }
  read(): {
    magnetic: Xyz;
    raw_magnetic: Xyz;
    status: number;
    calibrated: boolean;
    proximity: "away" | "near" | "contact";
  } {
    this.live();
    const s = sample(2, 16),
      out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        out[i]! += this.soft[i]![j]! * (s.magnetic[j]! - this.hard[j]!);
    return {
      magnetic: xyz(out),
      raw_magnetic: xyz(s.magnetic),
      status: s.magnet_status,
      calibrated: this.calibrated,
      proximity:
        (["away", "near", "contact"] as const)[s.magnet_state] ?? "away",
    };
  }
  chipId(): number {
    this.live();
    sample(2);
    return 0x32;
  }
  readTemperature(): never {
    this.live();
    throw new Error("BMM150 has no temperature read");
  }
  readIntStatus(): never {
    this.live();
    throw new Error("interrupt reads are unsupported by snapshot adapter");
  }
  calibrationGet(): Calibration {
    this.live();
    return {
      hard_iron: [...this.hard],
      soft_iron: this.soft.map((r) => [...r]) as Calibration["soft_iron"],
      calibrated: this.calibrated,
      collecting: this.collecting,
      sample_count: this.count,
    };
  }
  calibrationClear(): Calibration {
    this.live();
    this.hard = [0, 0, 0];
    this.soft = identity();
    this.calibrated = false;
    this.collecting = false;
    this.count = 0;
    this.min = undefined;
    this.max = undefined;
    return this.calibrationGet();
  }
  calibrationReset(): void {
    this.calibrationClear();
    this.collecting = true;
  }
  calibrationAddSample(value?: [number, number, number]): number {
    this.live();
    const v = value ?? sample(2, 16).magnetic;
    check(
      v.length === 3 && v.every(Number.isFinite),
      "finite three-axis sample required",
    );
    this.collecting = true;
    if (!this.min) {
      this.min = [...v];
      this.max = [...v];
    }
    for (let i = 0; i < 3; i++) {
      this.min[i] = Math.min(this.min[i]!, v[i]!);
      this.max![i] = Math.max(this.max![i]!, v[i]!);
    }
    return ++this.count;
  }
  calibrationSet(
    value: Pick<Calibration, "hard_iron" | "soft_iron">,
  ): Calibration {
    this.live();
    check(
      value.hard_iron.length === 3 &&
        value.hard_iron.every(Number.isFinite) &&
        value.soft_iron.length === 3 &&
        value.soft_iron.every(
          (r) => r.length === 3 && r.every(Number.isFinite),
        ),
      "invalid calibration",
    );
    this.hard = [...value.hard_iron];
    this.soft = value.soft_iron.map((r) => [...r]) as Calibration["soft_iron"];
    this.calibrated = true;
    this.collecting = false;
    return this.calibrationGet();
  }
  calibrationFinish(): Calibration {
    this.live();
    check(this.count >= 16, "at least 16 samples required");
    const h: [number, number, number] = [0, 0, 0],
      r = [0, 0, 0],
      m = identity();
    for (let i = 0; i < 3; i++) {
      r[i] = (this.max![i]! - this.min![i]!) / 2;
      check(r[i]! > 0, "nonzero span required on every axis");
      h[i] = (this.max![i]! + this.min![i]!) / 2;
    }
    const average = (r[0]! + r[1]! + r[2]!) / 3;
    for (let i = 0; i < 3; i++) m[i]![i] = average / r[i]!;
    return this.calibrationSet({ hard_iron: h, soft_iron: m });
  }
}
export class LedStrip extends Device {
  private frame: LedFrame = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  private generation: number;
  constructor(
    readonly pin: number = 38,
    readonly count: number = 6,
  ) {
    integer(pin, 38, 38);
    integer(count, 1, 6);
    const s = sample(16);
    super("led_strip", "right_interaction");
    this.generation = s.led_generation;
  }
  setPixel(index: number, r: number, g: number, b: number): void {
    this.live();
    integer(index, 0, this.count - 1);
    this.frame[index] = [
      integer(r, 0, 255),
      integer(g, 0, 255),
      integer(b, 0, 255),
    ];
  }
  setPixelHsv(index: number, h: number, s: number, v: number): void {
    integer(h, 0, 359);
    integer(s, 0, 255);
    integer(v, 0, 255);
    const c = (v * s) / 255,
      x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
      m = v - c;
    const rgb =
      h < 60
        ? [c, x, 0]
        : h < 120
          ? [x, c, 0]
          : h < 180
            ? [0, c, x]
            : h < 240
              ? [0, x, c]
              : h < 300
                ? [x, 0, c]
                : [c, 0, x];
    this.setPixel(
      index,
      Math.floor(rgb[0]! + m),
      Math.floor(rgb[1]! + m),
      Math.floor(rgb[2]! + m),
    );
  }
  refresh(): void {
    this.live();
    check(sample(16).led_generation === this.generation, "LED board changed");
    ledFrame(this.frame);
  }
  clear(): void {
    this.live();
    for (let i = 0; i < 6; i++) this.frame[i] = [0, 0, 0];
    this.refresh();
  }
  override close(): void {
    if (!this.open) return;
    try {
      ledRelease();
    } finally {
      super.close();
    }
  }
}
export class Haptic extends Device {
  constructor() {
    sample(32);
    super("haptic", "haptic");
  }
  play(preset: HapticPreset): void {
    this.live();
    sample(32);
    haptic(preset);
  }
}

export type ButtonEvent =
  | "press_down"
  | "press_up"
  | "press_repeat"
  | "press_repeat_done"
  | "single_click"
  | "double_click"
  | "multiple_click"
  | "long_press_start"
  | "long_press_hold"
  | "long_press_up"
  | "press_end";
export interface ButtonInfo {
  handle: Button;
  event: ButtonEvent;
  repeat_count: number;
  pressed_time_ms: number;
}
type ButtonCallback = (info: ButtonInfo) => void | Promise<void>;
const buttons = new Map<number, Button>();
let dispatching = false;
function domain(s: HardwareSnapshot, onboard: boolean) {
  return onboard
    ? {
        available: s.onboard.ready !== 0,
        valid: s.onboard.ready !== 0,
        pins: [7, 61],
        pressed: s.onboard.pressed,
        generation: 0,
        sequence: s.onboard.sequence,
        edges: s.onboard.edges,
      }
    : {
        available: (s.available & 8) !== 0,
        valid: (s.valid & 64) !== 0,
        pins: s.button_pins,
        pressed: s.button_pressed,
        generation: s.button_generation,
        sequence: s.button_sequence,
        edges: s.button_edges,
      };
}
const elapsed = (a: number, b: number) => (a - b) >>> 0;
export class Button {
  private closed = false;
  private onboard: boolean;
  private key: number;
  private generation: number;
  private sequence: number;
  private callbacks = new Map<ButtonEvent, ButtonCallback>();
  private pressed: boolean;
  private count = 0;
  private unknownDown: boolean;
  private downAt: number | undefined;
  private releasedAt: number | undefined;
  private longStarted = false;
  readonly longMs: number;
  readonly shortMs: number;
  constructor(
    readonly pin: number,
    readonly active: number = 0,
    longMs: number = 0,
    shortMs: number = 0,
  ) {
    integer(pin, 0, 63);
    integer(active, 0, 1);
    integer(longMs, 0, 65535);
    integer(shortMs, 0, 65535);
    this.onboard = pin === 7 || pin === 61;
    this.longMs = longMs || 1500;
    this.shortMs = shortMs || (this.onboard ? 180 : 400);
    const s = domain(snapshot(), this.onboard);
    check(s.available && s.valid, "button sample unavailable");
    this.key = s.pins.indexOf(pin);
    check(this.key >= 0, "GPIO is not an active key");
    check(!buttons.has(pin), "button already open");
    this.generation = s.generation;
    this.sequence = s.sequence;
    this.pressed = s.pressed[this.key] !== 0;
    this.unknownDown = this.pressed;
    buttons.set(pin, this);
  }
  private live(): void {
    check(
      !this.closed && buttons.get(this.pin) === this,
      "closed button handle",
    );
  }
  close(): void {
    if (this.closed) return;
    this.live();
    buttons.delete(this.pin);
    this.closed = true;
    this.callbacks.clear();
  }
  on(event: ButtonEvent, callback: ButtonCallback): void {
    this.live();
    this.callbacks.set(event, callback);
  }
  off(event?: ButtonEvent): void {
    this.live();
    if (event) this.callbacks.delete(event);
    else this.callbacks.clear();
  }
  level(): number {
    this.live();
    const s = domain(snapshot(), this.onboard);
    check(
      s.available && s.valid && s.generation === this.generation,
      "button unavailable or board changed",
    );
    return s.pressed[this.key] !== 0 ? this.active : 1 - this.active;
  }
  static async dispatch(): Promise<number> {
    check(!dispatching, "button dispatch is not reentrant");
    dispatching = true;
    try {
      const s = snapshot(),
        now = nowMs() >>> 0,
        pending: { h: Button; fn: ButtonCallback; info: ButtonInfo }[] = [];
      const emit = (h: Button, event: ButtonEvent, duration: number = 0) => {
        const fn = h.callbacks.get(event);
        if (fn)
          pending.push({
            h,
            fn,
            info: {
              handle: h,
              event,
              repeat_count: h.count,
              pressed_time_ms: duration,
            },
          });
      };
      const end = (h: Button) => {
        if (h.count === 1) emit(h, "single_click");
        else if (h.count === 2) emit(h, "double_click");
        else if (h.count > 2) emit(h, "multiple_click");
        if (h.count > 1) emit(h, "press_repeat_done");
        if (h.count > 0) emit(h, "press_end");
        h.count = 0;
        h.releasedAt = undefined;
      };
      const timers = (h: Button, at: number) => {
        if (h.pressed && h.downAt !== undefined) {
          const d = elapsed(at, h.downAt);
          if (d >= h.longMs && !h.longStarted) {
            h.longStarted = true;
            emit(h, "long_press_start", d);
          }
        } else if (
          h.releasedAt !== undefined &&
          elapsed(at, h.releasedAt) >= h.shortMs
        )
          end(h);
      };
      for (const h of buttons.values()) {
        const d = domain(s, h.onboard);
        if (!d.available || !d.valid || d.generation !== h.generation) {
          h.close();
          continue;
        }
        const delta = elapsed(d.sequence, h.sequence);
        check(delta <= 16, "button event queue overflow");
        for (let offset = 1; offset <= delta; offset++) {
          const seq = (h.sequence + offset) >>> 0,
            e = d.edges[seq % 16]!;
          check(e.sequence === seq, "button event queue overwritten");
          if (e.key !== h.key) continue;
          timers(h, e.at_ms);
          if (e.pressed !== 0) {
            h.pressed = true;
            h.downAt = e.at_ms;
            h.longStarted = false;
            h.unknownDown = false;
            emit(h, "press_down");
            if (h.count > 0) emit(h, "press_repeat");
          } else {
            const duration =
              h.downAt === undefined ? 0 : elapsed(e.at_ms, h.downAt);
            h.pressed = false;
            emit(h, "press_up", duration);
            if (h.longStarted) {
              emit(h, "long_press_up", duration);
              emit(h, "press_end", duration);
              h.count = 0;
              h.releasedAt = undefined;
            } else if (!h.unknownDown) {
              h.count++;
              h.releasedAt = e.at_ms;
            }
            h.downAt = undefined;
            h.unknownDown = false;
          }
        }
        h.sequence = d.sequence;
        timers(h, now);
        if (h.pressed && h.longStarted)
          emit(h, "long_press_hold", elapsed(now, h.downAt!));
      }
      let count = 0;
      for (const e of pending)
        if (!e.h.closed && e.h.callbacks.get(e.info.event) === e.fn) {
          await e.fn(e.info);
          count++;
        }
      return count;
    } finally {
      dispatching = false;
    }
  }
}
