// TS port of this package's touch puzzle. Original attribution remains in SOURCE.json.
import type { Point } from "@dango/sdk/display";
import { open, rgb } from "@dango/sdk/display";
import { nowMs, sleep, print } from "@dango/sdk/system";
import {
  at,
  numberArg,
  clamp,
  Random,
  centered,
} from "@dango/sdk/game";
export type Direction = "left" | "right" | "up" | "down";
export class Game {
  board: number[] = Array(16).fill(0);
  score = 0;
  best = 0;
  won = false;
  constructor(private random: Random) {
    this.reset();
  }
  reset(): void {
    this.board = Array(16).fill(0);
    this.score = 0;
    this.won = false;
    this.add();
    this.add();
  }
  add(): boolean {
    const empty = this.board
      .map((v, i) => (v === 0 ? i : -1))
      .filter((i) => i >= 0);
    if (!empty.length) return false;
    this.board[at(empty, this.random.int(0, empty.length - 1))] =
      this.random.int(1, 10) === 10 ? 4 : 2;
    return true;
  }
  hasMoves(): boolean {
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const v = at(this.board, y * 4 + x);
        if (
          !v ||
          (x < 3 && at(this.board, y * 4 + x + 1) === v) ||
          (y < 3 && at(this.board, (y + 1) * 4 + x) === v)
        )
          return true;
      }
    return false;
  }
  slide(direction: Direction): boolean {
    const next: number[] = Array(16).fill(0);
    for (let line = 0; line < 4; line++) {
      const indices = Array.from({ length: 4 }, (_, i) =>
        direction === "left"
          ? line * 4 + i
          : direction === "right"
            ? line * 4 + 3 - i
            : direction === "up"
              ? i * 4 + line
              : (3 - i) * 4 + line,
      );
      const values = indices
        .map((i) => at(this.board, i))
        .filter((v) => v !== 0);
      let target = 0;
      for (let i = 0; i < values.length; i++) {
        let v = at(values, i);
        if (i + 1 < values.length && at(values, i + 1) === v) {
          v *= 2;
          this.score += v;
          this.best = Math.max(this.best, this.score);
          if (v >= 2048) this.won = true;
          i++;
        }
        next[at(indices, target++)] = v;
      }
    }
    const moved = next.some((v, i) => v !== this.board[i]);
    if (moved) this.board = next;
    return moved;
  }
}
const colors = new Map<number, number>([
  [2, 0xeee4da],
  [4, 0xede0c8],
  [8, 0xf2b179],
  [16, 0xf59563],
  [32, 0xf67c5f],
  [64, 0xf65e3b],
  [128, 0xedcf72],
  [256, 0xedcc61],
  [512, 0xedc850],
  [1024, 0xedc53f],
  [2048, 0xedc22e],
]);
export async function main(): Promise<void> {
  const duration = numberArg("run_time_ms", 0, 0),
    screen = open();
  try {
    const { width, height } = screen.info(),
      stage = Math.min(numberArg("target_size", 480, 240, 800), width, height),
      sx = Math.floor((width - stage) / 2),
      sy = Math.floor((height - stage) / 2),
      margin = Math.max(10, Math.floor(stage * 0.028)),
      header = Math.max(52, Math.floor(stage * 0.135)),
      gap = Math.max(5, Math.floor(stage * 0.014));
    let size = stage - 2 * margin - header;
    size -= size % 4;
    const cell = Math.floor((size - gap * 5) / 4);
    size = cell * 4 + gap * 5;
    const bx = sx + Math.floor((stage - size) / 2),
      by = sy + header + Math.floor((stage - header - size) / 2);
    const game = new Game(new Random(nowMs() + width * 17 + height * 31));
    let over = false,
      down: Point | undefined,
      last: Point | undefined;
    function label(
      x: number,
      y: number,
      w: number,
      h: number,
      text: string,
      font: number,
      color: number,
    ): void {
      centered(screen, x, y, w, h, text, font, rgb(color));
    }
    async function render(): Promise<void> {
      screen.begin(rgb(0xf8f5ef));
      const ghostValues = [
          "0",
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "16",
          "32",
          "64",
          "128",
          "256",
          "512",
          "1024",
          "2048",
        ],
        ghostColors = [0xe6ded5, 0xdacfc5, 0xcdc0b5, 0xc0b1a5];
      function ghost(
        zoneX: number,
        zoneW: number,
        spacing: number,
        sizes: number[],
        salt: number,
      ): void {
        if (zoneW < 24) return;
        const cols = Math.ceil(zoneW / spacing) + 1,
          rows = Math.ceil(height / spacing) + 1;
        for (let row = 0; row < rows; row++)
          for (let col = 0; col < cols; col++) {
            const i = row * cols + col + 1,
              value = at(
                ghostValues,
                (i * 7 + col * 5 + row * 3 + salt) % ghostValues.length,
              );
            let font = at(sizes, (i * 5 + row * 3 + salt) % sizes.length);
            if (value.length >= 4) font = Math.min(font, 16);
            else if (value.length === 3) font = Math.min(font, 20);
            const textW = Math.max(
                font,
                Math.floor(font * 0.55 * value.length),
              ),
              jx =
                ((row * 11 + col * 7 + salt) %
                  Math.max(3, Math.floor(spacing * 0.54))) -
                Math.floor(spacing * 0.27),
              jy =
                ((row * 5 + col * 13 + salt) %
                  Math.max(3, Math.floor(spacing * 0.46))) -
                Math.floor(spacing * 0.23),
              x = zoneX + col * spacing + jx - Math.floor(textW * 0.18),
              y = row * spacing + jy - Math.floor(font * 0.18);
            if (x < zoneX + zoneW && x + textW > zoneX) {
              const color = rgb(
                at(ghostColors, (i + row + salt) % ghostColors.length),
              );
              screen.text(x, y, value, { fontSize: font, color });
              screen.text(x + 1, y, value, { fontSize: font, color });
            }
          }
      }
      ghost(0, sx, 62, [28, 32, 36, 40, 44, 48], 3);
      ghost(0, sx, 40, [12, 16, 20, 24, 28], 11);
      ghost(sx + stage, width - sx - stage, 62, [28, 32, 36, 40, 44, 48], 7);
      ghost(sx + stage, width - sx - stage, 40, [12, 16, 20, 24, 28], 17);
      const compact = stage < 360,
        sw = compact ? 52 : clamp(Math.floor(stage * 0.17), 68, 88),
        sh = compact ? 44 : clamp(Math.floor(stage * 0.115), 46, 56),
        sg = compact ? 4 : Math.max(6, Math.floor(stage * 0.015)),
        ty = sy + (compact ? 8 : 16),
        tw = compact ? 48 : clamp(Math.floor(size * 0.2), 68, 82),
        scoreX = bx + size - 2 * sw - sg;
      screen.fillRoundRect(bx, ty, tw, sh, 5, rgb(0xedc22e));
      label(bx, ty, tw, sh, "2048", compact ? 16 : 24, 0xfffaf4);
      for (const [x, title, value] of [
        [scoreX, "SCORE", game.score],
        [scoreX + sw + sg, "BEST", game.best],
      ]) {
        if (
          typeof x !== "number" ||
          typeof title !== "string" ||
          typeof value !== "number"
        )
          continue;
        screen.fillRoundRect(x, ty, sw, sh, 5, rgb(0x9d8f84));
        label(x, ty + 3, sw, Math.floor(sh * 0.36), title, 12, 0xefe8e0);
        label(
          x,
          ty + Math.floor(sh * 0.34),
          sw,
          Math.floor(sh * 0.58),
          String(value),
          compact ? 16 : 20,
          0xfffaf4,
        );
      }
      screen.fillRoundRect(bx + 3, by + 4, size, size, 10, rgb(0xded6cd));
      screen.fillRoundRect(bx, by, size, size, 10, rgb(0xbbafa5));
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const value = at(game.board, y * 4 + x),
            px = bx + gap + x * (cell + gap),
            py = by + gap + y * (cell + gap);
          screen.fillRoundRect(
            px,
            py,
            cell,
            cell,
            7,
            rgb(value ? (colors.get(value) ?? 0x3a8acd) : 0xcdc4bb),
          );
          if (value) {
            const font =
              value >= 1024
                ? cell >= 72
                  ? 24
                  : cell >= 46
                    ? 16
                    : 12
                : value >= 128
                  ? cell >= 72
                    ? 28
                    : cell >= 46
                      ? 20
                      : 16
                  : cell >= 78
                    ? 32
                    : cell >= 62
                      ? 28
                      : cell >= 46
                        ? 24
                        : 20;
            label(
              px,
              py,
              cell,
              cell,
              String(value),
              font,
              value <= 4 ? 0x5b544d : 0xfffaf4,
            );
          }
        }
      if (over || game.won) {
        const pw = Math.floor(size * 0.72),
          x = bx + Math.floor((size - pw) / 2),
          y = by + Math.floor((size - 104) / 2),
          c = over ? 0xf65e3b : 0xedc22e;
        screen.fillRoundRect(x, y, pw, 104, 10, rgb(0xf8f5ef));
        screen.roundRect(x, y, pw, 104, 10, rgb(c));
        label(x, y + 18, pw, 34, over ? "GAME OVER" : "2048!", 28, c);
        label(
          x,
          y + 58,
          pw,
          24,
          over ? "swipe to restart" : "keep going",
          16,
          0x5b544d,
        );
      }
      await screen.present();
    }
    await render();
    print(
      `[game_2048] ready screen=${width}x${height} stage=${stage}x${stage} run_ms=${duration}`,
    );
    const start = nowMs();
    while (duration === 0 || nowMs() - start < duration) {
      const p = screen.touch()[0];
      if (p) {
        if (!down) down = p;
        last = p;
      } else if (down && last) {
        const dx = last.x - down.x,
          dy = last.y - down.y;
        down = undefined;
        last = undefined;
        if (Math.abs(dx) >= 44 || Math.abs(dy) >= 44) {
          if (over) {
            game.reset();
            over = false;
          } else {
            const direction: Direction =
              Math.abs(dx) > Math.abs(dy)
                ? dx > 0
                  ? "right"
                  : "left"
                : dy > 0
                  ? "down"
                  : "up";
            if (game.slide(direction)) game.add();
            over = !game.hasMoves();
          }
          await render();
        }
      }
      await sleep(16);
    }
  } finally {
    screen.close();
  }
  print("[game_2048] done");
}
