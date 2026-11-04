// Procedural Dino Dash, ported from main.lua. See package LICENSE/SOURCE.json.
import { open, rgb, color } from "@dango/sdk/display";
import { Button } from "@dango/sdk/hardware";
import { nowMs, sleep, print, argument } from "@dango/sdk/system";
import {
  at,
  numberArg,
  boolArg,
  stringArg,
  clamp,
  Random,
  centered,
} from "@dango/sdk/game";
interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: number;
  scored: boolean;
}
export class Runner {
  y: number;
  vy = 0;
  grounded = true;
  over = false;
  score = 0;
  best = 0;
  speed: number;
  scroll = 0;
  spawn = 160;
  animation = 0;
  obstacles: Obstacle[] = [];
  constructor(
    readonly ground: number,
    readonly dh: number,
    readonly dw: number,
    readonly dx: number,
    readonly width: number,
    readonly gravity: number,
    readonly jump: number,
    readonly initialSpeed: number,
    readonly maximumSpeed: number,
    readonly acceleration: number,
    readonly spawnMin: number,
    readonly spawnMax: number,
    private random: Random,
  ) {
    this.y = ground - dh;
    this.speed = initialSpeed;
  }
  reset(): void {
    this.y = this.ground - this.dh;
    this.vy = 0;
    this.grounded = true;
    this.over = false;
    this.score = 0;
    this.speed = this.initialSpeed;
    this.scroll = 0;
    this.spawn = 160;
    this.animation = 0;
    this.obstacles = [];
  }
  press(): void {
    if (this.over) this.reset();
    else if (this.grounded) {
      this.vy = this.jump;
      this.grounded = false;
    }
  }
  step(df: number): void {
    this.animation += df;
    if (this.over) return;
    this.speed = clamp(
      this.speed + this.acceleration * df,
      this.initialSpeed,
      this.maximumSpeed,
    );
    if (!this.grounded) {
      this.vy += this.gravity * df;
      this.y += this.vy * df;
      if (this.y >= this.ground - this.dh) {
        this.y = this.ground - this.dh;
        this.vy = 0;
        this.grounded = true;
      }
    }
    const sv = this.speed * df;
    this.scroll += sv;
    for (const o of this.obstacles) {
      o.x -= sv;
      if (!o.scored && o.x + o.w < this.dx) {
        o.scored = true;
        this.score++;
        this.best = Math.max(this.best, this.score);
      }
    }
    this.obstacles = this.obstacles.filter((o) => o.x + o.w >= -24);
    this.spawn -= sv;
    if (this.spawn <= 0) {
      const kind = this.random.int(1, 3),
        w = this.random.int(
          kind === 1 ? 14 : kind === 2 ? 24 : 38,
          kind === 1 ? 18 : kind === 2 ? 34 : 48,
        ),
        h = this.random.int(
          kind === 1 ? 28 : kind === 2 ? 24 : 20,
          kind === 1 ? 42 : kind === 2 ? 38 : 30,
        );
      this.obstacles.push({
        x: this.width + 6,
        y: this.ground - h,
        w,
        h,
        kind,
        scored: false,
      });
      this.spawn = this.random.int(this.spawnMin, this.spawnMax);
    }
    const x1 = this.dx + Math.floor(this.dw * 0.18),
      y1 = this.y + Math.floor(this.dh * 0.2),
      x2 = this.dx + this.dw - Math.floor(this.dw * 0.18),
      y2 = this.y + this.dh - Math.floor(this.dh * 0.12);
    if (
      this.obstacles.some(
        (o) =>
          x1 < o.x + o.w - 2 && x2 > o.x + 2 && y1 < o.y + o.h && y2 > o.y + 2,
      )
    )
      this.over = true;
  }
}
export async function main(): Promise<void> {
  const screen = open();
  let button: Button | undefined;
  try {
    const info = screen.info(),
      w = info.width,
      h = info.height,
      frame = Math.floor(numberArg("frame_ms", 33, 16, 1000)),
      duration = numberArg("run_ms", 0),
      scale = numberArg(
        "scale",
        stringArg("preset", "classic") === "mini_blue"
          ? 0.85
          : stringArg("preset", "classic") === "big_orange"
            ? 1.25
            : 1,
        0.7,
        1.6,
      ),
      dw = Math.floor(48 * scale + 0.5),
      dh = Math.floor(44 * scale + 0.5),
      dx = Math.floor(numberArg("dino_x", 34)),
      ground =
        h -
        Math.floor(
          numberArg("ground_margin", clamp(Math.floor(h * 0.11), 22, 34)),
        ),
      top = Math.floor(
        numberArg("top_safe", clamp(Math.floor(h * 0.12), 18, 30)),
      ),
      font = Math.floor(
        numberArg("font_size", clamp(Math.floor(h / 12), 14, 24), 12, 40),
      ),
      random = new Random(nowMs() + w + h);
    const mode = stringArg("input_mode", "auto"),
      touch = boolArg("enable_touch", mode !== "button");
    if (
      boolArg(
        "enable_button",
        mode === "button" ||
          mode === "both" ||
          typeof argument("button_gpio") === "number",
      )
    )
      button = new Button(
        numberArg("button_gpio", numberArg("key_gpio", 7)),
        numberArg("button_active_level", numberArg("key_active_level", 0)),
        numberArg("button_long_press_ms", 1500),
        numberArg("button_short_press_ms", 180),
      );
    const runner = new Runner(
      ground,
      dh,
      dw,
      dx,
      w,
      numberArg("gravity", 0.42),
      numberArg("jump_v", -10),
      numberArg("scroll_v0", 2.1),
      numberArg("scroll_max", 3.4),
      numberArg("scroll_acc", 0.0003),
      Math.floor(numberArg("spawn_min", 175)),
      Math.floor(numberArg("spawn_max", 300)),
      random,
    );
    const sky = rgb(0xf7f4eb),
      ink = rgb(0x232f2b),
      card = rgb(0xfffcf4);
    let body = rgb(0x535353);
    const palette = new Map<string, number>([
      ["gray", 0x535353],
      ["green", 0x37b950],
      ["red", 0xdc4632],
      ["blue", 0x4691eb],
      ["purple", 0x965fdc],
      ["orange", 0xf58723],
    ]);
    body = rgb(
      palette.get(
        stringArg(
          "color",
          stringArg("preset", "classic") === "mini_blue"
            ? "blue"
            : stringArg("preset", "classic") === "big_orange"
              ? "orange"
              : "gray",
        ),
      ) ?? 0x535353,
    );
    const custom = argument("body_color");
    if (
      custom &&
      typeof custom === "object" &&
      "r" in custom &&
      "g" in custom &&
      "b" in custom &&
      typeof custom.r === "number" &&
      typeof custom.g === "number" &&
      typeof custom.b === "number"
    )
      body = color(
        Math.floor(clamp(custom.r, 0, 255)),
        Math.floor(clamp(custom.g, 0, 255)),
        Math.floor(clamp(custom.b, 0, 255)),
      );
    const gulls = Array.from({ length: 4 }, () => ({
        x: random.int(0, w),
        y: random.int(24, 78),
        s: random.int(10, 18),
        v: random.int(18, 36) / 100,
      })),
      decor = Array.from({ length: 8 }, () => ({
        x: random.int(0, w * 2),
        t: random.int(0, 2),
      }));
    async function dino(): Promise<void> {
      const x = dx,
        y = Math.floor(runner.y),
        sz = (n: number): number => Math.max(1, Math.floor(n * scale + 0.5));
      function block(
        px: number,
        py: number,
        pw: number,
        ph: number,
        c: number = body,
      ): void {
        screen.fillRect(
          x + Math.floor(px * scale + 0.5),
          y + Math.floor(py * scale + 0.5),
          sz(pw),
          sz(ph),
          c,
        );
      }
      let blocks = 0;
      for (const b of [
        [0, 18, 3, 11],
        [3, 22, 5, 8],
        [8, 25, 6, 7],
        [14, 28, 6, 6],
        [10, 23, 20, 11],
        [15, 18, 17, 12],
        [20, 14, 12, 10],
        [24, 11, 8, 7],
        [28, 4, 8, 19],
        [31, 0, 18, 12],
        [34, 12, 15, 7],
        [40, 19, 8, 2],
        [31, 24, 8, 3],
        [38, 27, 3, 4],
        [18, 32, 14, 4],
      ]) {
        block(at(b, 0), at(b, 1), at(b, 2), at(b, 3));
        if (++blocks % 4 === 0) await sleep(0);
      }
      block(34, 4, 3, 3, sky);
      block(41, 12, 8, 4, sky);
      const leg = runner.grounded ? Math.floor(runner.animation / 4) % 2 : 2;
      for (const b of leg === 0
        ? [
            [14, 35, 5, 8],
            [11, 42, 8, 2],
            [27, 35, 4, 6],
            [27, 40, 7, 2],
          ]
        : leg === 1
          ? [
              [14, 35, 4, 6],
              [14, 40, 7, 2],
              [27, 35, 5, 8],
              [27, 42, 8, 2],
            ]
          : [
              [15, 35, 4, 7],
              [27, 35, 4, 7],
            ])
        block(at(b, 0), at(b, 1), at(b, 2), at(b, 3));
    }
    function cactus(
      x: number,
      base: number,
      height: number,
      width: number,
    ): void {
      screen.fillRoundRect(
        x,
        base - height,
        width,
        height,
        Math.max(1, Math.floor(width / 2)),
        rgb(0x2d7452),
      );
      screen.fillRoundRect(
        x - Math.floor(width * 0.7),
        base - Math.floor(height * 0.65),
        width,
        Math.floor(height * 0.25),
        2,
        rgb(0x2d7452),
      );
      screen.fillRoundRect(
        x + width - 1,
        base - Math.floor(height * 0.8),
        width,
        Math.floor(height * 0.35),
        2,
        rgb(0x569768),
      );
    }
    async function overlay(lines: string[]): Promise<void> {
      const bw = Math.min(
          w - 10,
          Math.max(...lines.map((t) => t.length * font * 0.65)) + 40,
        ),
        bh = lines.length * (font + 8) + 12,
        bx = Math.floor((w - bw) / 2),
        by = Math.floor((h - bh) / 2);
      screen.fillRoundRect(bx, by, Math.floor(bw), bh, 13, card);
      screen.roundRect(bx, by, Math.floor(bw), bh, 13, rgb(0xdacdb5));
      await sleep(0);
      for (let i = 0; i < lines.length; i++) {
        centered(
          screen,
          bx,
          by + 6 + i * (font + 8),
          bw,
          font,
          at(lines, i),
          font,
          ink,
        );
        await sleep(0);
      }
    }
    async function render(): Promise<void> {
      screen.begin(sky);
      await sleep(0);
      screen.fillCircle(w - 48, top + 50, 25, rgb(0xffc452));
      screen.fillCircle(w - 48, top + 50, 17, rgb(0xffd77e));
      await sleep(0);
      screen.fillTriangle(
        0,
        ground,
        Math.floor(w * 0.27),
        ground - 50,
        Math.floor(w * 0.58),
        ground,
        rgb(0xebe2ce),
      );
      await sleep(0);
      screen.fillTriangle(
        Math.floor(w * 0.38),
        ground,
        Math.floor(w * 0.72),
        ground - 58,
        w,
        ground,
        rgb(0xebe2ce),
      );
      await sleep(0);
      screen.fillTriangle(
        0,
        ground,
        Math.floor(w * 0.42),
        ground - 28,
        Math.floor(w * 0.77),
        ground,
        rgb(0xdecfb0),
      );
      for (const g of gulls) {
        const x = Math.floor(g.x),
          y = g.y;
        screen.line(x, y + 8, x + 8, y + 4, rgb(0x707769));
        screen.line(x + 8, y + 4, x + 12, y, rgb(0x707769));
        screen.line(x + 12, y, x + g.s, y, rgb(0x707769));
        screen.line(x + g.s, y, x + g.s + 16, y + 8, rgb(0x707769));
        await sleep(0);
      }
      screen.fillRect(0, ground, w, h - ground, rgb(0xf6e7c7));
      screen.fillRect(0, ground, w, 2, ink);
      await sleep(0);
      for (const d of decor) {
        screen.fillRect(
          Math.floor(d.x),
          ground + 9 + d.t * 4,
          d.t === 0 ? 8 : d.t === 1 ? 3 : 2,
          d.t === 2 ? 2 : 1,
          rgb(0xd8bf91),
        );
        await sleep(0);
      }
      for (const o of runner.obstacles) {
        const x = Math.floor(o.x);
        cactus(
          x,
          ground,
          o.h,
          Math.max(4, Math.floor(o.w / (o.kind === 1 ? 2 : 4))),
        );
        if (o.kind > 1)
          cactus(x + Math.floor(o.w * 0.6), ground, Math.floor(o.h * 0.8), 6);
        await sleep(0);
      }
      await dino();
      await sleep(0);
      for (const [x, title, value, c] of [
        [10, "BEST", runner.best, card],
        [w - 120, "RUN", runner.score, ink],
      ]) {
        if (
          typeof x !== "number" ||
          typeof title !== "string" ||
          typeof value !== "number" ||
          typeof c !== "number"
        )
          continue;
        screen.fillRoundRect(x, top, 110, font + 19, 9, c);
        screen.text(x + 9, top + 4, title, {
          fontSize: Math.max(10, font - 7),
          color: rgb(0x707769),
        });
        screen.text(x + 9, top + 13, String(value).padStart(5, "0"), {
          fontSize: font,
          color: c === ink ? card : ink,
        });
        await sleep(0);
      }
      if (runner.over)
        await overlay([
          "RUN COMPLETE",
          "SCORE  " + String(runner.score).padStart(5, "0"),
          "TAP OR PRESS TO RETRY",
        ]);
      else if (
        runner.score === 0 &&
        runner.grounded &&
        !runner.obstacles.length
      )
        await overlay(["DINO DASH", "TAP OR PRESS TO JUMP"]);
      await screen.present();
    }
    print(`[dino] ready ${w}x${h} run_ms=${duration}`);
    let last = nowMs(),
      wasDown = false;
    const start = last;
    while (duration <= 0 || nowMs() - start < duration) {
      const now = nowMs(),
        df = Math.min(3, Math.max(0, now - last) / frame);
      last = now;
      const down =
        (touch && screen.touch().length > 0) ||
        (button !== undefined && button.level() === button.active);
      if (down && !wasDown) runner.press();
      wasDown = down;
      runner.step(df);
      if (!runner.over) {
        for (const g of gulls) {
          g.x -= g.v * df;
          if (g.x < -12) {
            g.x = w + random.int(0, 80);
            g.y = random.int(24, 78);
          }
        }
        for (const d of decor) {
          d.x -= runner.speed * df * 0.85;
          if (d.x < -12) d.x = w + random.int(30, 200);
        }
      }
      await render();
      await sleep(Math.max(1, frame - (nowMs() - now)));
    }
  } finally {
    button?.close();
    screen.close();
  }
  print("[dino] done");
}
