# embedts-engine

嵌入式宿主使用的 `no_std + alloc` QuickJS-NG 字节码执行器。TS 源码由主机工具
[`embedts`](../builder/README.md) 检查、转译并编译；固件只接受 `.etb` 字节码包。
当前实现提供字节码模块、同步/异步入口、有界宿主请求、复制回执和 Promise job 处理。

## 引擎与构建

QuickJS-NG 固定在提交 `e22ce4de4362dc5fd4794cfa3c03fc7fdba5f015`。
`vendor/quickjs-ng.json` 记录上游地址、MIT 许可及每个文件的 SHA-256。
上游源文件原样保存，`build.rs` 在构建副本中应用
[内核补丁](patches/quickjs-ng/README.md)，并适配单线程和设备时钟。
补丁内容和构建配方计入包的引擎指纹，主机编译器与设备运行时必须使用同一配置。
S31 固件使用消费工程配置的 Espressif GCC/newlib；其他目标由宿主选择对应 C
工具链与 libc。

解释器优化使用可移植 C 实现，数值仍遵循 binary64 语义。指令组合保留原来的
操作顺序和中断检查，不要求应用改写算法或使用设备专属 API。不同 CPU 的代码布局、
缓存和浮点硬件会影响收益；性能结论按实际测试架构记录。

没有 32 位原子比较交换指令的目标通过 `portable-atomic` 分配唯一实例编号；
宿主需提供 `critical-section` 实现。RV32IMC 的 ESP32-C3 和不具备对应原子指令的
Cortex-M 目标可使用这一路径。支持原子指令的目标使用 `core` 原子操作。

默认 feature 集为空，定义 `QJS_DISABLE_PARSER`。`compiler` 只供主机工具使用；
在 `target_os = "none"` 启用时直接构建失败。源码生成入口、Proxy、Date、正则、
WeakRef 和共享内存相关 intrinsic 不加入设备 context。C 桥保存全部 `JSValue`，
Rust 接口只传不透明 runtime 指针、字节和整数。

```sh
cargo test -p embedts-engine --features compiler --locked
cargo run -p embedts-engine --example run -- target/hello.etb
```

引擎不依赖 OS 的 app-host 或硬件库。OS 在 Rust 适配层实现 Host，并通过 feature 保证只链接一个 VM；固件普通依赖不启用 `compiler`。

## 解释器诊断

可选 `diagnostics` feature 记录每 VM 的执行指令数、实际分派次数、相邻指令组合
候选数和 QuickJS 分配函数调用数。`Vm::interpreter_diagnostics(reset)` 返回快照，
并可在读取后清零。`opcode_name` 把当前引擎的指令编号映射为名称。

```sh
cargo run -p embedts-engine --features compiler,diagnostics --release \
  --example interpreter-profile -- /absolute/path/workloads.js main 128
```

示例编译可信 JavaScript 模块，调用指定导出并输出 JSON；`compiler` 仍仅限主机。
设备只启用 `diagnostics` 即可读取预编译应用的计数。计数包括入口内的嵌套调用和
Promise jobs；模块加载后重置可排除初始化。相邻候选数可能包含随后抛出异常的指令，
不能视为已经成功合并的次数。分配调用数包含嵌套入口，不等于 backing 分配次数。

诊断功能为每个 runtime 增加 2,128 B 计数存储，计入引擎分配账本，并改变引擎指纹。
正式性能对照关闭该 feature；诊断数据描述执行工作量，不能直接换算为耗时比例。
默认构建没有诊断存储、计数更新或查询接口。

## 调用接口

`Vm::new` 接收 `Host`、`Limits` 与 `&RawAllocator`。
引擎按值保存 allocator 函数表，不保留表的借用。runtime 使用稳定的宿主状态地址，并通过 `!Send + !Sync` 限制跨线程移动。
`Host::emit(i32)`、`call`、`now_ms` 和 `draw` 在调用线程执行，回调必须有界、非阻塞且不 panic。
存储、UI 与计时等待通过 `Vm::take_request` 交给 OS，完成后调用 `Vm::complete`。

