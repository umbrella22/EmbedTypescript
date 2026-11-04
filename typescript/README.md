# TypeScript 工作区

`packages/sdk/` 提供 `@dango/sdk`，`packages/builder/` 提供原生命令入口，`examples/` 保存应用、示例与默认 brain。此目录使用独立的 pnpm workspace 和锁文件。

在本目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm toolchain:build
pnpm typecheck
pnpm test
pnpm check:apps
pnpm --filter @dango-apps/snake build
pnpm build:apps
```

`toolchain:build` 用于同时开发 Rust 工具链的仓库环境。使用预编译分发时，运行 `pnpm toolchain:install MANIFEST.json_OR_URL`；这条路径不需要 Cargo。单应用构建、类型和应用检查直接调用所选编译器。

`embedts.workspace.json` 将应用构建与编辑器指向同一份 SDK 源码。`embedts-toolchain.json` 固定构建器版本、引擎指纹和宿主 ABI；安装记录与可执行文件位于忽略的 `.embedts/`。`EMBEDTS_BIN` 可以显式选择另一个符合项目锁定身份的本地二进制。

`pnpm build:apps` 调用仓库级集合打包脚本，输出 `../artifacts/apps/`，需要本仓库的 `scripts/` 和 Python。独立工程可直接使用 `embedts app` 构建单个应用；安装方式见[命令入口](packages/builder/README.md)。
