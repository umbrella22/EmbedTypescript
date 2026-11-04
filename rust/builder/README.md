# embedts / embedts-builder

将受限 TypeScript 工程构建为 dangoOS `embedts-engine` 可执行的 `.etb` 包。
主机工具本身由 Rust 编写，直接调用 tsrs、Rolldown 和固定的 QuickJS-NG 编译器。
`.etb` 是运行时文件格式，`embedts` 是开发命令，两者独立命名。

## 编译链与依赖

`Cargo.toml` 将 tsrs 固定在 `v0.20.1` 的 Git 提交
`77d3cddb44540734abc33a42ccca4d3f33bee527`，使用 TypeScript `7.1.0-beta` 语义。
tsrs 的 Rust 库尚未发布到 crates.io，因此使用固定提交；`Cargo.lock` 锁定传递依赖。
Rolldown 固定为 crates.io `1.2.16`，QuickJS-NG 来源由
[`embedts-engine`](../engine/README.md) 管理。这是预发布 TS 7 工具链。

同一个 tsrs program 对原始 TS AST 做语义检查、应用子集检查，再输出 ES2020 JS。
Rolldown 的 Rust API 合并这些 JS 模块，最终只保留 `dango:host` 原生导入。
Rolldown 负责模块打包；语义与类型相关规则由 tsrs 执行。
打包后执行 AST 压缩，保留函数、类和属性名，再交给 QuickJS 生成字节码。
`src/frontend.rs` 管理单次编译的程序、checker 和内存区域，返回前释放；
`src/subset.rs` 管理运行时子集，`src/bundle.rs` 管理单模块输出。

## 使用

需要`rust/` 工作区的 `rust-toolchain.toml` 指定的 Rust。首次获取依赖后可离线构建：

```sh
cd rust
cargo fetch --locked
cargo run -p embedts-builder --locked --offline -- check ../typescript/examples/system-demo/scripts/main.ts
cargo run -p embedts-builder --locked --offline -- build ../typescript/examples/hello/scripts/main.ts --out target/hello.etb
cargo run -p embedts-engine --example run --locked --offline -- target/hello.etb
cargo run -p embedts-builder --locked --offline -- app ../typescript/examples/games/snake --out target/snake-ts
cargo run -p embedts-builder --locked --offline -- --version
```

`check` 执行完整语义检查、原始 TS AST 规则检查及模块打包。
`build` 通过检查后生成字节码，先写临时文件再原子替换；失败保留已有输出。
`app` 输出 `<id>/` 载荷和 `build-report.json`，目标目录必须尚不存在；
源码目录名不决定安装身份，最终使用 launcher 中的 ID。
CLI 内置编译配置与 TypeScript 标准库；SDK 和本地包导出从输入上级的 `embedts.workspace.json` 读取。`sdk` 是 SDK 源码目录，`--sdk SDK_DIR` 可显式覆盖。SDK 包的 `embedts.hostAbi` 必须与构建器一致。
原生二进制与所选 SDK 可复制到独立工程，编译过程不调用 Node 或 Cargo。固件只消费预编译输入。

pnpm 工作区为编辑器链接包名，并提供调用 Cargo 的 shell 启动器：

```sh
pnpm -C typescript install --frozen-lockfile --ignore-scripts
pnpm -C typescript typecheck
pnpm -C typescript check:apps
pnpm -C typescript --filter @dango-apps/snake build
```

`pnpm typecheck` 使用固定上游 tsrs CLI；正式设备包始终由 Rust 编译器生成。
Node.js/pnpm 用于这套可选开发入口。单应用 `pnpm build` 调用
`embedts app . --out dist`，输出目录须尚不存在。

## 应用模型

入口为 `.ts` 文件，必须直接导出 `main()`，可选直接导出 `onTick(at: number)`。
二者可同步返回 `void` / `number`，也可返回对应 Promise。运行时的入口数值仍限定
为精确 int32。`onTick` 参数是启动毫秒的低 32 位有符号表示；完整单调时间使用
`system.nowMs()`。异步 `main` 完成后才开始调用 `onTick`。

```ts
import { print, sleep } from "@dango/sdk/system";
import * as storage from "@dango/sdk/storage";

export async function main(): Promise<void> {
  await storage.writeText("hello.txt", "团子 OS");
  await sleep(20);
  print(await storage.readText("hello.txt"));
}
```

相对模块支持 `import { value } from "./helper.js"`，解析到 `helper.ts`。
所有传递导入的应用源码都接受相同规则检查。SDK 的 `src/api/` 作为可信宿主适配边界参与 TS 7
类型检查；`src/helpers/` 接受完整应用子集检查。应用可导入仓库
`embedts.workspace.json` 声明包的 package.json 中明确导出的 TS 文件；公共代码继续接受应用子集检查。
任意 npm 依赖尚未开放。SDK 源码位于 `typescript/packages/sdk/`，应用编译时读取，SDK 更新不要求重新编译 Rust 构建器，游戏辅助通过 `@dango/sdk/game` 导出。`dango:*` SDK 名称保留为既有独立客户端的别名。

