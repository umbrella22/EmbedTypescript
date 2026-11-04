# EmbedTS

面向嵌入式系统的 TypeScript 构建器与有界 QuickJS-NG 运行时。主机使用 **tsrs（TypeScript 7.1 beta）→ Rolldown → QuickJS 字节码编译器**，输出 **EmbedTS Bytecode（`.etb`）**。设备只读取编译产物，设备引擎关闭源码解析器。

| 目录 | 职责 |
| --- | --- |
| [builder](builder/README.md) | Rust 构建器 `embedts`：类型检查、模块打包、字节码与应用资源组装 |
| [engine](engine/README.md) | `embedts-engine`：`no_std + alloc` VM、预算、宿主请求、worker 与包校验 |
| [sdk](sdk/README.md) | `@dango/sdk`：团子 OS 服务的类型与应用辅助代码 |
| [examples](examples/README.md) | hello、system-demo、五个应用及默认 brain |
| [tests](tests/README.md) | 跨仓库夹具、设备探针与 Lua/TS 基准 |
| [docs](docs/architecture.md) | 构建与运行边界、产物和接入约定 |

引擎和构建器可独立于团子 OS 编译测试。SDK 的宿主服务由 OS 的 Rust 适配层实现；宿主系统可通过 `Host` 接入其他 RTOS 或设备。

## 原生构建

使用 `rust-toolchain.toml` 固定的 Rust 和本机 C 编译器。应用编译过程不依赖 Node.js、pnpm 或外部 JS 可执行文件。

```sh
cargo fetch --locked
cargo build -p embedts-builder --locked
cargo run -p embedts-builder --locked -- check examples/hello/scripts/main.ts
cargo run -p embedts-builder --locked -- build examples/hello/scripts/main.ts --out target/hello.etb
cargo run -p embedts-engine --locked --example run -- target/hello.etb
cargo run -p embedts-builder --locked -- app examples/games/snake --out target/snake
python3 scripts/build_examples.py target/apps
```

构建器将 SDK 与标准编译配置嵌入原生二进制，`target/debug/embedts` 复制到其他目录后仍可编译 SDK 应用。`embedts.workspace.json` 显式声明可按包名导入的本地源码包；输入文件的最近上级工作区生效。任意 npm 包尚未纳入运行时子集。

## SDK 与编辑器

pnpm 工作区提供编辑器包链接和快捷命令。SDK 与应用辅助代码统一位于 `sdk/`，应用通过 `@dango/sdk/*` 导入。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm check:apps
pnpm --filter @dango-apps/snake build
```

TS 7 仍是预发布工具链。tsrs 提交、TypeScript 提交和 Rolldown 版本由构建器 `--version` 与 `Cargo.lock` 记录。

## 接入团子 OS

团子 OS 默认使用 Lua，显式 `ts-engine` feature 才链接外部 `embedts-engine`。OS 仓库保存 Rust 宿主适配与预编译输入，不保存 TS 源码或构建器。

OS 以 GitHub 地址和完整 commit SHA 固定引擎依赖，由 Cargo 获取；构建 OS 无需相邻的本仓库 checkout。重新构建应用或导出集成输入时，使用与 OS 依赖相同提交的工具链。

```sh
# 在本仓库导出 OS 的 brain、自检与集成测试输入；输出目录必须尚不存在。
cargo run -p embedts-builder --locked --example export-dangoos -- target/dangoos-inputs
# 审核 manifest.json 后，用整个导出目录替换 OS 的 artifacts/embedts。

# 构建应用后，在 OS checkout 中使用其打包器消费产物。
# cargo run -p app-pack -- bundle ../EmbedTypescript/target/apps/games/snake target/snake-bundle
# cargo run -p app-pack --no-default-features --features ts-engine -- system ../EmbedTypescript/target/apps target/system-ts --size 2031616
```

`.etb` 使用 `EMBEDTS\0` 魔数、格式版本、引擎指纹、宿主 ABI 和载荷摘要。brain 字符串接口使用 `etb1:` 十六进制信封。旧 `.rsts` 与新容器不兼容，固件、默认 brain、应用和 worker 需要使用匹配构建器重新生成。摘要不认证发布者，设备仅载入可信构建来源。

## 验证

```sh
cargo test --workspace --features embedts-engine/compiler --locked
pnpm typecheck
pnpm check:apps
python3 -m unittest discover -s tests/benchmarks -p 'test_*.py'
```

OS 的原生 UI、存储、brain 和两种固件选择在 OS checkout 独立验收。基准与设备探针通过 `--dango-root` 显式接入 OS 工具，主机构建与测试不要求设备在线。

本次拆分的本地检查、产物身份与未执行的验收项见[验证记录](docs/verification-20261104.md)。
