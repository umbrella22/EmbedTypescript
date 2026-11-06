# EmbedTS

面向嵌入式系统的 TypeScript 构建器与有界 QuickJS-NG 运行时。原生工具链使用 **tsrs（TypeScript 7.1 beta）→ Rolldown → QuickJS 字节码编译器**，输出 **EmbedTS Bytecode（`.etb`）**。设备只读取编译产物，设备引擎关闭源码解析器。

## 两个工作区

| 目录 | 职责 |
| --- | --- |
| [rust](rust/README.md) | 独立 Cargo 工作区：原生构建器与设备引擎 |
| [rust/builder](rust/builder/README.md) | `embedts-builder`：类型检查、模块打包、字节码与应用资源组装 |
| [rust/engine](rust/engine/README.md) | `embedts-engine`：`no_std + alloc` VM、预算、宿主请求、worker 与包校验 |
| [typescript](typescript/README.md) | 独立 pnpm 工作区：SDK、应用、示例与原生命令入口 |
| [typescript/packages/builder](typescript/packages/builder/README.md) | `@embedts/builder`：安装、校验并调用原生构建器 |
| [typescript/packages/sdk](typescript/packages/sdk/README.md) | `@dango/sdk`：团子 OS 服务的类型与应用辅助代码 |
| [typescript/examples](typescript/examples/README.md) | hello、system-demo、五个应用及默认 brain |
| [tests](tests/README.md) | 跨工作区夹具、设备探针与 Lua/TS 基准 |
| [docs](docs/architecture.md) | 构建、运行、SDK 输入与交付边界 |

Rust 工作区编译和单元测试不读取 TypeScript 工作区。TypeScript 通过 `embedts` 原生命令构建应用；日常应用命令直接执行选定的二进制。SDK 是应用编译时读取的源码依赖，更新 SDK 不需要重新编译 Rust 工具链。

## 在仓库中开发

以下命令从仓库根目录执行。首次安装使用 `rust/rust-toolchain.toml` 固定的 Rust、本机 C 编译器，以及 Node.js 24.11.1 或更新版本、pnpm 12.14.0。

```sh
pnpm -C typescript install --frozen-lockfile --ignore-scripts
pnpm -C typescript toolchain:build
pnpm -C typescript check
pnpm -C typescript --filter @dango-apps/snake build
pnpm -C typescript build:apps
```

`toolchain:build` 显式调用 Cargo，将编译器安装到 `typescript/.embedts/`。修改 Rust 后重新运行该命令；应用开发不自动触发 Rust 编译。`typescript/embedts-toolchain.json` 锁定构建器版本、引擎指纹与宿主 ABI。`EMBEDTS_BIN` 可以选择本地开发二进制，仍须通过兼容性检查。

单应用输出 `dist/`，集合输出 `artifacts/apps/`。应用输出目录必须尚不存在，构建失败保留既有产物。生成目录与本地工具链不纳入 Git。

## 只使用原生工具链

编译应用的原生进程不依赖 Node.js、pnpm 或外部 JS 可执行文件。

```sh
cd rust
cargo fetch --locked
cargo build -p embedts-builder --locked
cd ..
rust/target/debug/embedts check typescript/examples/hello/scripts/main.ts
rust/target/debug/embedts build typescript/examples/hello/scripts/main.ts --out artifacts/hello.etb
rust/target/debug/embedts app typescript/examples/games/snake --out artifacts/snake
python3 scripts/build_examples.py artifacts/apps --compiler rust/target/debug/embedts
(cd rust && cargo run -p embedts-engine --locked --example run -- ../artifacts/hello.etb)
```

构建器内置 TypeScript 标准库与设备编译配置。输入最近上级的 `embedts.workspace.json` 声明 `sdk` 和可按包名导入的 `packages`。TypeScript 工作区选用 `packages/sdk`；根配置供跨工作区集成夹具使用。独立工程可声明：

