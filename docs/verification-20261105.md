# 双工作区与原生工具链分发验证（2026-11-05）

## 实现范围

`rust/` 是独立 Cargo 工作区，包含 `embedts-builder` 与 `embedts-engine`。`typescript/` 是独立 pnpm 工作区，包含 `@embedts/builder`、`@dango/sdk` 和应用。工具链及 SDK 版本为 `0.2.0`。

SDK 从项目声明或 `--sdk` 指定的目录读取，Rust 编译不再嵌入 SDK。SDK 的 `src/` 文件和公开 exports 作为应用编译根输入，保证安装在 `node_modules` 中的 API、内部相对模块和 helper 都能发射。API 接受完整类型检查，helper、普通源码包和应用入口同时接受子集规则。

Node 命令入口校验并执行预先安装的原生二进制；本地 Cargo 构建通过显式 `toolchain:build` 触发。分发安装检查平台、架构、SHA-256、真实身份以及项目的版本、引擎指纹、宿主 ABI 锁。应用报告记录工具链和 SDK 身份。

## 本地环境与身份

验证主机为 macOS arm64，Rust `1.99.1`，Node.js `24.11.1`，pnpm `12.14.0`。本地验证使用原生 debug 构建器，分发包和独立消费测试也使用该二进制；多平台 release 构建由独立工作流配置。

| 身份 | 值 |
| --- | --- |
| 构建器 / 引擎 crate | `0.2.0` |
| SDK | `@dango/sdk@0.2.0` |
| tsrs | `0.20.1`，提交 `77d3cddb44540734abc33a42ccca4d3f33bee527` |
| TypeScript | `7.1.0-beta` |
| Rolldown | `1.2.16` |
| `.etb` 格式 / 宿主 ABI | `1` / `3` |
| 引擎指纹 | `ee250cff0a7d84a7ad12e21fcf380fe1ae3d85c60f1e75ea6f151bb809518eef` |

## 已完成检查

| 检查 | 结果 |
| --- | --- |
| 根 `scripts/check.sh` | 来源校验、格式、Rust / Python / Node 测试、类型和应用检查全部通过 |
| Rust 测试 | 85 项通过，覆盖编译规则、SDK 输入、原子输出、VM、包、宿主 ABI、预算、worker 与核补丁 |
| 独立 Rust 目录 | 复制整个 `rust/` 到临时目录；不存在相邻 TS 工作区；85 项测试通过 |
| 真实 SDK 集成 | 2 项测试通过；类型导入、异步服务、原生接口与 helper 使用正式 SDK 构建 |
| SDK / 原生 CLI 独立复制 | 复制到 Unicode / 空格路径；空 PATH 下构建成功，应用报告身份正确 |
| 基准协议 | 11 项通过；环境收据能读取迁移后的 `rust/Cargo.lock` 并排除 Python 缓存 |
| 原生命令与安装器 | 9 项通过；覆盖参数 / cwd / 退出码、缺失工具、校验损坏、版本 / ABI / 指纹不匹配、平台不匹配、HTTP 清单安装与失败保留当前安装 |
| 独立 TS 目录 | 复制 TS 工作区及仓库集合脚本到临时目录；不存在 Rust 目录；安装分发后通过 9 项命令测试、类型 / 应用检查并构建 7 个应用 |
| 分发消费工程 | 从两个本地 `.tgz` 安装到临时工程；安装原生清单；命令入口和原生命令在空 PATH 下构建相同 `.etb` |
| 应用集合 | 7 个应用构建成功，集合报告保留工具链与各应用 SDK 身份 |
| OS 输入导出 | 18 份默认 brain、自检与集成夹具生成成功 |
| 设备探针构建 | 6 份前台 / worker / brain 字节码生成成功；未执行设备 IO |
| 工作流 / 脚本 | `actionlint`、YAML 解析、Bash 语法、Python 编译与 Git whitespace 检查通过 |

分发消费检查验证了安装到 `node_modules` 的 SDK 内部模块会输出 JS，并检查设备载荷不包含 npm 锁文件、源码、项目工具链配置或本地安装目录。Node 命令入口和直接原生命令生成的包逐字节相同，包头指纹、ABI 与载荷摘要独立核对。

## 复现入口与本地证据

从仓库根目录执行：

```sh
(cd rust && cargo fetch --locked)
pnpm -C typescript install --frozen-lockfile --ignore-scripts
./scripts/check.sh
pnpm -C typescript toolchain:build --offline
python3 scripts/build_examples.py artifacts/apps
(cd rust && cargo run -p embedts-builder --locked --offline --example export-dangoos -- ../artifacts/dangoos-inputs)
python3 tests/integration/device/ts-parity/build.py artifacts/device-probe
```

分发可从已有原生二进制构造并验证，所有输出目录需为新目录：

```sh
python3 scripts/package_toolchain.py --binary rust/target/debug/embedts --out artifacts/distribution
mkdir -p artifacts/packages
pnpm -C typescript/packages/builder pack --pack-destination ../../../artifacts/packages
pnpm -C typescript/packages/sdk pack --pack-destination ../../../artifacts/packages
python3 scripts/check_distribution.py --distribution artifacts/distribution --packages artifacts/packages --receipt artifacts/distribution-check.json
```

本地证据保存在忽略的 `artifacts/workspace-migration-20261105/`：`checks.log`、两份独立工作区日志 / JSON、`distribution-final/`、`packages/`、`distribution-check.json`、`apps/`、`dangoos-inputs/` 与 `device-probe/`。原有构建缓存通过显式 `CARGO_TARGET_DIR` 复用；未清理此前产物。

## CI 与验收边界

常规 CI 先以 sparse checkout 检查没有 TS 目录的 Rust 工作区，再恢复集成输入；TS job 使用前一个 job 的预编译构建器，并检查不存在 Rust 目录。TS job 对独立分发的消费检查通过后上传原生清单、二进制、npm 包和收据。

多平台工作流为 Linux x64、macOS arm64、macOS x64 配置 release 构建，支持手动调度与匹配版本的 `embedts-v*` 标签。工作流产出可下载的 GitHub Actions artifacts；公开 npm 发布和 GitHub Release 创建单独执行。

本记录的通过结论来自上述本地 macOS arm64 检查。托管 CI、多平台 release 构建、Windows、OS 完整构建、原生 UI 和实体设备验收不由这些结果代替。此迁移未更新 OS 消费端固定的 Git revision 或其预编译输入，也未创建公开发行版。