```rust,ignore
let package = embedts_engine::Package::parse(&bytes)?;
let mut vm = embedts_engine::Vm::new(
    Box::new(host),
    embedts_engine::Limits::default(),
    &embedts_engine::GLOBAL_ALLOCATOR,
)?;
// SAFETY: bytes 来自本工程固定编译器和可信交付链。
unsafe { vm.load(package)?; }
let result = vm.call("main", None)?;
let jobs = vm.drain_jobs(32)?;
let stats = vm.close();
assert_eq!(stats.used, 0);
```

`call` 的 `None` 表示没有该可选导出；存在的导出返回 `void` 时得到 `Some(0)`。
参数和非空返回值必须是精确的有符号 32 位整数，拒绝小数、NaN、Infinity、字符串
及 Promise 返回值。异步调用使用 `start` 和 `entry_status`，得到 `Missing`、
`Done(i32)` 或 `Pending`。每个实例同时只允许一个等待中的入口；`drain_jobs` 与
宿主请求处理可以在等待期间继续推进。原生传输模式、时钟、数值延时与绘图接口见
[宿主 ABI](../../docs/host-abi.md)。

OS 前台任务先调用 `main()`，随后每约 20 ms 调用可选 `onTick(at: number)`。
`at` 是启动后毫秒数的低 32 位，按有符号整数传递；应用需要处理回绕。
无 `onTick` 的应用在入口完成、Promise jobs 与宿主请求都耗尽后结束。异步 `main`
完成后才开始 `onTick`；等待中的 tick 不会重入。系统、服务、硬件、存储与原生 UI
接口由 [@dango/sdk](../../typescript/packages/sdk/README.md) 提供。

## 执行与内存限制

| `Limits` 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `memory_bytes` | 2 MiB | 引擎 backing allocator 上限，包括对齐头与 C 桥 |
| `host_bytes` | 2 MiB | 在途复制参数总量，以及单次参数/回执的传输上限 |
| `pending_requests` | 16 | 包含已交给宿主、尚未完成的请求 |
| `stack_bytes` | 24 KiB | QuickJS 的 C 栈使用检查范围 |
| `interrupt_polls` | 100 | 每次入口或 job pump 的中断轮询次数上限 |
| `execution_us` | 4,000 | 设置 `clock` 后使用的执行时间预算 |
| `clock` | `None` | 单调递增的微秒时钟；设备提供硬件时钟 |

QuickJS 在解释器检查点采样预算，原生 intrinsic 和宿主回调不能被任意抢占。
4 ms 是采样截止预算，不能保证 4 ms 内返回。没有时钟时仍使用轮询上限。
`drain_jobs(maximum)` 同时限制 job 数与采样时间；剩余任务由 `pending` 返回。
队列耗尽时检查未处理的 Promise 拒绝，同一队列内安装的处理器有机会先执行。

加载、调用和 job 执行的未捕获异常、OOM、内部宿主失败与预算耗尽会使实例进入故障状态。
普通服务失败以 `HostError` 抛出或拒绝对应 Promise，可以被 JS 捕获。
后续调用返回 `ErrorKind::State`，恢复方式是销毁并重建实例。
JS 的 `catch` 不能掩盖分配器或宿主记录的终止错误。

引擎内存通过可失败分配回调统计。设备回调使用 PSRAM，没有独立的 VM 物理分区。
QuickJS-NG 将小对象放入内部 4 KiB arena；`allocations` 统计这些页面和较大申请的
底层分配，不能解释为 JS 对象总数。arena 页面仍受同一个 backing allocator 预算约束。
Rust `Vm` 状态、`Host`、包字节、UI/图像及服务队列不属于 JS 账本。
复制传输受 `host_bytes` 与请求数限制；UI 沿用原生服务对象/图像配额。宿主 Rust
分配尚未使用独立可失败 arena，不能把传输上限称为所有宿主分配的硬上限。OS 前台
实例使用 4 MiB 引擎预算、20 ms 采样执行预算与 200 次中断轮询；crate 默认保持
2 MiB / 4 ms / 100 次。设备时钟排除 UI/app 线程被其他 RTOS 线程抢占的时间。
较重的绘制应在阶段间 `await system.sleep(0)`，最终 `present` 才发布整帧。
预算错误记录耗时、剩余轮询数与最慢同步宿主调用，供设备定位。
realloc 的新旧缓冲区同时存在时都计入预算。
`close()` 返回销毁后的 `used/peak/allocations/failures`；主机测试覆盖失败初始化和回收。

