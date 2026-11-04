// TS port of this package's Lua application; see LICENSE and SOURCE.json.
import { open, rgb, Screen } from "@dango/sdk/display";
import { nowMs, sleep, print } from "@dango/sdk/system";
import {
  at,
  numberArg,
  boolArg,
  colorArg,
  Random,
} from "@dango/sdk/game";
interface Cell {
  x: number;
  y: number;
}
interface Direction {
  name: string;
  dx: number;
  dy: number;
}
const directions: Direction[] = [
  { name: "right", dx: 1, dy: 0 },
  { name: "down", dx: 0, dy: 1 },
  { name: "left", dx: -1, dy: 0 },
  { name: "up", dx: 0, dy: -1 },
];
const same = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;
const key = (c: Cell): string => c.x + "," + c.y;
export async function main(): Promise<void> {
  const delay = Math.floor(numberArg("frame_delay_ms", 140, 40, 2000)),
    duration = numberArg("duration_ms", 0, 0),
    wrap = boolArg("wrap_edges", true),
    random = new Random(numberArg("seed", nowMs(), 0));
  const background = colorArg("background", 0),
    body = colorArg("snake_color", 0xffffff),
    headColor = colorArg("head_color", 0xff8f00),
    foodColor = colorArg("food_color", 0x00ff00);
  const screen = open();
  try {
    const info = screen.info(),
      cell = Math.floor(
        Math.min(
          numberArg("cell_size", 0, 0) ||
            Math.min(info.width, info.height) / 16,
          Math.min(info.width, info.height) / 16,
        ),
      );
    if (cell < 1) throw new Error("display too small for snake");
    const ox = Math.floor((info.width - 16 * cell) / 2),
      oy = Math.floor((info.height - 16 * cell) / 2);
    let snake: Cell[] = Array.from({ length: 6 }, (_, i) => ({
        x: 8 - i,
        y: 8,
      })),
      direction = at(directions, 0),
      score = 0,
      bites = 0,
      leaveEdge = false;
    const inBounds = (c: Cell): boolean =>
      c.x >= 1 && c.x <= 16 && c.y >= 1 && c.y <= 16;
    const edge = (c: Cell): boolean =>
      c.x === 1 || c.y === 1 || c.x === 16 || c.y === 16;
    const crosses = (c: Cell, d: Direction): boolean =>
      !inBounds({ x: c.x + d.dx, y: c.y + d.dy });
    function next(c: Cell, d: Direction): Cell {
      let x = c.x + d.dx,
        y = c.y + d.dy;
      if (wrap) {
        x = x < 1 ? 16 : x > 16 ? 1 : x;
        y = y < 1 ? 16 : y > 16 ? 1 : y;
      }
      return { x, y };
    }
    function makeFood(): Cell {
      const occupied = new Set(snake.map(key));
      if (snake.length >= 256)
        return { x: random.int(1, 16), y: random.int(1, 16) };
      for (let i = 0; i < 80; i++) {
        const c = { x: random.int(1, 16), y: random.int(1, 16) };
        if (!occupied.has(key(c))) return c;
      }
      for (let y = 1; y <= 16; y++)
        for (let x = 1; x <= 16; x++)
          if (!occupied.has(key({ x, y }))) return { x, y };
      return { x: 1, y: 1 };
    }
    let food = makeFood();
    function validate(): void {
      const seen = new Set<string>();
      for (let i = 0; i < snake.length; i++) {
        const c = at(snake, i);
        if (!inBounds(c) || seen.has(key(c)))
          throw new Error("invalid snake position");
        seen.add(key(c));
        if (i > 0) {
          const p = at(snake, i - 1);
          let dx = Math.abs(p.x - c.x),
            dy = Math.abs(p.y - c.y);
          if (wrap) {
            dx = Math.min(dx, 16 - dx);
            dy = Math.min(dy, 16 - dy);
          }
          if (dx + dy !== 1) throw new Error("disconnected snake");
        }
      }
    }
    function choose(): Direction {
      const options: { direction: Direction; score: number; tie: number }[] =
        [];
      function add(reverse: boolean): void {
        for (const d of directions) {
          if (
            !reverse &&
            snake.length > 1 &&
            d.dx + direction.dx === 0 &&
            d.dy + direction.dy === 0
          )
            continue;
          const c = next(at(snake, 0), d);
          if (!inBounds(c)) continue;
          const bite = snake.findIndex((p, i) => i > 0 && same(p, c)),
            wrapped = crosses(at(snake, 0), d);
          if (
            (wrapped && (same(c, food) || bite >= 0)) ||
            (leaveEdge && wrapped)
          )
            continue;
          let cost = Math.abs(c.x - food.x) + Math.abs(c.y - food.y);
          if (bite >= 0) cost += 5000 + Math.max(0, snake.length - bite) * 100;
          if (leaveEdge && edge(c)) cost += 2000;
          options.push({ direction: d, score: cost, tie: random.int(0, 999) });
        }
      }
      add(false);
      if (!options.length) add(true);
      options.sort((a, b) => a.score - b.score || a.tie - b.tie);
      return at(options, 0).direction;
    }
    function drawCell(c: Cell, color: number): void {
      const pad = cell >= 6 ? 1 : 0,
        size = Math.max(1, cell - 2 * pad),
        x = ox + (c.x - 1) * cell + pad,
        y = oy + (c.y - 1) * cell + pad;
      if (cell >= 8 && size >= 4)
        screen.fillRoundRect(
          x,
          y,
          size,
          size,
          Math.max(1, Math.floor(size / 4)),
          color,
        );
      else screen.fillRect(x, y, size, size, color);
    }
    print(
      `[snake] start display=${info.width}x${info.height} cell=${cell} grid=16x16 length=6`,
    );
    for (
      let elapsed = 0;
      duration === 0 || elapsed < duration;
      elapsed += delay
    ) {
      direction = choose();
      const old = at(snake, 0),
        h = next(old, direction),
        ate = same(h, food),
        bite = snake.findIndex((c, i) => i > 0 && same(c, h)),
        wrapped = crosses(old, direction),
        keep = bite >= 0 ? bite : snake.length - (ate ? 0 : 1);
      snake = [h, ...snake.slice(0, keep).map((c) => ({ x: c.x, y: c.y }))];
      validate();
      if (ate) score++;
      if (bite >= 0) bites++;
      if (wrapped)
        print(
          `[snake] wrap=(${old.x},${old.y})->(${h.x},${h.y}) direction=${direction.name} ate=${ate} bite=${bite >= 0}`,
        );
      if (leaveEdge && !edge(h)) leaveEdge = false;
      if (ate || bite >= 0) leaveEdge = edge(h);
      screen.begin(background);
      await sleep(0);
      if (!ate) {
        if (cell >= 6)
          screen.fillCircle(
            ox + (food.x - 1) * cell + Math.floor(cell / 2),
            oy + (food.y - 1) * cell + Math.floor(cell / 2),
            Math.max(2, Math.floor((cell - 4) / 2)),
            foodColor,
          );
        else drawCell(food, foodColor);
      }
      for (let i = snake.length - 1; i >= 0; i--) {
        drawCell(at(snake, i), i === 0 ? headColor : body);
        if (i % 4 === 0) await sleep(0);
      }
      if (cell >= 10)
        screen.text(4, 4, "SNAKE " + score, {
          fontSize: 12,
          color: rgb(0x808080),
        });
      await screen.present();
      await sleep(delay);
      if (ate) {
        food = makeFood();
        print(
          `[snake] ate=(${h.x},${h.y}) next_food=(${food.x},${food.y}) length=${snake.length}`,
        );
      }
    }
    print(`[snake] done score=${score} length=${snake.length} bites=${bites}`);
  } finally {
    screen.close();
  }
}
