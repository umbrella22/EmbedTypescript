/** Default resident behavior, ported from dangoOS default.lua. No native behavior proxy. */
import * as brain from "./brain.js";
import { Json } from "./bridge.js";
const { min, max, abs, floor } = Math;
const sub = (a: number, b: number): number => max(0, a - b);
const priority = (p: string): number =>
  p === "Error" ? 3 : p === "Panic" ? 2 : 1;
const intensity: Record<string, number> = {
  Idle: 0,
  Sleep: 0,
  Curious: 40,
  Happy: 50,
  Puzzled: 60,
  Confused: 45,
  Surprised: 70,
  Panic: 100,
  Angry: 90,
  Satisfied: 55,
  Listening: 60,
  Thinking: 35,
  Speaking: 55,
  Error: 100,
  Tired: 25,
  Dying: 15,
  Peering: 40,
  Dazzled: 65,
  NetworkDisconnected: 35,
  NetworkConnected: 50,
  BluetoothDisconnected: 35,
  BluetoothConnected: 50,
  MusicPlaying: 55,
};
function window(
  times: number[],
  at: number,
  span: number,
  capacity: number,
): void {
  times.push(at);
  while (
    times.length > capacity ||
    (times.length > 0 && sub(at, times[0]!) > span)
  )
    times.shift();
}
interface Reaction {
  expression: string;
  reason: string;
  priority: number;
  started_ms: number;
  ends_ms: number;
}
interface Step {
  expression: string;
  reason: string;
  duration_ms: number;
}
const step = (
  expression: string,
  reason: string,
  duration_ms: number,
): Step => ({ expression, reason, duration_ms });
export interface AffectState {
  type: "AffectState";
  expression: string;
  intensity: number;
  since_ms: number;
  reason: string;
}
export interface AffectTick {
  type: "AffectTick";
  state: AffectState;
  changed: boolean;
  haptic: string | undefined;
  command: "Hub" | "StopActivity" | "StartListening" | undefined;
}
export class Affect {
  now_ms: number;
  last_expression = "Idle";
  fallback_since_ms: number;
  idle_expression = "Idle";
  error_active = false;
  error_since_ms = 0;
  angry_cooldown_until = 0;
  poke_times: number[] = [];
  r_key_times: number[] = [];
  key_left_down = false;
  key_right_down = false;
  key_left_down_at: number | undefined;
  key_right_down_at: number | undefined;
  light_history: { level: number; at_ms: number }[] = [];
  light_level: number | undefined;
  dawn_ref_level = 0;
  dawn_ref_at: number | undefined;
  light_cover: { before: number; since_ms: number } | undefined;
  dark_since: number | undefined;
  awake_until: number | undefined;
  pir_raw = false;
  pir_raw_since: number;
  pir_debounced = false;
  pir_sustained_fired = false;
  pir_rise_ms = 0;
  pir_absence_since: number | undefined;
  pir_presence_since: number | undefined;
  pir_last_satisfied_ms: number | undefined;
  magnetic_contacted = false;
  module_left_present = false;
  module_right_present = false;
  reaction: Reaction | undefined;
  module_sequence:
    | { steps: Step[]; index: number; stage_started_ms: number }
    | undefined;
  panic_followup:
    | {
        panic_end_ms: number;
        confused_started: boolean;
        confused_end_ms: number;
      }
    | undefined;
  pending_haptic: string | undefined;
  last_haptic_ms: number | undefined;
  pending_command: "Hub" | "StopActivity" | "StartListening" | undefined;
  activity: string | undefined;
  battery_expression: string | undefined;
  music_since: number | undefined;
  network_connected: boolean | undefined;
  bluetooth_connected: boolean | undefined;
  connection_expression: string | undefined;
  connection_since = 0;
  shake: {
    violent_peaks: number[];
    violent_above: boolean;
    dizzy: number;
    dizzy_at_ms: number;
    burst_active: boolean;
    burst_first_motion_ms: number;
    burst_last_motion_ms: number;
    burst_above_small: boolean;
    burst_small_peaks: number;
    burst_large: boolean;
    burst_confused_emitted: boolean;
    small_burst_count: number;
    burst_window_start_ms: number;
    prev_burst_last_motion_ms: number | undefined;
  } = {
    violent_peaks: [],
    violent_above: false,
    dizzy: 0,
    dizzy_at_ms: 0,
    burst_active: false,
    burst_first_motion_ms: 0,
    burst_last_motion_ms: 0,
    burst_above_small: false,
    burst_small_peaks: 0,
    burst_large: false,
    burst_confused_emitted: false,
    small_burst_count: 0,
    burst_window_start_ms: 0,
    prev_burst_last_motion_ms: undefined,
  };
  constructor(now: number) {
    this.now_ms = now;
    this.fallback_since_ms = now;
    this.pir_raw_since = now;
  }
  queue_haptic(p: string): void {
    if (this.error_active && p !== "Error") return;
    if (!this.pending_haptic || priority(p) >= priority(this.pending_haptic))
      this.pending_haptic = p;
  }
  take_haptic(now: number): string | undefined {
    const p = this.pending_haptic;
    if (
      !p ||
      (this.last_haptic_ms !== undefined && now < this.last_haptic_ms + 150)
    )
      return;
    this.pending_haptic = undefined;
    this.last_haptic_ms = now;
    return p;
  }
  try_start_reaction(
    e: string,
    r: string,
    p: number,
    at: number,
    duration: number,
    h: string | undefined,
  ): boolean {
    if (this.error_active) return false;
    const c = this.reaction;
    if (c && at < c.ends_ms) {
      if (p < c.priority || (p === c.priority && p >= 3)) return false;
      if (
        p === c.priority &&
        ["Light", "Presence", "Magnetic"].includes(r) &&
        r !== c.reason &&
        at < c.started_ms + 1200
      )
        return false;
    }
    if (this.module_sequence && p <= 2) return false;
    if (p >= 3) this.module_sequence = undefined;
    this.reaction = {
      expression: e,
      reason: r,
      priority: p,
      started_ms: at,
      ends_ms: at + duration,
    };
    if (h) this.queue_haptic(h);
    return true;
  }
  is_panic_active(at: number): boolean {
    const r = this.reaction;
    return r !== undefined && r.priority === 4 && at < r.ends_ms;
  }
  is_angry_active(at: number): boolean {
    const r = this.reaction;
    return r !== undefined && r.priority === 3 && at < r.ends_ms;
  }
  wake(at: number): void {
    this.dark_since = undefined;
    if (this.idle_expression === "Sleep") {
      this.idle_expression = "Idle";
      this.fallback_since_ms = at;
    }
  }
  keep_awake(at: number): void {
    this.awake_until = at + 300000;
    this.wake(at);
  }
  rouse(at: number, how: string): boolean {
    const visible =
      this.idle_expression === "Sleep" &&
      !this.error_active &&
      !this.activity &&
      !this.battery_expression &&
      !this.reaction &&
      !this.module_sequence;
    const r = this.reaction;
    const drowsy =
      r && r.reason === "Wake" && r.expression === "Tired" && at < r.ends_ms;
    this.keep_awake(at);
    let grumpy: boolean;
    if (visible) grumpy = how === "Rough";
    else if (drowsy && (how === "Poke" || how === "Rough")) grumpy = true;
    else return false;
    if (grumpy) {
      this.reaction = undefined;
      return this.try_start_reaction("Angry", "Wake", 2, at, 2500, "Angry");
    }
    return this.try_start_reaction("Tired", "Wake", 2, at, 3000, undefined);
  }
  expire_reaction(now: number): void {
    if (this.reaction && now >= this.reaction.ends_ms) {
      this.fallback_since_ms = this.reaction.ends_ms;
      this.reaction = undefined;
    }
  }
  advance_panic(now: number): void {
    if (this.error_active) {
      this.panic_followup = undefined;
      return;
    }
    const f = this.panic_followup;
    if (!f || now < f.panic_end_ms) return;
    if (!f.confused_started) {
      const start = max(this.shake.burst_last_motion_ms, f.panic_end_ms) + 5000,
        ending = start + 3000;
      if (now < start) return;
      if (now >= ending) {
        this.panic_followup = undefined;
        this.fallback_since_ms = ending;
        return;
      }
      this.try_start_reaction(
        "Confused",
        "ShakeLarge",
        2,
        start,
        3000,
        "Confused",
      );
      f.confused_started = true;
      f.confused_end_ms = ending;
      return;
    }
    if (now >= f.confused_end_ms) {
      const r = this.reaction;
      if (
        r &&
        r.expression === "Confused" &&
        r.reason === "ShakeLarge" &&
        r.ends_ms === f.confused_end_ms
      )
        this.reaction = undefined;
      this.fallback_since_ms = f.confused_end_ms;
      this.panic_followup = undefined;
    }
  }
  advance_module_sequence(now: number): void {
    const s = this.module_sequence;
    if (!s) return;
    while (true) {
      const ending = s.stage_started_ms + s.steps[s.index]!.duration_ms;
      if (now < ending) break;
      s.stage_started_ms = ending;
      s.index++;
      if (s.index >= s.steps.length) {
        this.module_sequence = undefined;
        this.fallback_since_ms = ending;
        return;
      }
    }
  }
  advance_pir(now: number): void {
    if (this.pir_raw !== this.pir_debounced) {
      const at = this.pir_raw_since + 200;
      if (now >= at) {
        this.pir_debounced = this.pir_raw;
        if (this.pir_raw) {
          const same =
            this.pir_absence_since !== undefined
              ? at < this.pir_absence_since + 30000
              : this.pir_presence_since !== undefined;
          this.pir_rise_ms = at;
          this.pir_absence_since = undefined;
          this.wake(at);
          if (!same) {
            this.pir_presence_since = at;
            this.pir_sustained_fired = false;
            this.fallback_since_ms = at;
            this.try_start_reaction(
              "Curious",
              "Presence",
              1,
              at,
              4000,
              undefined,
            );
          }
        } else this.pir_absence_since = at;
      }
    }
    if (this.pir_debounced && this.pir_presence_since !== undefined) {
      const fire = max(this.pir_presence_since + 10000, this.pir_rise_ms);
      if (now >= fire && !this.pir_sustained_fired) {
        const allowed =
          this.pir_last_satisfied_ms === undefined ||
          fire >= this.pir_last_satisfied_ms + 30000;
        if (
          allowed &&
          this.try_start_reaction(
            "Satisfied",
            "Presence",
            1,
            fire,
            3000,
            "Satisfied",
          )
        )
          this.pir_last_satisfied_ms = fire;
        this.pir_sustained_fired = true;
      }
    }
    if (this.pir_absence_since !== undefined) {
      const since = this.pir_absence_since;
      if (now >= since + 30000) {
        this.pir_presence_since = undefined;
        this.pir_sustained_fired = false;
      }
      const sleep = max(since + 60000, this.awake_until ?? 0);
      if (
        !this.pir_debounced &&
        now >= sleep &&
        this.idle_expression !== "Sleep"
      ) {
        this.idle_expression = "Sleep";
        this.fallback_since_ms = sleep;
      }
    }
  }
  advance_dawn(now: number): void {
    if (
      this.light_level === undefined ||
      this.dawn_ref_at === undefined ||
      now < this.dawn_ref_at + 30000
    )
      return;
    if (this.light_level >= this.dawn_ref_level + 20) {
      this.try_start_reaction("Curious", "Light", 1, now, 3000, undefined);
      this.dawn_ref_level = this.light_level;
      this.dawn_ref_at = now;
    } else if (this.light_level < this.dawn_ref_level) {
      this.dawn_ref_level = this.light_level;
      this.dawn_ref_at = now;
    }
  }
  advance(now: number): void {
    now = max(now, this.now_ms);
    this.now_ms = now;
    const r = this.reaction;
    if (
      this.key_left_down &&
      r &&
      r.reason === "KeyLeft" &&
      r.expression === "Happy" &&
      r.priority === 2
    )
      r.ends_ms = now + 3000;
    this.update_burst(now);
    this.expire_reaction(now);
    this.advance_panic(now);
    this.expire_reaction(now);
    this.advance_module_sequence(now);
    this.advance_pir(now);
    this.advance_dawn(now);
    if (this.dark_since !== undefined) {
      const sleep = max(this.dark_since + 60000, this.awake_until ?? 0);
      if (now >= sleep && this.idle_expression !== "Sleep") {
        this.idle_expression = "Sleep";
        this.fallback_since_ms = sleep;
      }
    }
    this.expire_reaction(now);
  }
  resolve(
    skip_reaction: boolean = false,
    now: number = this.now_ms,
  ): [string, string, number] {
    if (this.error_active) return ["Error", "Error", this.error_since_ms];
    const r = this.reaction;
    if (!skip_reaction && r) return [r.expression, r.reason, r.started_ms];
    const s = this.module_sequence;
    if (s) {
      const step = s.steps[s.index]!;
      return [step.expression, step.reason, s.stage_started_ms];
    }
    if (this.activity) {
      if (!skip_reaction && this.panic_followup)
        return [this.idle_expression, "Idle", this.fallback_since_ms];
      return [this.activity, "Activity", this.fallback_since_ms];
    }
    if (this.battery_expression)
      return [this.battery_expression, "Battery", this.fallback_since_ms];
    if (this.music_since !== undefined)
      return ["MusicPlaying", "Activity", this.music_since];
    if (this.connection_expression && now - this.connection_since < 4000)
      return [this.connection_expression, "Activity", this.connection_since];
    return [this.idle_expression, "Idle", this.fallback_since_ms];
  }
  snapshot_at(now: number): AffectState {
    now = max(now, this.now_ms);
    const [e, r, s] = this.resolve(
      this.reaction !== undefined && now >= this.reaction.ends_ms,
      now,
    );
    return {
      type: "AffectState",
      expression: e,
      intensity: intensity[e]!,
      since_ms: s,
      reason: r,
    };
  }
  tick(now: number): AffectTick {
    now = max(now, this.now_ms);
    this.advance(now);
    const [e, r, s] = this.resolve(),
      changed = e !== this.last_expression;
    this.last_expression = e;
    const command = this.pending_command;
    this.pending_command = undefined;
    return {
      type: "AffectTick",
      state: {
        type: "AffectState",
        expression: e,
        intensity: intensity[e]!,
        since_ms: s,
        reason: r,
      },
      changed,
      haptic: this.take_haptic(now),
      command,
    };
  }
  on_screen_touch(at: number): boolean {
    at = max(at, this.now_ms);
    this.advance(at);
    return this.rouse(at, "Poke");
  }
  on_interaction(at: number): void {
    at = max(at, this.now_ms);
    this.advance(at);
    this.keep_awake(at);
  }
  is_asleep(): boolean {
    return this.idle_expression === "Sleep";
  }
  trigger_panic(at: number): void {
    if (this.error_active) return;
    this.reaction = {
      expression: "Panic",
      reason: "ShakeLarge",
      priority: 4,
      started_ms: at,
      ends_ms: at + 1500,
    };
    this.panic_followup = {
      panic_end_ms: at + 1500,
      confused_started: false,
      confused_end_ms: 0,
    };
    this.module_sequence = undefined;
    const s = this.shake;
    s.violent_peaks = [];
    s.dizzy = 0;
    s.small_burst_count = 0;
    s.burst_window_start_ms = at;
    s.prev_burst_last_motion_ms = undefined;
    s.burst_small_peaks = 0;
    s.burst_confused_emitted = true;
    this.queue_haptic("Panic");
  }
  start_angry(at: number, reason: string): void {
    if (this.error_active) return;
    this.reaction = {
      expression: "Angry",
      reason,
      priority: 3,
      started_ms: at,
      ends_ms: at + 10000,
    };
    this.angry_cooldown_until = at + 40000;
    this.module_sequence = undefined;
    this.shake.small_burst_count = 0;
    this.shake.burst_window_start_ms = at;
    this.queue_haptic("Angry");
  }
  drain_dizzy(at: number): void {
    const s = this.shake;
    s.dizzy = sub(
      s.dizzy,
      floor((min(sub(at, s.dizzy_at_ms), 60000) * 500) / 1000),
    );
    s.dizzy_at_ms = max(s.dizzy_at_ms, at);
  }
  add_dizzy(at: number, gain: number): void {
    this.drain_dizzy(at);
    this.shake.dizzy = min(this.shake.dizzy + gain, 3000);
    if (this.shake.dizzy >= 1500) this.on_dizzy(at);
  }
  note_motion(at: number): void {
    const s = this.shake;
    if (!s.burst_active) {
      s.burst_active = true;
      s.burst_first_motion_ms = at;
      s.burst_above_small = false;
      s.burst_small_peaks = 0;
      s.burst_large = false;
      s.burst_confused_emitted = false;
    }
    s.burst_last_motion_ms = at;
    const r = this.reaction;
    if (
      r &&
      r.reason === "ShakeSmall" &&
      r.expression === "Confused" &&
      at < r.ends_ms
    )
      r.ends_ms = at + 2500;
  }
  on_dizzy(at: number): void {
    const r = this.reaction;
    if (r) {
      if (
        r.reason === "ShakeSmall" &&
        r.expression === "Confused" &&
        at < r.ends_ms
      ) {
        r.ends_ms = at + 2500;
        this.shake.burst_confused_emitted = true;
        return;
      }
      if (r.priority >= 2 && at < r.ends_ms) return;
    }
    if (this.module_sequence) return;
    const h = !this.shake.burst_confused_emitted ? "Confused" : undefined;
    if (this.try_start_reaction("Confused", "ShakeSmall", 2, at, 2500, h))
      this.shake.burst_confused_emitted = true;
  }
  on_violent_peak(at: number): void {
    const s = this.shake;
    window(s.violent_peaks, at, Number.MAX_SAFE_INTEGER, 5);
    if (s.violent_peaks.length === 5 && sub(at, s.violent_peaks[0]!) <= 1000) {
      s.violent_peaks = [];
      if (!this.is_panic_active(at)) {
        s.burst_confused_emitted = true;
        this.trigger_panic(at);
      }
    }
  }
  on_accel(at: number, x: number, y: number, z: number): void {
    const d = abs(floor(Math.sqrt(x * x + y * y + z * z)) - 1000),
      s = this.shake;
    if (d < 80) {
      s.burst_above_small = false;
      s.violent_above = false;
      this.drain_dizzy(at);
      return;
    }
    this.note_motion(at);
    this.rouse(at, d >= 950 ? "Rough" : "Gentle");
    if (d > 1200) s.burst_large = true;
    if (d >= 300) {
      if (!s.burst_above_small) {
        s.burst_above_small = true;
        s.burst_small_peaks = min(255, s.burst_small_peaks + 1);
      }
      this.add_dizzy(at, floor(min(d, 1000) / 10));
    } else {
      s.burst_above_small = false;
      this.drain_dizzy(at);
    }
    if (d >= 950) {
      if (!s.violent_above) {
        s.violent_above = true;
        this.on_violent_peak(at);
      }
    } else if (d < 600) s.violent_above = false;
  }
  on_gyro(at: number, x: number, y: number, z: number): void {
    const d = max(abs(x), abs(y), abs(z));
    if (d < 20) {
      this.drain_dizzy(at);
      return;
    }
    this.note_motion(at);
    this.rouse(at, "Gentle");
    if (d >= 150) this.add_dizzy(at, floor(min(d, 500) / 10));
    else this.drain_dizzy(at);
  }
  update_burst(now: number): void {
    const s = this.shake;
    if (!s.burst_active) return;
    const close = s.burst_last_motion_ms + 300;
    if (now < close) return;
    s.burst_active = false;
    const small = s.burst_small_peaks >= 1,
      large = s.burst_large,
      first = s.burst_first_motion_ms,
      last = s.burst_last_motion_ms;
    s.burst_above_small = false;
    s.burst_small_peaks = 0;
    s.burst_large = false;
    s.burst_confused_emitted = false;
    if (large || !small) return;
    const gap =
      s.prev_burst_last_motion_ms === undefined
        ? undefined
        : sub(first, s.prev_burst_last_motion_ms);
    const valid = gap !== undefined && gap >= 300 && gap <= 800;
    if (
      valid &&
      s.small_burst_count > 0 &&
      sub(first, s.burst_window_start_ms) <= 15000
    )
      s.small_burst_count = min(255, s.small_burst_count + 1);
    else {
      s.small_burst_count = 1;
      s.burst_window_start_ms = first;
    }
    s.prev_burst_last_motion_ms = last;
    if (s.small_burst_count >= 5) {
      s.small_burst_count = 0;
      s.burst_window_start_ms = close;
      if (
        close >= this.angry_cooldown_until &&
        !this.is_panic_active(close) &&
        !this.is_angry_active(close)
      )
        this.start_angry(close, "ShakeBursts");
    }
  }
  on_touch_pet(at: number): void {
    if (this.rouse(at, "Gentle")) return;
    const r = this.reaction;
    if (
      r &&
      r.reason === "TouchPet" &&
      r.expression === "Happy" &&
      at < r.ends_ms
    ) {
      r.ends_ms = at + 1500;
      return;
    }
    this.try_start_reaction("Happy", "TouchPet", 2, at, 1500, "Happy");
  }
  on_touch_poke(at: number): void {
    if (this.rouse(at, "Poke")) return;
    window(this.poke_times, at, 1500, 3);
    if (this.poke_times.length >= 3) {
      this.poke_times = [];
      if (
        at >= this.angry_cooldown_until &&
        !this.is_panic_active(at) &&
        !this.is_angry_active(at)
      ) {
        this.start_angry(at, "TouchPoke");
        return;
      }
    }
    this.try_start_reaction("Puzzled", "TouchPoke", 2, at, 1500, "Puzzled");
  }
  reanchor_dawn(at: number, level: number): void {
    this.dawn_ref_level = level;
    this.dawn_ref_at = at;
  }
  hold_cover(at: number, level: number): void {
    const c = this.light_cover;
    if (!c) return;
    const threshold = max(8, floor((c.before * 40) / 100));
    if (level > c.before - floor(threshold / 2)) {
      this.light_cover = undefined;
      return;
    }
    const r = this.reaction;
    if (r && r.expression === "Peering" && at < r.ends_ms)
      r.ends_ms = max(r.ends_ms, min(at + 3000, c.since_ms + 15000));
  }
  on_light_level(at: number, level: number): void {
    level = min(level, 100);
    this.light_history.push({ level, at_ms: at });
    if (this.light_history.length > 16) this.light_history.shift();
    if (level >= 20) {
      this.wake(at);
      this.dark_since = undefined;
    } else if (level >= 10) this.dark_since = undefined;
    else if (this.dark_since === undefined) this.dark_since = at;
    const oldest = this.light_history.find((s) => sub(at, s.at_ms) <= 400);
    if (oldest && oldest.at_ms < at) {
      const before = oldest.level,
        threshold = max(8, floor((max(before, level) * 40) / 100));
      if (level - before >= threshold) {
        this.light_cover = undefined;
        this.try_start_reaction("Dazzled", "Light", 1, at, 3000, "Surprised");
        this.light_history = [{ level, at_ms: at }];
        this.reanchor_dawn(at, level);
      } else if (before - level >= threshold && !this.light_cover) {
        this.light_cover = { before, since_ms: at };
        this.try_start_reaction("Peering", "Light", 1, at, 3000, undefined);
        this.light_history = [{ level, at_ms: at }];
        this.reanchor_dawn(at, level);
      }
    }
    this.hold_cover(at, level);
    if (this.dawn_ref_at === undefined) this.reanchor_dawn(at, level);
    this.light_level = level;
  }
  on_presence(at: number, present: boolean): void {
    if (present !== this.pir_raw) {
      this.pir_raw = present;
      this.pir_raw_since = at;
    }
  }
  start_hug(at: number): void {
    this.r_key_times = [];
    this.poke_times = [];
    this.try_start_reaction("Satisfied", "BothKeys", 2, at, 3500, "Satisfied");
  }
  on_key_down(at: number, source: string): void {
    if (
      (source === "KeyLeft" || source === "KeyRight") &&
      this.rouse(at, "Gentle")
    )
      return;
    if (source === "KeyLeft") {
      if (this.key_left_down) return;
      this.key_left_down = true;
      this.key_left_down_at = at;
      if (
        this.key_right_down &&
        this.key_right_down_at !== undefined &&
        sub(at, this.key_right_down_at) <= 300
      ) {
        this.start_hug(at);
        return;
      }
      this.try_start_reaction("Happy", "KeyLeft", 2, at, 3000, "Happy");
    } else if (source === "KeyRight") {
      if (this.key_right_down) return;
      this.key_right_down = true;
      this.key_right_down_at = at;
      if (
        this.key_left_down &&
        this.key_left_down_at !== undefined &&
        sub(at, this.key_left_down_at) <= 300
      ) {
        this.start_hug(at);
        return;
      }
      window(this.r_key_times, at, 1500, 3);
      if (this.r_key_times.length >= 3) {
        this.r_key_times = [];
        if (
          at >= this.angry_cooldown_until &&
          !this.is_panic_active(at) &&
          !this.is_angry_active(at)
        ) {
          this.start_angry(at, "KeyRight");
          return;
        }
      }
      this.try_start_reaction("Puzzled", "KeyRight", 2, at, 3000, "Puzzled");
    }
  }
  on_key_up(at: number, source: string): void {
    if (source === "KeyLeft") {
      if (!this.key_left_down) return;
      this.key_left_down = false;
      this.key_left_down_at = undefined;
      const r = this.reaction;
      if (
        r &&
        r.reason === "KeyLeft" &&
        r.expression === "Happy" &&
        r.priority === 2
      )
        r.ends_ms = at + 3000;
    } else if (source === "KeyRight") {
      this.key_right_down = false;
      this.key_right_down_at = undefined;
    }
  }
  on_button_short(at: number, source: string): void {
    if (source !== "ButtonPower") return;
    this.keep_awake(at);
    if (!this.error_active) {
      this.activity = "Listening";
      this.fallback_since_ms = at;
    }
    this.pending_command = "StartListening";
    this.queue_haptic("Listening");
  }
  on_button_long(_at: number, source: string): void {
    if (source === "ButtonPower") this.pending_command = "Hub";
  }
  on_button_double(at: number, source: string): void {
    if (source === "ButtonPower") {
      this.activity = undefined;
      this.fallback_since_ms = at;
      this.pending_command = "StopActivity";
    }
  }
  enter_error(at: number): void {
    if (this.error_active) return;
    this.error_active = true;
    this.error_since_ms = at;
    this.fallback_since_ms = at;
    this.activity = undefined;
    this.reaction = undefined;
    this.panic_followup = undefined;
    this.module_sequence = undefined;
    this.queue_haptic("Error");
  }
  on_activity(at: number, e: string): void {
    if (["Listening", "Thinking", "Speaking"].includes(e)) {
      if (!this.error_active) {
        this.activity = e;
        this.fallback_since_ms = at;
      }
    } else if (e === "Error") this.enter_error(at);
    else if (e === "Idle") {
      this.activity = undefined;
      if (this.error_active) {
        this.error_active = false;
        this.error_since_ms = 0;
        if (this.pending_haptic === "Error") this.pending_haptic = undefined;
      }
      this.fallback_since_ms = at;
    }
  }
  on_battery_level(at: number, p: number): void {
    p = min(p, 100);
    const old = this.battery_expression;
    let next: string | undefined;
    if (old === "Dying") {
      if (p < 8) next = "Dying";
      else if (p <= 15) next = "Tired";
    } else if (old === "Tired") {
      if (p >= 18) next = undefined;
      else if (p <= 5) next = "Dying";
      else next = "Tired";
    } else {
      if (p <= 5) next = "Dying";
      else if (p <= 15) next = "Tired";
    }
    if (next !== old) {
      this.battery_expression = next;
      this.fallback_since_ms = at;
    }
  }
  on_magnetic_approach(at: number): void {
    if (!this.rouse(at, "Gentle"))
      this.try_start_reaction("Curious", "Magnetic", 2, at, 2000, undefined);
  }
  on_magnetic_contact(at: number): void {
    this.keep_awake(at);
    if (this.magnetic_contacted) return;
    this.magnetic_contacted = true;
    this.try_start_reaction(
      "Satisfied",
      "Magnetic",
      2,
      at,
      1500,
      "MagneticContact",
    );
  }
  on_magnetic_release(at: number): void {
    if (!this.magnetic_contacted) return;
    this.magnetic_contacted = false;
    this.try_start_reaction("Confused", "Magnetic", 2, at, 2000, "Confused");
  }
  on_magnetic_orbit(at: number): void {
    this.try_start_reaction("Surprised", "Magnetic", 2, at, 1200, "Surprised");
  }
  on_magnetic_edge(at: number, c: number): void {
    if (c >= 50)
      this.try_start_reaction("Puzzled", "Magnetic", 2, at, 1500, "Puzzled");
  }
  start_module_sequence(at: number, steps: Step[], h: string): void {
    if (
      this.error_active ||
      this.module_sequence ||
      (this.reaction &&
        at < this.reaction.ends_ms &&
        this.reaction.priority > 2)
    )
      return;
    this.reaction = undefined;
    this.module_sequence = { steps, index: 0, stage_started_ms: at };
    this.queue_haptic(h);
  }
  on_module_inserted(at: number, source: string, kind: string): void {
    this.keep_awake(at);
    this.magnetic_contacted = false;
    const key =
      source === "ModuleLeft"
        ? "module_left_present"
        : source === "ModuleRight"
          ? "module_right_present"
          : undefined;
    if (!key || this[key]) return;
    this[key] = true;
    if (kind === "Interaction")
      this.start_module_sequence(
        at,
        [
          step("Surprised", "ModuleInsert", 800),
          step("Curious", "ModuleInsert", 2000),
          step("Happy", "ModuleInsert", 2000),
        ],
        "ModuleInsert",
      );
    else if (kind === "Camera")
      this.start_module_sequence(
        at,
        [step("Curious", "ModuleInsert", 2500)],
        "ModuleInsert",
      );
  }
  on_module_removed(at: number, source: string, kind: string): void {
    this.magnetic_contacted = false;
    const key =
      source === "ModuleLeft"
        ? "module_left_present"
        : source === "ModuleRight"
          ? "module_right_present"
          : undefined;
    if (!key || !this[key]) return;
    this[key] = false;
    if (kind === "Interaction")
      this.start_module_sequence(
        at,
        [
          step("Surprised", "ModuleRemove", 800),
          step("Confused", "ModuleRemove", 2500),
        ],
        "ModuleRemove",
      );
    else if (kind === "Camera")
      this.start_module_sequence(
        at,
        [step("Confused", "ModuleRemove", 2500)],
        "ModuleRemove",
      );
  }
  on_business(at: number, kind: string, value: boolean): void {
    if (kind === "MusicPlayback") {
      this.music_since = value ? (this.music_since ?? at) : undefined;
      return;
    }
    const field =
      kind === "NetworkConnection"
        ? "network_connected"
        : "bluetooth_connected";
    if (this[field] === value) return;
    this[field] = value;
    this.connection_expression =
      kind === "NetworkConnection"
        ? value
          ? "NetworkConnected"
          : "NetworkDisconnected"
        : value
          ? "BluetoothConnected"
          : "BluetoothDisconnected";
    this.connection_since = at;
  }
  on_event(event: brain.Event): void {
    const at = max(event.at_ms, this.now_ms);
    this.advance(at);
    const k = event.kind,
      t = typeof k === "string" ? k : k?.type,
      args = typeof k === "object" ? (k.args ?? []) : [],
      source = event.source ?? "";
    const n = typeof args[0] === "number" ? args[0] : 0,
      s = typeof args[0] === "string" ? args[0] : "";
    switch (t) {
      case "NetworkConnection":
      case "BluetoothConnection":
      case "MusicPlayback":
        this.on_business(at, t, args[0] === true);
        break;
      case "Accel":
        if (typeof k === "object")
          this.on_accel(at, k.ax_mg ?? 0, k.ay_mg ?? 0, k.az_mg ?? 0);
        break;
      case "Gyro":
        if (typeof k === "object")
          this.on_gyro(at, k.gx_dps ?? 0, k.gy_dps ?? 0, k.gz_dps ?? 0);
        break;
      case "MagneticEdge":
        if (typeof k === "object") this.on_magnetic_edge(at, k.confidence ?? 0);
        break;
      case "KeyDown":
        this.on_key_down(at, source);
        break;
      case "KeyUp":
        this.on_key_up(at, source);
        break;
      case "ButtonShort":
        this.on_button_short(at, source);
        break;
      case "ButtonLong":
        this.on_button_long(at, source);
        break;
      case "ButtonDouble":
        this.on_button_double(at, source);
        break;
      case "ModuleInserted":
        this.on_module_inserted(at, source, s);
        break;
      case "ModuleRemoved":
        this.on_module_removed(at, source, s);
        break;
      case "TouchPet":
        this.on_touch_pet(at);
        break;
      case "TouchPoke":
        this.on_touch_poke(at);
        break;
      case "LightLevel":
        this.on_light_level(at, n);
        break;
      case "Presence":
        this.on_presence(at, args[0] === true);
        break;
      case "MagneticApproach":
        this.on_magnetic_approach(at);
        break;
      case "MagneticContact":
        this.on_magnetic_contact(at);
        break;
      case "MagneticRelease":
        this.on_magnetic_release(at);
        break;
      case "MagneticOrbit":
        this.on_magnetic_orbit(at);
        break;
      case "BatteryLevel":
        this.on_battery_level(at, n);
        break;
      case "Activity":
        this.on_activity(at, s);
        break;
      default:
        throw new Error("unknown sensor event " + t);
    }
  }
}
type PersonaReaction = "Curious" | "Puzzled" | "Annoyed" | "Angry" | "Petted";
const holds: Record<PersonaReaction, number> = {
  Curious: 1500,
  Puzzled: 1800,
  Annoyed: 2000,
  Angry: 4000,
  Petted: 1800,
};
const faces: Record<PersonaReaction, string> = {
  Curious: "Curious",
  Puzzled: "Puzzled",
  Annoyed: "Confused",
  Angry: "Angry",
  Petted: "Satisfied",
};
const buzz: Partial<Record<PersonaReaction, string>> = {
  Puzzled: "Puzzled",
  Annoyed: "Confused",
  Angry: "Angry",
  Petted: "Satisfied",
};
function half(dt: number, ms: number): number {
  let x = dt / ms,
    scale = 1;
  while (x > 1) {
    scale *= 0.5;
    x--;
  }
  const y = x * 0.6931471805599453;
  return scale / (1 + y + y * y * 0.5);
}
export interface PersonaOutput {
  type: "PersonaOutput";
  expression: string | undefined;
  reaction: PersonaReaction | undefined;
  haptic: string | undefined;
  pulse: number;
  look_x: number;
  pet: number;
  lean_x: number;
}
export class Personality {
  now_ms: number;
  phase = "Idle";
  press_start_ms = 0;
  press_x = 0;
  press_y = 0;
  last_x = 0;
  last_y = 0;
  press_travel = 0;
  look_x = 0;
  petting = false;
  stroke = 0;
  pet = 0;
  lean_x = 0;
  eased_ms: number;
  tap_times: number[] = [];
  angry_cooldown_until = 0;
  ignore_until_ms = 0;
  pending: { reaction: PersonaReaction; at_ms: number } | undefined;
  active: { reaction: PersonaReaction; ends_ms: number } | undefined;
  haptic_pending: string | undefined;
  pulse_start_ms: number | undefined;
  constructor(now: number) {
    this.now_ms = now;
    this.eased_ms = now;
  }
  ignore_until(at: number): void {
    this.ignore_until_ms = max(this.ignore_until_ms, at);
    if (this.phase !== "Idle") {
      this.phase = "Idle";
      this.pending = undefined;
      this.petting = false;
    }
  }
  accepts(at: number): boolean {
    return at >= this.ignore_until_ms;
  }
  start_petting(): void {
    this.petting = true;
    this.pending = undefined;
    this.tap_times = [];
    this.active = { reaction: "Petted", ends_ms: Number.MAX_SAFE_INTEGER };
    this.haptic_pending = "Satisfied";
  }
  expire(now: number): void {
    const p = this.pending;
    if (p && now >= p.at_ms) {
      this.pending = undefined;
      this.active = { reaction: p.reaction, ends_ms: now + holds[p.reaction] };
      this.haptic_pending = buzz[p.reaction];
      if (p.reaction === "Angry") this.angry_cooldown_until = now + 6000;
    }
    if (this.active && now >= this.active.ends_ms) this.active = undefined;
  }
  track_press_move(x: number, y: number): void {
    const moved = abs(x - this.last_x) + abs(y - this.last_y);
    if (moved > 2) {
      this.press_travel = min(2147483647, this.press_travel + moved);
      if (this.petting) this.stroke = min(1, this.stroke + moved * 0.02);
      this.last_x = x;
      this.last_y = y;
    }
  }
  register_tap(at: number): void {
    window(this.tap_times, at, 2500, 8);
    const count = this.tap_times.length,
      frantic = this.tap_times.filter((t) => sub(at, t) <= 1200).length;
    const r: PersonaReaction =
      frantic >= 5
        ? at >= this.angry_cooldown_until
          ? "Angry"
          : "Annoyed"
        : count === 1
          ? "Curious"
          : count === 2
            ? "Puzzled"
            : "Annoyed";
    if (this.active?.reaction === "Angry") return;
    this.pending = { reaction: r, at_ms: at + (count === 1 ? 220 : 380) };
    this.pulse_start_ms = at;
  }
  on_pointer(s: brain.Event): PersonaOutput {
    const at = max(s.at_ms, this.now_ms);
    this.now_ms = at;
    if (at < this.ignore_until_ms) return this.output();
    this.expire(at);
    const x = s.x ?? 0,
      y = s.y ?? 0;
    if (s.pressed) {
      if (this.phase === "Idle") {
        this.phase = "Pressed";
        this.press_start_ms = at;
        this.press_x = x;
        this.press_y = y;
        this.last_x = x;
        this.last_y = y;
        this.press_travel = 0;
        this.petting = false;
        this.pulse_start_ms = at;
      } else {
        this.track_press_move(x, y);
        if (
          !this.petting &&
          (this.press_travel >= 40 || sub(at, this.press_start_ms) >= 450)
        )
          this.start_petting();
      }
    } else if (this.phase === "Pressed") {
      this.track_press_move(x, y);
      this.last_x = x;
      this.last_y = y;
      const held = sub(at, this.press_start_ms);
      this.phase = "Idle";
      if (this.petting) {
        this.petting = false;
        this.active = { reaction: "Petted", ends_ms: at + 1800 };
      } else if (held <= 320 && this.press_travel <= 14) this.register_tap(at);
    }
    return this.output();
  }
  tick(now: number): PersonaOutput {
    now = max(now, this.now_ms);
    this.now_ms = now;
    this.expire(now);
    let target = 0;
    if (this.phase !== "Idle") {
      const dx = this.last_x - 240,
        dy = this.last_y - 240,
        a = abs(dx),
        b = abs(dy),
        len = max(a, b) + floor(min(a, b) / 2);
      target = (dx / max(1, len)) * 7;
    }
    this.look_x += (target - this.look_x) * 0.25;
    if (
      this.phase === "Pressed" &&
      !this.petting &&
      sub(now, this.press_start_ms) >= 450
    )
      this.start_petting();
    const dt = min(sub(now, this.eased_ms), 200);
    this.eased_ms = now;
    this.stroke *= half(dt, 180);
    let squash = 0,
      lean = 0;
    if (this.petting && this.phase === "Pressed") {
      squash = min(1, 0.35 + this.stroke);
      lean = max(-6, min(6, (this.last_x - this.press_x) * 0.06));
    }
    const k = 1 - half(dt, 60);
    this.pet += (squash - this.pet) * k;
    this.lean_x += (lean - this.lean_x) * k;
    if (this.pet < 0.01 && squash === 0) this.pet = 0;
    if (abs(this.lean_x) < 0.05 && lean === 0) this.lean_x = 0;
    return this.output();
  }
  output(): PersonaOutput {
    let pulse = 0;
    if (this.pulse_start_ms !== undefined) {
      const elapsed = sub(this.now_ms, this.pulse_start_ms);
      if (elapsed < 280) {
        const t = elapsed / 280;
        pulse = t < 0.15 ? t / 0.15 : (1 - t) / 0.85;
      }
    }
    const r = this.active?.reaction,
      h = this.haptic_pending;
    this.haptic_pending = undefined;
    return {
      type: "PersonaOutput",
      expression: r ? faces[r] : undefined,
      reaction: r,
      haptic: h,
      pulse,
      look_x: this.look_x,
      pet: this.pet,
      lean_x: this.lean_x,
    };
  }
}
export function create(now: number): {
  on_event: (e: brain.Event) => boolean | void;
  tick: (now: number) => void;
} {
  const a = new Affect(now),
    p = new Personality(now);
  let pointer_down = false,
    haptics: string[] = [],
    persona = p.output();
  let lastExpression: string | undefined;
  let lastVisual: [number, number, number, number] | undefined;
  function add(h: string | undefined): void {
    if (h) {
      haptics.push(h);
      if (haptics.length > 2) haptics.splice(1, 1);
    }
  }
  function publish(at: number): void {
    const state = a.snapshot_at(at),
      affect = state.expression;
    const expression =
      affect === "Error" || affect === "Panic"
        ? affect
        : (persona.expression ?? affect);
    if (expression !== lastExpression) {
      brain.setExpression(expression);
      lastExpression = expression;
    }
    if (
      !lastVisual ||
      persona.look_x !== lastVisual[0] ||
      persona.pulse !== lastVisual[1] ||
      persona.pet !== lastVisual[2] ||
      persona.lean_x !== lastVisual[3]
    ) {
      brain.visual(persona.look_x, persona.pulse, persona.pet, persona.lean_x);
      lastVisual = [persona.look_x, persona.pulse, persona.pet, persona.lean_x];
    }
  }
  return {
    on_event(e: brain.Event): boolean | void {
      if (e.type === "PointerSample") {
        const press = e.pressed && !pointer_down;
        pointer_down = e.pressed ?? false;
        if (press && a.on_screen_touch(e.at_ms)) {
          p.ignore_until(e.at_ms + 3000);
          publish(e.at_ms);
          return true;
        }
        if (!p.accepts(e.at_ms)) return false;
        persona = p.on_pointer(e);
        add(persona.haptic);
        publish(e.at_ms);
        return true;
      } else if (e.type === "Interaction") {
        pointer_down = false;
        a.on_interaction(e.at_ms);
        publish(e.at_ms);
      } else if (e.type === "IgnoreTouch") p.ignore_until(e.at_ms);
      else {
        a.on_event(e);
        publish(e.at_ms);
      }
    },
    tick(now: number): void {
      persona = p.tick(now);
      add(persona.haptic);
      const t = a.tick(now);
      add(t.haptic);
      publish(now);
      let best: string | undefined;
      for (const h of haptics)
        if (!best || priority(h) > priority(best)) best = h;
      haptics = [];
      if (best) brain.haptic(best);
      if (t.command) brain.command(t.command);
    },
  };
}
