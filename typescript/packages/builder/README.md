# @embedts/builder

原生 EmbedTS 构建器的 Node.js 命令入口。包提供 `embedts` 和 `embedts-toolchain`；语义检查、子集规则、打包和字节码编译由 Rust 二进制执行。Node.js 24.11.1 或更新版本用于命令入口和安装器。

## 本仓库开发

在 `typescript/` 执行：

```sh
pnpm toolchain:build
pnpm --filter @dango-apps/snake check
pnpm --filter @dango-apps/snake build
```

`toolchain:build` 显式调用固定 Rust 工具链，遵守 Cargo 锁文件与 `CARGO_TARGET_DIR`。可附加 `--release` 或 `--offline`。它将构建产物复制到当前项目 `.embedts/`；修改 Rust 后重新运行。应用命令不执行 Cargo。

`EMBEDTS_BIN=/absolute/path/to/embedts` 显式选择已有二进制。入口检查其真实 `--version` JSON 与项目的 `embedts-toolchain.json`，不会通过 PATH 隐式选择另一个构建器。`embedts-toolchain path` 输出通过检查的原生路径。

## 独立 TS 工程

从同一套经过校验的分发取得命令入口包、SDK 包和当前平台的原生清单及二进制。以下命令在新的应用目录执行；路径指向下载文件，平台名按当前主机选择。

```sh
npm install --save-dev /downloads/embedts-builder-0.2.0.tgz
npm install /downloads/dango-sdk-0.2.0.tgz
npx --no-install embedts-toolchain install /downloads/embedts-0.2.0-darwin-arm64.json
```

清单与二进制放在同一目录。安装器也接受 JSON 清单的 HTTP(S) URL，读取其同目录的二进制。原生安装检查平台、SHA-256、命令入口版本、真实编译器身份以及项目锁定的引擎指纹和宿主 ABI。首次安装生成 `embedts-toolchain.json`；该文件可以提交到应用仓库。已有锁文件不被安装操作覆盖。

应用根目录的 `embedts.workspace.json` 选择安装的 SDK：

```json
{
  "sdk": "node_modules/@dango/sdk"
}
```

源码入口导出 `main()`，`launcher.json` 指定应用 ID 与 TS 入口，然后执行：

```sh
npx --no-install embedts check scripts/main.ts
npx --no-install embedts app . --out dist
```

命令入口透传参数、当前目录、输出和退出状态。编译器和 SDK 已就绪时，原生二进制也可直接运行；应用编译不依赖 Node、Cargo 或源码 checkout。

## 安装与失败行为

安装器把二进制按内容摘要保存在 `.embedts/bin/`。只有校验和真实身份检查通过后才替换 `.embedts/active.json`。版本不匹配、下载损坏、平台不匹配或安装失败不会切换当前工具链；命令入口发现已安装二进制被修改时要求重新安装。

校验值来自分发清单；清单与二进制必须来自受信任的分发来源。项目兼容性锁包含构建器版本、引擎指纹与宿主 ABI，SDK 版本和 ABI 则由原生应用构建报告记录。SDK 本身是受信任的宿主适配源码输入。