| 模块 | 接口 |
| --- | --- |
| `@dango/sdk/system` | 时间/date、args、schema 支持、堆指标/探针、能力/服务字典、音量/静音、sleep/delayUs、Periodic |
| `@dango/sdk/hardware` | 快照、Imu/FuelGauge/Magnetometer、校准、Button 的 11 种事件、LedStrip 和 13 种 haptic |
| `@dango/sdk/storage` | 应用根、join、exists/stat、递归 mkdir、list、二进制/UTF-8 文本读写、remove/rmdir/rename |
| `@dango/sdk/ui` | 共享原生 LVGL 的所有操作：screen/widget、样式/布局、事件、canvas/image、回调注销与重绘提交 |
| `@dango/sdk/display` | 单/双缓冲画布、图形、颜色/透明度、内置字体/DFN1、clip/translate、bitmap/image、touch、发布回执 |
| `@dango/sdk/image` | JPEG/PNG、RGB565/BE/RGB888/BGR888/GRAY8、nearest/bilinear、JPEG 保存和资源关闭 |
| `@dango/sdk/thread` | 独立字节码 worker、参数、名称/互斥组/替换、停止/状态、二进制队列、信号量和归属锁 |
| `@dango/sdk/schema` | int/bool/object 参数默认值和边界 |
| `@dango/sdk/brain` | 受限常驻 VM 的输入、响应、表情、动画、触觉、视觉、命令和 LED |
| `dango:host` | 数值时钟/延时/绘图，以及按值、二进制、组合或 void 返回的同步/异步传输；详见[宿主 ABI](../../docs/host-abi.md) |

`system.isHostError(error)` 将捕获值缩小到带数值 `code` 的服务错误。普通服务失败
可以捕获；执行超时、引擎 OOM 和内部宿主故障终止实例。TS 存储的相对路径从
`/data/appdata/{app-id}` 解析；绝对路径遵循 VFS 挂载与只读规则。文本必须是有效
UTF-8，二进制数据通过 Uint8Array 读写，传输只复制视图范围。

原生 UI、图像对象与事件在原有 UI 任务执行，SDK 只接收 runtime 内的数字句柄。
`ui.processEvents()` 逐个等待回调，记录回调错误并继续，最终提交重绘；`ui.run()`
持续处理事件。停止应用会撤销未完成的 Promise、释放 UI 和 LED 请求；已经开始的
存储操作先完成，随后公布实例退出。

## 运行时子集规则

允许有类型的局部数据、声明过的对象属性、数字索引数组/tuple/typed array、函数、
async/await 及受限内建对象。构建拒绝：

- 显式/隐式/传播的 `any`、类型断言、非空断言和类型检查抑制指令；
- `delete`、未声明属性、动态字符串索引和原型/构造器/对象形状修改入口；
- `eval`、`Function`、`Proxy`、`Reflect`、`globalThis`、`require` 与 `Object` 入口；
- Date、正则、WeakRef、FinalizationRegistry、Atomics 和 SharedArrayBuffer；
- 工作区以外的包导入、动态导入、re-export、应用 ambient 声明及顶层 await。

TypeScript 7 的版本升级没有扩大设备 intrinsic 集合。上述规则定义开发子集，不能
验证敌对字节码的安全性。历史能力对齐记录见
[对齐矩阵](../../docs/history/ts-engine-parity.md)。

```sh
pnpm check
cargo test --workspace --features embedts-engine/compiler --locked
```

## 原生文件与常驻脚本

`image.loadFile`、`Frame.saveFile` 与 `display.loadFont` 使用 services 执行器上的
VFS，文件字节留在宿主，JS 只取得图像/字体句柄或完成回执。图像输入上限 4 MiB、
1920×1080 像素，DFN1 上限 1 MiB。图像和 framebuffer 的原生配额与 JS 账本
分别检查；PNG 的 RGBA/解压暂存可能使有效尺寸低于格式上限。

常驻 TS 模块导出同步 `main` 与 `onEvent`，通过 `brain.input()` 取输入，
通过 `brain.respond()` 返回响应。该 VM 禁止异步工作与前台宿主 API。
`console.py brain-push script.etb` 通过 `etb1:` envelope 使用既有事务替换协议，
持久选择与 Lua 文件分别保存。`brain-default` 恢复内置 TS 行为，故障回退到原生行为。

应用集使用 `python3 scripts/build_examples.py target/apps` 生成。
设备验证探针源码位于 `tests/integration/device/ts-parity/`，不进入正式应用集。