```json
{
  "sdk": "node_modules/@dango/sdk",
  "packages": ["packages/shared"]
}
```

`packages` 可省略。原生命令的 `--sdk SDK_DIR` 可以显式覆盖 SDK 选择；SDK 路径相对于配置文件目录解析，命令行路径相对于当前目录解析。SDK 的 `embedts.hostAbi` 必须匹配构建器。普通源码包限于声明工作区，任意 npm 包尚未纳入设备子集。

## 使用预编译分发

[工具链工作流](.github/workflows/toolchain.yml) 为 Linux x64、macOS arm64 和 macOS x64 构建分发文件，并打包命令入口与 SDK。每个平台产物包含原生可执行文件、JSON 清单和 `SHA256SUMS`。工作流可手动运行，`embedts-v*` 标签也触发构建；标签版本必须匹配 Rust 工作区版本。

```sh
python3 scripts/package_toolchain.py --binary rust/target/release/embedts --out artifacts/toolchain
pnpm -C typescript toolchain:install /path/to/embedts-0.2.0-darwin-arm64.json
```

安装也支持 JSON 清单的 HTTP(S) URL，并从同一目录取得二进制。安装器检查平台、SHA-256、真实编译器身份和项目兼容性锁；失败不替换当前安装。校验值来自所选分发清单，分发来源需要受信任。工作流生成 GitHub Actions artifacts，npm 包与 GitHub Release 的公开发布单独执行。独立 TS 工程安装示例见[命令入口文档](typescript/packages/builder/README.md)。

## 接入团子 OS

引擎和构建器可独立于团子 OS 编译测试。SDK 的宿主服务由 OS 的 Rust 适配层实现；其他系统可通过 `Host` 接入自身服务。团子 OS 默认使用 Lua，显式 `ts-engine` feature 才链接外部 `embedts-engine`。OS 保存 Rust 适配层和预编译输入。

消费端以 GitHub 仓库地址和完整 commit SHA 固定 `embedts-engine`，Cargo 按包名从 `rust/engine` 获取 crate。使用新版目录布局时更新消费端固定的 revision 和锁文件。固件构建无需相邻的本仓库 checkout。应用和集成输入使用与目标引擎匹配的工具链生成。

```sh
(cd rust && cargo run -p embedts-builder --locked --example export-dangoos -- ../artifacts/dangoos-inputs)
# 审核 manifest.json 后，用整个导出目录替换 OS 的 artifacts/embedts。

# 在 OS checkout 使用其打包器消费应用集合：
# cargo run -p app-pack -- bundle ../EmbedTypescript/artifacts/apps/games/snake target/snake-bundle
# cargo run -p app-pack --no-default-features --features ts-engine -- system ../EmbedTypescript/artifacts/apps target/system-ts --size 2031616
```

`.etb` 包头包含格式版本、引擎指纹、宿主 ABI 和载荷摘要；brain 字符串接口使用 `etb1:` 十六进制信封。摘要发现损坏，兼容标识约束编译器与运行时，二者不能认证发布者。设备只载入可信构建来源。

## 验证

依赖取得后，从根目录执行：

```sh
./scripts/check.sh
```

该入口执行来源校验、Rust 格式与测试、真实 SDK 集成测试、基准协议测试、命令入口测试、TS 类型检查和应用检查。CI 分别验证缺少 TypeScript 目录的 Rust 工作区，以及使用预编译构建器、缺少 Rust 目录的 TS 工作区；分发检查从本地包安装到临时工程，随后以空 `PATH` 构建。

TS 7 仍是预发布工具链。精确 tsrs 提交、TypeScript 提交和 Rolldown 版本由构建器 `--version` 与 `rust/Cargo.lock` 记录。OS 原生 UI、服务和实体设备验收在消费端独立执行。本次迁移证据与限制见[验证记录](docs/verification-20261105.md)。

数值比较优化、Lua / TS 计算对照及主机和设备验证见[计算验证记录](docs/verification-20261106.md)。
