# 仓库拆分验证记录 · 2026-11-04

EmbedTS 构建器、引擎、SDK、应用源码和源码侧验证工具已迁入独立的 EmbedTypescript 仓库。团子 OS 默认使用 Lua，通过互斥的 `ts-engine` feature 接入外部 `embedts-engine`，只消费预编译的 EmbedTS 输入。

## 交付边界

| 仓库 | 保存内容 |
| --- | --- |
| EmbedTypescript | `builder/`、`engine/`、`sdk/`、`examples/`、TS 夹具、设备探针与基准工作负载 |
| 团子 OS | Lua 应用、Rust 宿主适配、app-pack、设备传输、预编译 `.etb` 输入及哈希清单 |

对 OS 工作目录的扫描排除构建缓存、依赖安装目录与 Git 内部数据后，`.ts`、`.tsx`、`.mts`、`.cts` 文件数量为 **0**。OS 的固件构建和测试均不调用源码构建器。

五个应用的 `main.ts`、QuickJS 上游源码与两个已有内核优化补丁在迁移时保持字节一致。引擎移除了对 OS `app-host` 的依赖，分配器回调按值保存；宿主平台仍通过 Rust `Host` 接口接入。

## 产物身份

- 构建器：`embedts-builder 0.1.0`，CLI 为 `embedts`。
- 类型工具链：tsrs `0.20.1`，提交 `77d3cddb44540734abc33a42ccca4d3f33bee527`；TypeScript `7.1.0-beta`；Rolldown `1.2.16`。
- 格式：EmbedTS Bytecode，扩展名 `.etb`，魔数 `EMBEDTS\0`，格式版本 `1`，宿主 ABI `3`。
- 引擎 ID：`ee250cff0a7d84a7ad12e21fcf380fe1ae3d85c60f1e75ea6f151bb809518eef`。
- OS 固定输入：18 个包，包括默认 brain、自检与宿主集成夹具；源码和产物摘要均与导出清单一致。
- 应用集合：2048、Dino、Flappy、Snake、Photo、hello、system-demo，共 7 个；载荷不包含 TS 源码。

旧 `.rsts` 不能直接改名安装。新固件、默认 brain、应用和 worker 需使用匹配引擎重新生成。brain 字符串接口使用 `etb1:` 信封。

## 本地验证结果

| 检查 | 结果 |
| --- | --- |
| EmbedTS Rust workspace | 82 个测试通过 |
| SDK 与示例 | `pnpm typecheck`、`pnpm check:apps` 通过，覆盖 7 个应用 |
| 基准协议 | 11 个 Python 测试通过 |
| 构建器独立使用 | 复制 CLI 后，在空 `PATH` 且无源码 checkout 的目录编译 SDK 应用通过 |
| 设备运行时配置 | 关闭源码解析器后载入最终 hello 包，输出 `emit=42`、`main=Some(42)`，关闭后引擎记账为 0 |
| 来源与格式 | 19 个 QuickJS vendored 文件摘要、Rust 格式与引擎独立依赖检查通过 |
| OS 完整检查 | `./scripts/check.sh` 通过；948 次 Rust 测试执行通过、4 次忽略，包含两种配置的重复执行；123 个 Python 宿主工具测试通过 |
| app-pack 引擎选择 | Lua、TS 两种配置各 6 个测试通过，包括 TS system 镜像往返检查 |
| 应用交付 | 7 个应用完成校验、独立 bundle 导出及 TS system 镜像生成与回读验证 |
| 固件 | ESP32-S31 Lua、TS 两种配置交叉构建通过，资源预算与 3241 个 C 符号碰撞检查通过 |
| 引擎隔离 | Lua ELF 无 QuickJS；TS ELF 无 Lua 且无源码编译器；未选择或同时选择两种引擎均按预期构建失败 |
| 跨仓库基准 | 一轮主机 smoke 的 Lua/TS 工作负载校验和全部正确；该运行只验证流程，不用于性能结论 |

最终 OS 固件构建输出与 Lua 配置 ELF 字节一致。ELF SHA-256：

| 配置 | SHA-256 |
| --- | --- |
| Lua | `c46a122de741b3e11a7e375657ce45e451b2f3792d1d141428b1980ae83432df` |
| TS | `62f50d51068f166a01b6891ae75f5059ff0e262438da9c1f87139566d63df6b8` |

本地日志保存在本仓库 `target/split-tests.log`、`target/bytecode-only-run.log`、`target/bench-split-smoke/`，以及 OS 仓库 `target/repository-split-20261104/`、`target/engine-checks/`。这些目录是构建证据，不进入版本控制。固定输入清单位于 OS 的 `artifacts/embedts/manifest.json`。

额外运行的 OS `cargo fmt --all --check` 在共享 UI 批处理等已有修改上报告格式差异。本次未对整个 OS 工作区统一格式化；EmbedTS workspace 的同项检查通过。该格式差异不影响上述测试与固件构建结果。

## 开发与验收范围

首次本地拆分验证使用相邻 checkout 的 `EmbedTypescript/engine` 路径依赖，默认 Lua 构建也需要这个 checkout。后续消费配置改为 GitHub 完整 commit 依赖，当前接入方式见[架构](architecture.md)。独立 EmbedTS workspace 的构建测试不需要 OS；基准宿主 runner、设备安装和 brain 验收通过显式 OS 路径接入。

本记录对应首次本地拆分验证快照，当时外部仓库尚未推送，远端 CI 与版本发布未执行。GitHub 提交、依赖切换和设备结果由消费端的后续验证记录分别绑定，不计入本次本地检查数量。

首次本地拆分验证时未检测到设备串口，未刷写固件或执行新 `.etb` 格式的物理验收。此前旧格式的上机观察不计入本记录的设备结果。后续设备验收应使用相同引擎 ID 的最终固件和包。

后续复验入口见[架构与验证分层](architecture.md)及[验证入口](../tests/README.md)。
