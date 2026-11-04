# 贪吃蛇 · TypeScript

应用 ID 为 `snake`，Lua 版本维护于[团子 OS 仓库](https://github.com/umbrella22/dangoOS/tree/main/apps/games/snake/lua)。
此目录包含独立 TS 源码、启动清单、资源和 pnpm 包配置。

```sh
# 在仓库根目录安装固定工具链
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @dango-apps/snake check
pnpm --filter @dango-apps/snake build
```

`build` 在尚不存在的 `dist/` 下生成可打包的 `dist/snake/`，包含字节码、资源和最终清单。
完整应用集的构建、跨仓库打包和设备安装见[应用与示例](../../README.md)。安装时选择 `snake` 应用包。

共享接口来自 `@dango/sdk`，游戏与参数辅助代码来自 `@dango/sdk/game`。
设备只接收字节码和应用资源；pnpm 的 `node_modules`、TS 源码和编辑器配置不进入载荷。
应用数据继续位于 `/data/appdata/snake`，与 Lua 版本使用同一个应用 ID。

资源及原 Lua 游戏来自 esp-claw-skills-lab；授权见 `LICENSE`。TS 实现由本项目维护。
