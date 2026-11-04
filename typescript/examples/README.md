# 应用与示例

所有 TypeScript 应用源码在本仓库构建。每个应用的 `launcher.json` 指向 `.ts` 入口；`embedts app` 生成清单指向 `.etb`，仅输出编译产物、资源和许可证。团子 OS 使用相同应用 ID 对应的 Lua 版本，安装时选择与固件匹配的产物。

| 路径 | 内容 |
| --- | --- |
| `hello` | 最小同步入口 |
| `system-demo` | 系统服务与原生 LVGL |
| `games/2048`、`games/dino`、`games/flappy`、`games/snake` | 与 Lua 对应的游戏 |
| `tools/photo` | 图像与文件能力 |
| `brain/default.ts` | 受限常驻行为模块，由 export-dangoos 导出 |

```sh
(cd rust && cargo run -p embedts-builder -- app ../typescript/examples/games/snake --out ../artifacts/snake)
python3 scripts/build_examples.py artifacts/apps
```

源码目录名与安装身份分离，安装身份来自 launcher 的 `id`。输出目录必须尚不存在，失败不会发布部分载荷。设备目录仍为 `/system/apps/<id>` 或 `/data/apps/<id>`，数据目录为 `/data/appdata/<id>`。

集合输出统一为 `<分类>/<应用 ID>`：游戏在 `games/`，Photo 在 `tools/`，hello 与 system-demo 在 `examples/`。目录名使用 launcher ID，打包器可直接消费整个集合。

## 在团子 OS 中打包与安装

先在本仓库根目录构建 `artifacts/apps`，再进入相邻的团子 OS checkout 打包。输出目录必须尚不存在。

```sh
cd ../esp-32
cargo run -p app-pack --locked --offline -- check ../EmbedTypescript/artifacts/apps
cargo run -p app-pack --locked --offline -- bundles ../EmbedTypescript/artifacts/apps target/embedts-bundles
# 设备运行匹配引擎版本的 TS 固件后，可安装并运行指定应用。
python3 scripts/device/console.py bundle-push target/embedts-bundles/snake --run
```

`bundle-push` 的最后一级目录是应用 ID，可替换为 `2048`、`dino`、`flappy`、`photo`、`ts-hello` 或 `ts-system-demo`。
独立应用包校验支持两种入口；需要生成包含这些应用的 system 镜像时，打包器必须选择 TS 引擎：

```sh
cargo run -p app-pack --no-default-features --features ts-engine --locked --offline -- system ../EmbedTypescript/artifacts/apps target/embedts-system --size 2031616
```

此处 `2031616` 是当前团子 OS 布局的 system 分区字节数，其他设备应使用自身分区大小。镜像构建与刷写独立执行。
