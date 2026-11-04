import {
  Game,
  main as puzzle,
} from "@dango-apps/2048";
import {
  Runner,
  main as dino,
} from "@dango-apps/dino";
import {
  Flight,
  main as flappy,
} from "@dango-apps/flappy";
import { main as snake } from "@dango-apps/snake";
import {
  Album,
  scanAlbum,
  fitSize,
} from "@dango-apps/photo";
import { Random } from "@dango/sdk/game";
import { sleep, print } from "@dango/sdk/system";
import * as storage from "@dango/sdk/storage";
import * as ui from "@dango/sdk/ui";
function check(ok: boolean): void {
  if (!ok) throw new Error("official app assertion");
}
export async function main(): Promise<number> {
  const g = new Game(new Random(1));
  g.board = [2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  check(
    g.slide("left") && g.board[0] === 4 && g.board[1] === 4 && g.score === 8,
  );
  check(g.slide("right") && g.board[3] === 8 && g.score === 16);
  g.board = [1024, 1024, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  g.slide("left");
  check(g.won && g.board[0] === 2048);
  g.board = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  check(!g.hasMoves());
  g.reset();
  check(!g.won && g.score === 0 && g.best >= 2048);
  const runner = new Runner(
    440,
    44,
    48,
    34,
    480,
    0.42,
    -10,
    2.1,
    3.4,
    0.0003,
    175,
    300,
    new Random(2),
  );
  runner.press();
  runner.step(1);
  check(!runner.grounded && runner.y < 396);
  for (let i = 0; i < 70; i++) runner.step(1);
  check(runner.grounded);
  runner.obstacles = [{ x: 34, y: 410, w: 20, h: 30, kind: 1, scored: false }];
  runner.step(0);
  check(runner.over);
  runner.press();
  check(!runner.over && runner.score === 0);
  const flight = new Flight(480, 438, 124, new Random(3));
  check(flight.state === "title");
  flight.press();
  flight.update();
  check(flight.state === "playing" && flight.vy < 0);
  flight.y = 500;
  flight.update();
  check(flight.state === "crashed");
  flight.press();
  check(flight.state === "playing" && flight.score === 0);
  check(fitSize(1920, 1080, 480, 438, 600000)[0] === 480);
  check(fitSize(8, 4, 480, 480, 4096)[0] === 8);
  await puzzle();
  await dino();
  await flappy();
  await snake();
  print("official-games:ok");
  const root = storage.root(),
    files = await scanAlbum(root, "photos");
  check(
    files.length === 3 &&
      files[0]?.name === "a.jpg" &&
      files[2]?.name === "nested/c.jpg",
  );
  await ui.init();
  try {
    const screen = await ui.createScreen(),
      album = new Album(screen, 480, 480, root, "photos", files);
    await album.grid();
    await album.pumpThumbnail();
    await screen.load();
    await ui.frameEnd();
    for (let i = 0; i < 7; i++) {
      await sleep(1);
      await ui.processEvents();
      if (i === 2 || i === 3) check(await storage.exists("photos/b.jpg"));
    }
    check(
      !(await storage.exists("photos/b.jpg")) &&
        (await storage.exists("photos/a.jpg")) &&
        (await storage.exists("photos/nested/c.jpg")),
    );
    await album.pumpThumbnail();
  } finally {
    await ui.deinit();
  }
  print("official-photo:ok");
  return 42;
}
