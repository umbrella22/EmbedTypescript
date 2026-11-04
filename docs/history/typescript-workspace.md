> 历史记录：路径、命令和包后缀对应拆分前的团子 OS 工作区。当前入口见 [EmbedTS 架构](../architecture.md)。

# TypeScript 开发入口

TypeScript 的 SDK、主机编译工具和示例集中在这里。正式应用仍按应用身份放在
`apps/<分类>/<应用>/{lua,ts}`，同一应用的两种实现使用相同安装 ID 和数据目录。

```text
typescript/
  compiler/             Rust crate ts-compiler，命令 dango-ts
    src/                类型检查、子集检查、模块打包与应用构建
    tests/              检查器与 CLI 回归测试
  sdk/                  一个 @dango/sdk 包
    src/api/            有类型的宿主接口适配
    src/helpers/        接受应用子集检查的公共代码
  examples/
    hello/              最小入口与控制台输出
    system-demo/        原生 LVGL、服务快照与存储
  tsconfig.base.json    共享严格类型选项
  tsconfig.json         工作区类型检查范围
```

根目录的 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 负责链接 SDK、
示例及 `apps/` 下的正式 TS 应用。Rust 编译器依赖由根 `Cargo.lock` 固定。

## 直接使用 Rust 工具

按根 `rust-toolchain.toml` 安装 Rust，并先执行 `cargo fetch --locked`。
`dango-ts` 直接调用 tsrs 和 Rolldown 的 Rust API；检查、编译、单应用资源组装及
固件内置 TS brain 构建都不需要 Node.js 或 pnpm。

```sh
# 仓库根目录
cargo run -p ts-compiler --locked --offline -- check typescript/examples/hello/scripts/main.ts
cargo run -p ts-compiler --locked --offline -- app typescript/examples/hello --out target/hello-ts
cargo run -p ts-engine --example run --locked --offline -- target/hello-ts/ts-hello/scripts/main.rsts
```

`app` 输出目录必须尚不存在。需要重建时使用新目录，或先清理自己的旧构建目录。

## pnpm 工作区

需要 Node.js ≥24.11.1、pnpm 12.14.0，以及同一套 Rust 工具链。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm check:apps
pnpm --filter @dango-apps/snake build
```

pnpm 的 `dango-ts` 入口是调用 Cargo 的 shell 脚本；`pnpm typecheck` 使用固定的
上游 tsrs CLI，对完整 SDK 和应用做工作区类型检查。设备包由 Rust 工具生成。
pnpm 的 shell 启动器面向 macOS/Linux；需要绕过 shell 启动器时直接使用 Cargo 命令。

应用导入公开包名，不依赖编译工具所在目录：

```ts
import { sleep } from "@dango/sdk/system";
import * as ui from "@dango/sdk/ui";
import { Random } from "@dango/sdk/game";
```

详见 [编译器与规则](compiler/README.md)、[SDK](sdk/README.md) 和
[工具链架构与验证](../docs/plans/ts-toolchain-workspace.md)。