## 宿主请求与取消

`take_request()` 返回 `Request::Host(HostRequest)` 或 `Request::Delay { id, micros }`。
`HostRequest` 包含不透明 `RequestId`、操作名、JSON 参数和独立字节数组。编号组合
实例代次与实例内序号，重复完成和跨实例完成返回状态错误。Uint8Array 按视图范围
复制，包括空视图；字符串按显式长度传递，文件路径拒绝 NUL。

`complete(id, Ok(HostReply))` 复制结果并安排 Promise jobs，调用方随后继续 pump。
`complete(id, Err(HostError))` 拒绝请求。队列容量不足属于可捕获错误；分配 JS 回执
时发生 OOM 仍使实例终止。数值延时通过 `complete_void(id)` 完成，不构造成功回执。
C 桥在初始化时分配有界等待槽位，复用 resolve/reject 引用，销毁时统一释放。

OS 为 UI 回执保留同一请求编号，丢弃旧实例回执；存储在 services 执行器运行。
停止后不再安排新的工作，已开始的存储先结束，随后销毁实例并通知 shell。

## 独立 worker

`workers::Group` 为每个工作任务创建独立 VM。父任务在存储、显示、UI 或计时等待时
继续 pump 工作任务。worker 仅可访问纯 JS、参数、时间、日志、队列、信号量和锁，
硬件、图像、显示、存储与嵌套创建均不可用。停止、超时和故障释放该任务持有的锁。
队列复制二进制消息；注册表、队列预留字节、日志、历史与活动实例分别有界。

## 包格式与可信来源

所有整数使用 little-endian。包必须精确匹配长度，不允许尾随字节。

| 偏移 | 字节数 | 字段 |
| --- | --- | --- |
| 0 | 8 | `EMBEDTS\0` |
| 8 | 2 | 格式版本 `1` |
| 10 | 2 | flags，当前为 `0` |
| 12 | 4 | 非零 bytecode 长度 |
| 16 | 32 | `ENGINE_ID` |
| 48 | 4 | `HOST_ABI`，当前为 `3` |
| 52 | 32 | bytecode SHA-256 |
| 84 | 变长 | QuickJS-NG ES module bytecode |

`ENGINE_ID` 覆盖固定源码、桥接代码及构建配方；编译器开关不改变兼容标识。
修改配方或桥接后需要重建应用包。设备应用读取策略另设 256 KiB 包大小上限，
该策略不属于包格式的长度范围。

ABI 3 与之前的包不兼容；不提供旧包转换或加载分支。固件、默认 brain、应用和
worker 必须一起重建。C 构建默认使用 `-O2`，`EMBEDTS_QJS_OPT_LEVEL=3` 仅用于构建对照。

摘要发现损坏，兼容标识拒绝其他引擎配置；二者都不能认证发布者。
QuickJS bytecode 只能由可信编译器提供，`Vm::load` 因此是 `unsafe` 接口。
设备首版只面向受控开发安装；开放第三方分发前需要验证来源认证。
每次修改引擎配方后均需重建设备固件、应用及 worker 包。实体设备证据独立记录。

## 验证

`cargo test -p embedts-engine --features compiler --locked` 验证运行时故障、回收、包边界与核补丁。OS 的预编译集成、固件符号隔离及上机证据在消费端分别验证。接入边界见 [架构](../../docs/architecture.md)。
