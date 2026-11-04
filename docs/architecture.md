# EmbedTS 架构

EmbedTS 将 TypeScript 源码构建成 `.etb`（EmbedTS Bytecode）应用，在提供 Rust 宿主接口的嵌入式系统上执行。

```mermaid
flowchart LR
  TS[应用与 SDK] --> Check[builder: tsrs 类型检查与转换]
  Check --> Bundle[Rolldown 单模块打包]
  Bundle --> Compile[QuickJS 字节码编译]
  Compile --> ETB[.etb 与应用资源]
  ETB --> Verify[engine: 包格式与兼容性校验]
  Verify --> VM[有界 QuickJS VM]
  VM --> Host[系统 Rust 宿主适配]
  Host --> HW[RTOS / LVGL / 设备服务]
```

## 模块职责

- `rust/builder/`：主机 Rust CLI `embedts`，类型检查、模块打包、字节码生成与原子应用组装。构建器内置编译配置与 TypeScript 标准库，SDK 作为应用编译时的显式源码输入。Rust 编译与测试不读取 TypeScript 工作区。
- `rust/engine/`：`no_std + alloc` QuickJS-NG 引擎、内存记账、执行预算、异步任务、worker 和包校验。`compiler` feature 仅供主机构建器与引擎测试使用。
- `typescript/packages/sdk/`：宿主服务的 TypeScript 类型与辅助代码，公共入口为 `@dango/sdk/*`。服务协议由团子 OS 的 Rust 适配实现。
- `typescript/examples/`：独立示例、游戏、工具应用和默认 brain 源码。
- `tests/integration/`：跨仓库宿主契约夹具、设备验收与脚本引擎对比基准。

引擎仅依赖通用 Rust 库与 vendored QuickJS，不依赖团子 OS、app-host、LVGL 或 ESP HAL。引擎定义 allocator 回调，宿主提供分配函数。SDK 与团子 OS 服务协议对应，其他嵌入系统可实现自己的 Host。

## 工作区与 SDK 输入

`rust/` 是独立 Cargo 工作区，包含构建器与设备引擎。`typescript/` 是独立 pnpm 工作区，包含 SDK、应用和原生命令入口。根目录的脚本与 `tests/integration/` 连接两者；根 `embedts.workspace.json` 为跨工作区夹具声明 SDK 与应用包。

构建器从输入文件最近上级的 `embedts.workspace.json` 读取 `sdk` 与 `packages`。SDK 路径相对于配置目录解析，允许引用工作区外已安装的依赖；普通源码包继续限定在声明它们的工作区内。`--sdk` 或 Rust `BuildOptions.sdk` 显式覆盖项目 SDK 选择。

SDK 的 `package.json` 声明名称、版本、TypeScript exports 与 `embedts.hostAbi`。构建器在类型检查前验证 ABI。所选 SDK 的 `src/api/` 接受完整语义检查，内部适配代码可使用类型转换；`src/helpers/`、普通源码包与应用入口同时接受设备子集检查。目录名称本身不赋予 API 身份；SDK 的原生声明必须由 `./native` 导出并位于 API 目录内。SDK 是受信任的宿主适配输入。

SDK 的 `src/` TypeScript 文件与公开 exports 作为编译根输入参与发射，包括安装到 `node_modules` 的源码包及内部相对模块；普通 npm 依赖仍受应用导入规则限制。应用报告记录构建器、SDK、引擎指纹与宿主 ABI。类型或兼容性检查失败时不替换既有输出。纯 TypeScript 程序可以不提供 SDK；使用宿主服务的程序需要所选 SDK 的类型和实现。

## 原生命令与分发

`@embedts/builder` 通过子进程运行原生 CLI，透传参数、当前目录、输出与退出状态。应用命令使用显式 `EMBEDTS_BIN` 或项目 `.embedts/active.json` 中的安装记录。`embedts-toolchain.json` 持久保存构建器版本、引擎指纹与宿主 ABI，入口在运行命令前核对真实身份；安装记录还关联平台、架构和二进制摘要。

本地工具链构建显式调用固定 Rust 版本与 Cargo 锁文件。预编译安装读取分发 JSON 清单及同目录二进制，检查摘要和真实身份后，以内容摘要保存二进制，再原子替换活动安装记录。失败保留已有活动记录。清单提供完整性与兼容信息，来源信任由分发渠道保证。

CI 的 Rust 检查先只取得 Rust 源码与仓库脚本，完成测试后恢复集成输入。TS 检查只取得 TS 工作区与仓库脚本，从前一个 job 接收原生二进制。分发检查从打包产物安装到临时工程，验证命令入口和直接原生命令在空 PATH 下构建相同 `.etb`。

## 固件边界

团子 OS 保存 Lua 源码应用、Rust 宿主适配以及预编译的 EmbedTS 应用和夹具。TS 源码构建在 EmbedTS 仓库执行，固件构建与 OS 测试不调用构建器。Lua 与 EmbedTS 的固件 feature 互斥，默认启用 Lua。

消费方通过 GitHub 仓库地址和完整 commit SHA 固定 `embedts-engine`，由 Cargo 拉取依赖并写入锁文件。OS 构建不要求相邻的 EmbedTypescript checkout，CI 使用同一锁定提交。应用源码构建、夹具重新导出和设备探针仍在本仓库执行；只构建 OS 时无需安装构建器或 pnpm 工作区。

## 包与信任边界

`.etb` 是 EmbedTS 自定义的字节码容器。包头包含格式版本、引擎指纹、宿主 ABI、载荷长度和 SHA-256。扩展名用于入口路由，载入前还必须验证包内容。指纹覆盖 QuickJS 源码、核补丁和桥接构建配方，主机与设备共享兼容性标识。

加载按顺序校验格式、长度、引擎与 ABI、摘要，再进入 VM。兼容性失败要求使用匹配构建器重新生成应用。摘要只发现损坏；QuickJS 字节码只接受可信构建来源。brain 的字符串接口使用 `etb1:` 十六进制信封，保留事务替换语义。

## 验证分层

引擎测试覆盖生命周期、资源预算、异步任务、worker、宿主 ABI 和核补丁。构建器测试覆盖 TS 限制、类型诊断、SDK 导入、原子输出与不依赖源码 checkout 的原生 CLI。OS 集成测试执行预编译夹具，验证真实存储、图形、原生 UI 和 brain 事务。设备验收要求最终固件与同指纹的 `.etb`，历史报告不能替代新格式的上机证据。
