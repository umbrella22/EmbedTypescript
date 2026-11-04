// Procedural Flappy Flight TS port. See LICENSE and SOURCE.json.
import { open, rgb } from "@dango/sdk/display";
import { Button } from "@dango/sdk/hardware";
import { nowMs, sleep, print, argument } from "@dango/sdk/system";
import {
  at,
  numberArg,
  stringArg,
  clamp,
  Random,
  centered,
} from "@dango/sdk/game";
const shapes = {
  tail_top_outer: [
    -26, -10, -36, -22, -31, -24, -21, -18, -14, -8, -20, -2, -34, -4,
  ],
  tail_top_inner: [
    -26, -11, -34, -21, -30, -22, -21, -17, -16, -8, -21, -4, -32, -6,
  ],
  tail_bottom_outer: [
    -26, 14, -36, 8, -30, 6, -16, 8, -14, 16, -22, 23, -33, 20,
  ],
  tail_bottom_inner: [
    -26, 14, -34, 10, -29, 8, -18, 10, -16, 16, -23, 20, -32, 18,
  ],
  crest: [2, -29, -5, -30, 0, -34, 7, -32, 13, -25, 9, -21, -1, -22],
  body_outer: [
    0, 0, -24, -10, -12, -22, 8, -24, 22, -18, 28, -8, 28, 8, 18, 20, 2, 24,
    -16, 20, -25, 8,
  ],
  body_inner: [
    0, -2, -22, -10, -10, -20, 8, -22, 20, -16, 26, -7, 26, 6, 16, 17, 2, 21,
    -14, 17, -23, 6,
  ],
  breast: [11, 14, -5, 10, 12, 5, 26, 4, 18, 17, 3, 21, -7, 17],
  wing_outer: [-18, 0, -25, -10, -14, -8, -6, 3, -14, 13, -25, 8],
  wing_inner: [-19, -1, -23, -8, -15, -6, -9, 2, -15, 9, -23, 6],
  beak_top: [32, -4, 22, -7, 34, -8, 40, -4, 34, 1, 22, 2],
  beak_bottom: [31, 7, 22, 2, 34, 2, 38, 7, 32, 11, 22, 9],
};
interface Pipe {
  x: number;
  gap_top: number;
  gap_bottom: number;
  scored: boolean;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  ttl: number;
  color: number;
}
export class Flight {
  state: "title" | "playing" | "crashed" = "title";
  score = 0;
  best = 0;
  y: number;
  vy = 0;
  spawn = 0;
  lastGap: number | undefined;
  pipes: Pipe[] = [];
  particles: Particle[] = [];
  constructor(
    readonly width: number,
    readonly bottom: number,
    readonly x: number,
    private random: Random,
  ) {
    this.y = Math.floor(bottom * 0.68);
    this.reset("title");
  }
  pipe(x: number): Pipe {
    const gap = Math.max(112, 126 - Math.min(this.score, 14)),
      lo = 58,
      hi = this.bottom - gap - 58,
      base =
        this.lastGap === undefined
          ? lo + this.random.int(0, Math.max(0, hi - lo))
          : this.lastGap + this.random.int(-32, 32),
      top = clamp(Math.floor(clamp(base, lo, hi) / 8) * 8, lo, hi);
    this.lastGap = top;
    return { x, gap_top: top, gap_bottom: top + gap, scored: false };
  }
  reset(state: "title" | "playing"): void {
    this.score = 0;
    this.state = state;
    this.y = Math.floor(this.bottom * (state === "title" ? 0.68 : 0.56));
    this.vy = 0;
    this.spawn = 0;
    this.lastGap = undefined;
    this.particles = [];
    this.pipes = [
      this.pipe(state === "title" ? this.width - 46 - 18 : this.width + 84),
    ];
  }
  add(count: number, burst: boolean): void {
    for (let i = 0; i < count; i++)
      this.particles.push({
        x: this.x - 24 + this.random.int(-3, 4),
        y: this.y + this.random.int(-7, 7),
        vx: this.random.int(-18, burst ? 14 : -8) / 10,
        vy: this.random.int(burst ? -18 : -8, burst ? 18 : 8) / 10,
        r: this.random.int(2, 4),
        ttl: burst ? 16 : 10,
        color: rgb(this.random.int(0, 1) === 0 ? 0xf1a604 : 0xffe948),
      });
  }
  press(): void {
    if (this.state !== "playing") this.reset("playing");
    this.vy = -7.4;
    this.add(4, false);
  }
  crash(): void {
    if (this.state === "crashed") return;
    this.best = Math.max(this.best, this.score);
    this.add(10, true);
    this.state = "crashed";
  }
  hit(rx: number, ry: number, rw: number, rh: number): boolean {
    const cx = this.x + 3,
      dx = cx - clamp(cx, rx, rx + rw),
      dy = this.y - clamp(this.y, ry, ry + rh);
    return dx * dx + dy * dy <= 17 * 17;
  }
  update(): void {
    if (this.state === "playing") {
      this.vy += 0.82;
      this.y += this.vy;
      this.spawn += 33;
      if (this.spawn >= 1750) {
        this.spawn -= 1750;
        this.pipes.push(this.pipe(this.width + 54));
      }
      for (const p of this.pipes) {
        p.x -= 3.15 + Math.min(this.score * 0.04, 1);
        if (!p.scored && p.x + 46 < this.x) {
          p.scored = true;
          this.score++;
          this.best = Math.max(this.best, this.score);
        }
        if (
          this.hit(p.x - 5, 0, 56, p.gap_top) ||
          this.hit(p.x - 5, p.gap_bottom, 56, this.bottom - p.gap_bottom)
        )
          this.crash();
      }
      this.pipes = this.pipes.filter((p) => p.x + 46 >= -4);
      if (this.y - 17 <= 0 || this.y + 17 >= this.bottom) this.crash();
    }
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;
      p.ttl--;
    }
    this.particles = this.particles.filter((p) => p.ttl > 0);
  }
}
export async function main(): Promise<void> {
  const screen = open();
  let button: Button | undefined;
  try {
    const info = screen.info(),
      w = info.width,
      h = info.height,
      bottom = h - 42,
      x = Math.floor(w * 0.26),
      duration = numberArg("run_time_ms", 180000),
      random = new Random(nowMs() + w + h),
      mode = stringArg(
        "input_mode",
        typeof argument("pin") === "number" ||
          typeof argument("button_gpio") === "number"
          ? "button"
          : "touch",
      );
    if (mode === "button")
      button = new Button(
        numberArg("pin", numberArg("button_gpio", 7)),
        numberArg("active_level", 0),
      );
    const game = new Flight(w, bottom, x, random),
      clouds = Array.from({ length: 3 }, () => ({
        x: random.int(0, w),
        y: random.int(30, 100),
        size: random.int(14, 24),
        speed: random.int(3, 8) / 10,
      }));
    let frame = 0,
      wasDown = false;
    const bs = (n: number): number =>
      n >= 0 ? Math.floor(n * 0.82 + 0.5) : Math.ceil(n * 0.82 - 0.5);
    async function fan(
      shape: number[],
      color: number,
      shift: number = 0,
    ): Promise<void> {
      for (let i = 2; i < shape.length; i += 2) {
        const next = i + 2 >= shape.length ? 2 : i + 2;
        screen.fillTriangle(
          bs(at(shape, 0)),
          bs(at(shape, 1) + shift),
          bs(at(shape, i)),
          bs(at(shape, i + 1) + shift),
          bs(at(shape, next)),
          bs(at(shape, next + 1) + shift),
          color,
        );
        if (i % 4 === 0) await sleep(0);
      }
    }
    async function bird(): Promise<void> {
      const wing = Math.floor(frame / 3) % 4 < 2 ? -3 : 3;
      screen.save();
      screen.translate(
        x,
        Math.floor(game.y) +
          (game.state === "title" ? Math.floor(Math.sin(frame * 0.14) * 4) : 0),
      );
      await fan(shapes.tail_top_outer, rgb(0xf1a604));
      await fan(shapes.tail_top_inner, rgb(0xffe948));
      await fan(shapes.tail_bottom_outer, rgb(0xf1a604));
      await fan(shapes.tail_bottom_inner, rgb(0xffe948));
      await fan(shapes.crest, rgb(0xf1a604));
      await fan(shapes.body_outer, rgb(0xf1a604));
      await fan(shapes.body_inner, rgb(0xffd708));
      screen.fillCircle(bs(12), bs(-8), bs(16), rgb(0xf1a604));
      screen.fillCircle(bs(12), bs(-9), bs(14), rgb(0xffd708));
      await sleep(0);
      await fan(shapes.breast, rgb(0xfff179));
      await fan(shapes.wing_outer, rgb(0xf1a604), wing);
      screen.fillCircle(bs(-20), bs(-1 + wing), bs(8), rgb(0xf1a604));
      await fan(shapes.wing_inner, rgb(0xffe948), wing);
      screen.fillCircle(bs(-19), bs(-2 + wing), bs(5), rgb(0xffe948));
      await fan(shapes.beak_top, rgb(0xff7741));
      await fan(shapes.beak_bottom, rgb(0xf4522d));
      screen.fillTriangle(
        bs(22),
        bs(1),
        bs(35),
        bs(2),
        bs(22),
        bs(5),
        rgb(0x751b27),
      );
      screen.fillRoundRect(
        bs(10),
        bs(-18),
        bs(14),
        bs(20),
        bs(7),
        rgb(0xfafaef),
      );
      await sleep(0);
      screen.fillRoundRect(
        bs(18),
        bs(-14),
        bs(6),
        bs(14),
        bs(3),
        rgb(0x4cbeda),
      );
      screen.fillRoundRect(bs(21), bs(-10), bs(5), bs(9), bs(2), rgb(0x1c1718));
      screen.fillRect(bs(21), bs(-11), bs(3), bs(3), rgb(0xfafaef));
      screen.restore();
    }
    async function pipe(p: Pipe): Promise<void> {
      const x = Math.floor(p.x),
        top = p.gap_top,
        by = p.gap_bottom;
      for (const [y, height] of [
        [-8, top + 8],
        [by, bottom - by + 8],
      ]) {
        if (typeof y !== "number" || typeof height !== "number") continue;
        screen.fillRoundRect(x, y, 46, height, 8, rgb(0x0e5b44));
        screen.fillRoundRect(
          x + 2,
          y + 2,
          42,
          Math.max(0, height - 4),
          6,
          rgb(0x2ab568),
        );
        screen.fillRect(
          x + 37,
          Math.max(0, y + 8),
          7,
          Math.max(0, height - 16),
          rgb(0x177b4e),
        );
        screen.fillRoundRect(
          x + 6,
          Math.max(0, y + 8),
          5,
          Math.max(0, height - 24),
          2,
          rgb(0x7ae79e),
        );
        await sleep(0);
      }
      screen.fillRoundRect(x - 5, top - 16, 56, 16, 6, rgb(0x0e5b44));
      screen.fillRoundRect(x - 3, top - 14, 52, 12, 4, rgb(0x41d37e));
      screen.fillRoundRect(x - 5, by, 56, 16, 6, rgb(0x0e5b44));
      screen.fillRoundRect(x - 3, by + 2, 52, 12, 4, rgb(0x41d37e));
    }
    async function render(): Promise<void> {
      screen.begin(rgb(0x8bd8ea));
      await sleep(0);
      screen.fillRect(
        0,
        Math.floor(bottom * 0.56),
        w,
        bottom - Math.floor(bottom * 0.56),
        rgb(0xbce6d0),
      );
      screen.fillCircle(w - 46, 48, 25, rgb(0xffe79b));
      await sleep(0);
      for (const c of clouds) {
        const cx = Math.floor((frame * c.speed + c.x) % (w + 64)) - 32;
        screen.fillCircle(cx, c.y, c.size, rgb(0xf7faf0));
        screen.fillCircle(
          cx + c.size,
          c.y - 3,
          Math.floor(c.size * 0.82),
          rgb(0xf7faf0),
        );
        await sleep(0);
        screen.fillRoundRect(
          cx,
          c.y - Math.floor(c.size * 0.45),
          c.size * 2,
          c.size,
          Math.floor(c.size * 0.45),
          rgb(0xf7faf0),
        );
      }
      screen.fillTriangle(
        0,
        bottom,
        Math.floor(w * 0.18),
        bottom - 50,
        Math.floor(w * 0.42),
        bottom,
        rgb(0x64bfaa),
      );
      await sleep(0);
      screen.fillTriangle(
        Math.floor(w * 0.24),
        bottom,
        Math.floor(w * 0.52),
        bottom - 68,
        Math.floor(w * 0.82),
        bottom,
        rgb(0x52b2a0),
      );
      await sleep(0);
      screen.fillRect(0, bottom, w, 42, rgb(0x5fbc67));
      screen.fillRect(0, bottom + 10, w, 32, rgb(0xd7ac65));
      await sleep(0);
      for (let xx = 0; xx <= w + 18; xx += 36) {
        screen.fillRoundRect(
          xx - ((frame * 2) % 36),
          bottom + 21,
          18,
          5,
          2,
          rgb(0xefc163),
        );
        if (xx % 144 === 0) await sleep(0);
      }
      for (const p of game.pipes) {
        await pipe(p);
        await sleep(0);
      }
      for (const p of game.particles) {
        screen.fillCircle(Math.floor(p.x), Math.floor(p.y), p.r, p.color);
        await sleep(0);
      }
      await bird();
      await sleep(0);
      screen.fillRoundRect(12, 12, 130, 50, 8, rgb(0xfaf7e9));
      centered(
        screen,
        12,
        12,
        130,
        22,
        "BEST  " + game.best,
        12,
        rgb(0x2d5847),
      );
      centered(screen, 12, 33, 130, 24, String(game.score), 20, rgb(0x1d513c));
      if (game.state !== "playing") {
        const pw = Math.min(w - 24, 330),
          py = Math.floor(h * 0.29);
        screen.fillRoundRect(
          Math.floor((w - pw) / 2),
          py,
          pw,
          110,
          12,
          rgb(0xfff7df),
        );
        centered(
          screen,
          0,
          py + 10,
          w,
          32,
          game.state === "title" ? "FLAPPY FLIGHT" : "ROUND OVER",
          24,
          rgb(game.state === "title" ? 0x2f8c6a : 0xd95744),
        );
        centered(
          screen,
          0,
          py + 47,
          w,
          22,
          game.state === "title"
            ? "THREAD THE GATES"
            : `SCORE ${game.score} / BEST ${game.best}`,
          16,
          rgb(0x3e6354),
        );
        centered(
          screen,
          0,
          py + 79,
          w,
          20,
          mode === "button" ? "PRESS TO FLY" : "TAP TO FLY",
          16,
          rgb(0x5b7a69),
        );
      }
      await screen.present();
    }
    print(`[flappybird] ready screen=${w}x${h} run_ms=${duration}`);
    const start = nowMs();
    while (nowMs() - start < duration) {
      const down = button
        ? button.level() === button.active
        : screen.touch().length > 0;
      if (down && !wasDown) game.press();
      wasDown = down;
      game.update();
      await render();
      frame++;
      await sleep(33);
    }
  } finally {
    button?.close();
    screen.close();
  }
  print("[flappybird] done");
}
