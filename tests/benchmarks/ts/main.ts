import * as system from "@dango/sdk/system";

const MOD = 1000000007;
function integer(unit: number): number {
  let state = unit + 1;
  for (let i = 0; i < 128; i++) state = (state * 48271) % 2147483647;
  return state % MOD;
}
function mandelbrot(unit: number): number {
  let checksum = 0;
  for (let pixel = 0; pixel < 2; pixel++) {
    const index = (unit * 2 + pixel) % 16384;
    const cx = (index % 128) * (3.5 / 127) - 2.5;
    const cy = Math.floor(index / 128) * (2.0 / 127) - 1.0;
    let zr = 0.0, zi = 0.0, count = 0;
    while (count < 64 && zr * zr + zi * zi <= 4.0) {
      const nextR = zr * zr - zi * zi + cx;
      zi = 2.0 * zr * zi + cy;
      zr = nextR;
      count++;
    }
    checksum += count * (pixel * 64 + 1);
  }
  return checksum;
}
function primes(unit: number): number {
  let checksum = 0;
  for (let offset = 0; offset < 8; offset++) {
    const n = 10001 + (unit % 4096) * 16 + offset * 2;
    let divisor = 3, prime = true;
    while (divisor * divisor <= n) {
      if (n % divisor === 0) { prime = false; break; }
      divisor += 2;
    }
    if (prime) checksum += n;
  }
  return checksum;
}
const a: number[] = [], b: number[] = [];
for (let i = 0; i < 144; i++) {
  a.push(((i * 17 + 3) % 101) / 32.0);
  b.push(((i * 29 + 7) % 103) / 16.0);
}
function matrix(unit: number): number {
  const row = unit % 12;
  let checksum = 0.0;
  for (let column = 0; column < 12; column++) {
    let value = 0.0;
    for (let k = 0; k < 12; k++) value += (a[row * 12 + k] ?? 0) * (b[k * 12 + column] ?? 0);
    checksum += value * (column + 1);
  }
  return Math.floor(checksum * 512.0);
}
function sort(unit: number): number {
  const values: number[] = [];
  let state = unit + 1;
  for (let i = 0; i < 32; i++) {
    state = (state * 48271) % 2147483647;
    values.push(state % 65536);
  }
  for (let i = 1; i < 32; i++) {
    const value = values[i] ?? 0;
    let j = i - 1;
    while (j >= 0 && (values[j] ?? 0) > value) {
      values[j + 1] = values[j] ?? 0;
      j--;
    }
    values[j + 1] = value;
  }
  let checksum = 0;
  for (let i = 0; i < 32; i++) checksum += (values[i] ?? 0) * (i + 1);
  return checksum;
}
interface Particle { x: number; y: number; vx: number; vy: number }
function objects(unit: number): number {
  const particles: Particle[] = [];
  for (let i = 0; i < 16; i++)
    particles.push({x: (unit + i) % 97, y: (unit * 3 + i) % 89, vx: (i % 7) - 3, vy: (i % 5) - 2});
  for (let step = 0; step < 4; step++) {
    for (let i = 0; i < 16; i++) {
      const p = particles[i];
      if (p === undefined) throw new Error("missing particle");
      particles[i] = {x: p.x + p.vx, y: p.y + p.vy, vx: p.vx, vy: p.vy};
    }
  }
  let checksum = 0;
  for (let i = 0; i < 16; i++) {
    const p = particles[i];
    if (p === undefined) throw new Error("missing particle");
    checksum += (p.x + 128) * (p.y + 128) * (i + 1);
  }
  return checksum;
}
function number(value: unknown, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high)
    throw new Error("invalid benchmark number");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("missing benchmark identity");
  return value;
}
function vector(value: unknown): number[] {
  if (!system.isArray(value) || value.length !== 6) throw new Error("six workloads required");
  const result: number[] = [];
  for (const item of value) result.push(number(item, 0, MOD - 1));
  return result;
}
let eventId = 0;
function emit(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("missing benchmark event");
  eventId++;
  const total = Math.ceil(encoded.length / 64);
  for (let part = 1; part <= total; part++)
    system.print("DANGO_BENCH_PART " + eventId + "/" + part + "/" + total + " " +
      encoded.slice((part - 1) * 64, part * 64));
}
export async function main(): Promise<void> {
  const suite = text(system.argument("suite"));
  if (suite !== "script-engines-v1") throw new Error("build the benchmark payload first");
  const profile = text(system.argument("profile")), fingerprint = text(system.argument("fingerprint"));
  const runId = text(system.argument("run_id"));
  const samples = number(system.argument("samples"), 1, 9);
  const yieldEvery = number(system.argument("yield_every"), 1, 32);
  const units = vector(system.argument("units")), expected = vector(system.argument("expected"));
  for (const value of units) number(value, 1, 1000000);
  const names = ["integer", "mandelbrot", "primes", "matrix", "sort", "objects"];
  const kernels = [integer, mandelbrot, primes, matrix, sort, objects];
  emit({event: "start", engine: "ts", suite, profile, fingerprint,
    run_id: runId, samples, warmup: 1, yield_every: yieldEvery, units});
  for (let i = 0; i < 6; i++) {
    const kernel = kernels[i], count = units[i], expectedValue = expected[i], name = names[i];
    if (kernel === undefined || count === undefined || expectedValue === undefined || name === undefined)
      throw new Error("missing workload");
    for (let sample = -1; sample < samples; sample++) {
      if (sample >= 0) emit({event: "begin", case: name, sample, units: count});
      const started = system.nowMs();
      let checksum = 0;
      for (let unit = 0; unit < count; unit++) {
        checksum = (checksum + kernel(unit)) % MOD;
        if ((unit + 1) % yieldEvery === 0) await system.sleep(0);
      }
      const elapsed = system.nowMs() - started;
      if (checksum !== expectedValue) throw new Error("checksum mismatch: " + name);
      emit({event: sample < 0 ? "warmup" : "sample", case: name,
        sample, units: count, checksum, elapsed_ms: elapsed});
    }
  }
  emit({event: "done", samples: samples * 6});
}
