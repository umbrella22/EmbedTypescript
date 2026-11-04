import * as ui from "@dango/sdk/ui";
import * as image from "@dango/sdk/image";
import * as storage from "@dango/sdk/storage";
import { nowMs, print } from "@dango/sdk/system";
import { numberArg, stringArg, at } from "@dango/sdk/game";

export interface Photo {
  name: string;
  path: string;
  size: number;
}
interface Thumbnail {
  tile: ui.Widget;
  file: Photo;
  index: number;
  w: number;
  h: number;
  generation: number;
}
export function fitSize(
  sw: number,
  sh: number,
  mw: number,
  mh: number,
  maxPixels: number,
): [number, number] {
  if (sw <= 0 || sh <= 0 || mw <= 0 || mh <= 0) return [1, 1];
  const scale = Math.min(mw / sw, mh / sh, 1);
  let w = Math.max(1, Math.floor(sw * scale)),
    h = Math.max(1, Math.floor(sh * scale));
  while (w * h > maxPixels) {
    w = Math.max(1, Math.floor(w * 0.9));
    h = Math.max(1, Math.floor(h * 0.9));
  }
  return [w, h];
}
export async function scanAlbum(root: string, dir: string): Promise<Photo[]> {
  if (
    !dir.length ||
    dir.includes("..") ||
    dir.includes("/") ||
    dir.includes("\\")
  )
    throw new Error("dir must be a single nonempty path segment");
  const album = storage.join(root, dir);
  let stat: storage.Stat;
  try {
    stat = await storage.stat(album);
  } catch (e) {
    print("[photo] WARN: album directory not found: " + String(e));
    return [];
  }
  if (stat.type !== "dir")
    throw new Error("album path is not a directory: " + album);
  const files: Photo[] = [];
  async function visit(
    path: string,
    relative: string,
    depth: number,
  ): Promise<void> {
    if (depth > 12) {
      print("[photo] WARN: skip deep album directory: " + path);
      return;
    }
    let entries: storage.Entry[];
    try {
      entries = await storage.list(path);
    } catch (e) {
      print(
        "[photo] WARN: list album directory failed: " + path + ": " + String(e),
      );
      return;
    }
    for (const entry of entries) {
      const name = storage.join(relative, entry.name),
        child = storage.join(path, entry.name),
        lower = name.toLowerCase();
      if (entry.type === "dir") await visit(child, name, depth + 1);
      else if (
        lower.endsWith(".jpg") ||
        lower.endsWith(".jpeg") ||
        lower.endsWith(".bin")
      )
        files.push({ name, path: child, size: entry.size });
    }
  }
  await visit(album, "", 0);
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files;
}
const basename = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);
export class Album {
  private index = 0;
  private mode: "grid" | "fullscreen" = "grid";
  private generation = 0;
  private jobs: Thumbnail[] = [];
  constructor(
    private screen: ui.Widget,
    private w: number,
    private h: number,
    private root: string,
    private dir: string,
    private files: Photo[],
  ) {}
  private async label(
    parent: ui.Widget,
    text: string,
    options: ui.Options = {},
  ): Promise<ui.Widget> {
    return ui.create("label", parent, { text, ...options });
  }
  private async error(parent: ui.Widget, text: string): Promise<void> {
    await this.label(parent, text, { align: "center", text_color: "#ffb4a8" });
  }
  private async draw(
    parent: ui.Widget,
    file: Photo,
    mw: number,
    mh: number,
    maxPixels: number,
  ): Promise<{ detail: string; widget: ui.Widget }> {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".jpg") && !lower.endsWith(".jpeg"))
      return {
        detail: "LVGL image",
        widget: await ui.create("image", parent, {
          src: "D:/" + file.path.slice(this.root.length + 1),
          align: "center",
          radius: 0,
        }),
      };
    const frame = await image.loadFile(file.path);
    try {
      const info = frame.info(),
        size = fitSize(info.width, info.height, mw, mh, maxPixels),
        w = at(size, 0),
        h = at(size, 1),
        resized = frame.resize(w, h, { filter: "bilinear" });
      try {
        const widget = await ui.create("canvas", parent, {
          w,
          h,
          color_format: "rgb565",
          align: "center",
        });
        await widget.rgb565(resized.bytes());
        return {
          detail: info.width + "x" + info.height + " -> " + w + "x" + h,
          widget,
        };
      } finally {
        resized.close();
      }
    } finally {
      frame.close();
    }
  }
  async pumpThumbnail(): Promise<void> {
    if (this.mode !== "grid") return;
    const job = this.jobs.shift();
    if (!job || job.generation !== this.generation || !(await job.tile.valid()))
      return;
    try {
      await job.tile.clean();
      const picture = await this.draw(
        job.tile,
        job.file,
        job.w - 8,
        job.h - 8,
        4096,
      );
      await picture.widget.on("clicked", () => this.fullscreen(job.index));
    } catch (e) {
      print(
        "[photo] WARN: thumbnail failed for " +
          job.file.path +
          ": " +
          String(e),
      );
      if (
        this.mode === "grid" &&
        job.generation === this.generation &&
        (await job.tile.valid())
      ) {
        await job.tile.clean();
        await this.error(job.tile, "Load failed");
      }
    }
  }
  async grid(): Promise<void> {
    this.mode = "grid";
    this.generation++;
    this.jobs = [];
    await this.screen.clean();
    await this.screen.style({ bg_color: "#0b0f14" });
    const nodes: ui.BuildNode[] = [
      {
        kind: "label",
        options: { x: 10, y: 8, text: "Album", text_color: "#f3f6fa" },
      },
      {
        kind: "label",
        options: {
          align: "top_right",
          x: -10,
          y: 10,
          text: this.files.length + " photos",
          text_color: "#aeb8c4",
        },
      },
    ];
    if (!this.files.length) {
      nodes.push(
        {
          kind: "label",
          options: {
            align: "center",
            y: -12,
            text: "No images",
            text_color: "#f3f6fa",
          },
        },
        {
          kind: "label",
          options: {
            align: "center",
            y: 18,
            text: "Put JPEG photos in " + this.dir + "/",
            text_color: "#aeb8c4",
          },
        },
      );
      await ui.build(this.screen, nodes, { publish: false });
      return;
    }
    nodes.push({
      kind: "container",
      key: "grid",
      options: {
        x: 8,
        y: 42,
        w: this.w - 16,
        h: this.h - 50,
        bg_opa: 0,
        border_width: 0,
        pad: 0,
        pad_row: 8,
        pad_column: 8,
      },
      flex: { flow: "row_wrap", main: "start", cross: "start", track: "start" },
      scroll: { dir: "ver", scrollbar: "auto" },
    });
    const view = await ui.build(this.screen, nodes, { publish: false });
    const grid = view.get("grid");
    const w = Math.max(62, Math.floor((this.w - 32) / 3)),
      h = Math.max(58, Math.floor(w * 0.78));
    // Eight tiles have sixteen explicit objects, within one native build budget.
    for (let start = 0; start < this.files.length; start += 8) {
      const end = Math.min(start + 8, this.files.length);
      const tiles: ui.BuildNode[] = [];
      for (let index = start; index < end; index++) {
        tiles.push({
          kind: "button",
          key: "tile-" + index,
          options: {
            w,
            h,
            radius: 4,
            bg_color: "#111820",
            bg_opa: 255,
            border_color: "#273442",
            border_width: 1,
            text_color: "#ffffff",
          },
          on: [{ event: "clicked", handler: () => this.fullscreen(index) }],
          children: [
            {
              kind: "label",
              options: { text: "...", align: "center", text_color: "#aeb8c4" },
            },
          ],
        });
      }
      const built = await ui.build(grid, tiles, { publish: false });
      for (let index = start; index < end; index++)
        this.jobs.push({
          tile: built.get("tile-" + index),
          file: at(this.files, index),
          index,
          w,
          h,
          generation: this.generation,
        });
    }
  }
  private async confirm(file: Photo): Promise<void> {
    const view: ui.BuiltView = await ui.build(
      this.screen,
      [
        {
          kind: "msgbox",
          key: "dialog",
          options: {
            title: "Delete photo?",
            text: basename(file.name),
            w: Math.min(this.w - 48, 360),
            h: 150,
            align: "center",
          },
          footer: [
            {
              text: "Cancel",
              on: [
                { event: "clicked", handler: () => view.get("dialog").close() },
              ],
            },
            {
              text: "Delete",
              style: {
                bg_color: "#a52a2a",
                bg_opa: 255,
                text_color: "#ffffff",
              },
              on: [
                {
                  event: "clicked",
                  handler: async () => {
                    await view.get("dialog").close();
                    try {
                      await storage.remove(file.path);
                    } catch (e) {
                      print(
                        "[photo] ERROR: delete failed for " +
                          file.path +
                          ": " +
                          String(e),
                      );
                      return;
                    }
                    const index = this.files.indexOf(file);
                    if (index < 0) return;
                    this.files.splice(index, 1);
                    print("[photo] deleted photo: " + file.path);
                    if (this.files.length)
                      await this.fullscreen(
                        Math.min(index, this.files.length - 1),
                      );
                    else await this.grid();
                  },
                },
              ],
            },
          ],
        },
      ],
      { publish: false },
    );
  }
  async fullscreen(index: number): Promise<void> {
    if (!this.files.length) {
      await this.grid();
      return;
    }
    this.mode = "fullscreen";
    this.generation++;
    this.jobs = [];
    this.index =
      ((index % this.files.length) + this.files.length) % this.files.length;
    const file = at(this.files, this.index);
    await this.screen.clean();
    await this.screen.style({ bg_color: "#030609" });
    const backToGrid: ui.Binding[] = [
      { event: "clicked", handler: () => this.grid() },
    ];
    const base = await ui.build(
      this.screen,
      [
        {
          kind: "button",
          options: {
            x: 0,
            y: 0,
            w: this.w,
            h: this.h,
            bg_color: "#030609",
            bg_opa: 255,
            border_width: 0,
            text_color: "#ffffff",
          },
          on: backToGrid,
        },
        {
          kind: "container",
          key: "picture",
          options: {
            x: 8,
            y: 8,
            w: this.w - 16,
            h: this.h - 16,
            bg_opa: 0,
            border_width: 0,
            pad: 0,
          },
          on: backToGrid,
        },
      ],
      { publish: false },
    );
    const picture = base.get("picture");
    let detail = "Unsupported or damaged image";
    try {
      const result = await this.draw(
        picture,
        file,
        this.w - 20,
        this.h - 42,
        600000,
      );
      detail = result.detail;
      await result.widget.on("clicked", () => this.grid());
    } catch (e) {
      print(
        "[photo] ERROR: image load failed for " + file.path + ": " + String(e),
      );
      await this.error(picture, "Image load failed");
    }
    await ui.build(
      this.screen,
      [
        {
          kind: "container",
          options: {
            x: 0,
            y: 0,
            w: this.w,
            h: 34,
            bg_color: "#030609",
            bg_opa: 180,
            border_width: 0,
            pad: 6,
          },
          on: backToGrid,
          children: [
            {
              kind: "label",
              options: {
                text: basename(file.name),
                align: "left_mid",
                x: 4,
                text_color: "#f3f6fa",
              },
              on: backToGrid,
            },
            {
              kind: "label",
              options: {
                text: this.index + 1 + " / " + this.files.length,
                align: "right_mid",
                x: -4,
                text_color: "#aeb8c4",
              },
              on: backToGrid,
            },
          ],
        },
        {
          kind: "container",
          options: {
            x: 0,
            y: this.h - 24,
            w: this.w,
            h: 24,
            bg_color: "#030609",
            bg_opa: 160,
            border_width: 0,
            pad: 4,
          },
          on: backToGrid,
          children: [
            {
              kind: "label",
              options: { text: detail, align: "center", text_color: "#aeb8c4" },
              on: backToGrid,
            },
          ],
        },
        {
          kind: "button",
          options: {
            text: "<",
            align: "left_mid",
            x: 12,
            w: 64,
            h: 64,
            radius: 32,
            bg_color: "#ffffff",
            bg_opa: 115,
            text_color: "#1b2733",
          },
          on: [
            {
              event: "clicked",
              handler: () => this.fullscreen(this.index - 1),
            },
          ],
        },
        {
          kind: "button",
          options: {
            text: ">",
            align: "right_mid",
            x: -12,
            w: 64,
            h: 64,
            radius: 32,
            bg_color: "#ffffff",
            bg_opa: 115,
            text_color: "#1b2733",
          },
          on: [
            {
              event: "clicked",
              handler: () => this.fullscreen(this.index + 1),
            },
          ],
        },
        {
          kind: "button",
          options: {
            text: "Delete",
            align: "top_right",
            x: -8,
            y: 42,
            w: 72,
            h: 34,
            radius: 6,
            bg_color: "#8f2d2d",
            bg_opa: 235,
            text_color: "#ffffff",
          },
          on: [{ event: "clicked", handler: () => this.confirm(file) }],
        },
      ],
      { publish: false },
    );
  }
}
export async function main(): Promise<number> {
  let started = false;
  try {
    await ui.init();
    started = true;
    const screen = await ui.createScreen(),
      size = await screen.size(),
      w = at(size, 0),
      h = at(size, 1);
    if (w <= 0 || h <= 0) throw new Error("invalid display size");
    const dir = stringArg("dir", "photos"),
      root = storage.root(),
      files = await scanAlbum(root, dir),
      album = new Album(screen, w, h, root, dir, files);
    print("[photo] found " + files.length + " image(s) under " + dir);
    await album.grid();
    await screen.load();
    const deadline = nowMs() + numberArg("run_time_ms", 180000, 1000);
    while (nowMs() < deadline) {
      await ui.processEvents(20);
      await album.pumpThumbnail();
    }
    print("[photo] done images=" + files.length);
    return 0;
  } finally {
    if (started) await ui.deinit();
  }
}
