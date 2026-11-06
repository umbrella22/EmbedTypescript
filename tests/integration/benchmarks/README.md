# Lua / TypeScript 计算跑分

同一套确定性工作负载分别运行在 dangoOS 的 Lua 5.5.1 和 TS / QuickJS-NG 引擎中。
TS 源码通过 `rust/builder/` 的 tsrs、Rolldown 和 QuickJS 字节码链路构建。
主机 runner 直接调用仓库中的生产 VM；每个可执行文件只链接一种解释器。

所有测试资料集中在这个目录，正式应用集不包含跑分程序：

```text
benchmarks/
  suite.json             工作负载名称、规模和让出间隔
  lua/main.lua           Lua 算法与应用入口
  ts/main.ts             TS 算法与应用入口
  reference.py           独立校验参考
  bench.py               本地构建、主机测量、日志比较
  test_protocol.py       证据协议回归

OS 仓库的 tests/benchmarks/script-engines/runner 提供真实宿主测量；build/host 命令通过 --dango-root 显式传入该 checkout。
```

构建产物采用相同应用 ID：`lua/script-bench`、`ts/script-bench`。设备每次只运行与
固件匹配的一个版本。源码不依赖 Node、浏览器、系统 Lua 或系统 JavaScript 引擎。

## 工作负载

| 用例 | 一个工作单元 | 主机 profile 的单次测量规模 | 校验参考 |
| --- | --- | --- | --- |
| `integer` | Park–Miller PRNG 迭代 128 次 | 8,388,608 次乘法、取模 | 模幂跳跃计算 |
| `mandelbrot` | 两个像素，每像素最多 64 次迭代 | 131,072 像素 | Python 复数迭代 |
| `primes` | 对连续的 8 个奇数做试除 | 131,072 个候选数 | 埃拉托色尼筛法 |
| `matrix` | 12 × 12 矩阵相乘的一行 | 4,718,592 次乘加 | 整数分子精确计算 |
| `sort` | 生成并手写插入排序 32 个数 | 8,192 组数组 | Python 内置排序 |
| `objects` | 16 个粒子，4 轮创建替换对象 | 655,360 个粒子对象 | 四步运动的闭式计算 |

每个单元使用固定输入。两种实现执行相同算法和循环次数，累计结果在模 1,000,000,007
下形成校验值。预热与每个正式样本都校验，结果错误会终止测试。

整数中间值小于 JavaScript 的精确整数上限；矩阵使用 2 的幂作为浮点分母，校验结果
可由整数精确还原。Lua 使用原生整数、浮点数和 table，TS 使用 number、Array 和对象。
TS 保留 EmbedTS 子集要求的索引检查。这些数值表示、对象访问和 GC 差异属于被测实现，
不能由某个用例推导一种语言在所有场景中的速度。

## 主机执行

从仓库根目录运行：

```sh
# 小规模往返检查，不用作性能结论
python3 -B tests/integration/benchmarks/bench.py host \
  target/script-bench-smoke --profile smoke --dango-root ../esp-32 --rounds 1

# release 构建，五轮独立进程，逐轮交替 Lua / TS 的先后顺序
python3 -B tests/integration/benchmarks/bench.py host \
  target/script-bench-host --profile host --dango-root ../esp-32 --rounds 5
```

输出目录必须不存在。依赖使用已锁定的离线 Cargo 缓存；输出包含：

- `report.md`、`report.json`：每组中位数、最小值、最大值、变异系数、比值和所有样本。
- `raw/`：每个进程的参数、事件、stderr、内存计数和最长 VM 调用。
- `environment.json`：CPU、操作系统、Rust、Git 状态、源码/二进制哈希和编译器版本。
- `apps/`：两种应用 payload、通过 app-pack 验证的 bundle、构建日志与收据。
- `bin/`：分别只启用 `lua`、`ts` feature 的 release runner。
- `runner/`：独立测量工作区和锁文件；复用 OS runner 源码，直接依赖本 checkout 的
  `rust/engine` 和所选 OS checkout 的 `crates/lua-engine`，避免测到 OS 锁定的旧 TS
  引擎。该工作区不修改 OS 的依赖或锁文件，运行时引擎指纹必须与编译器一致。

每轮创建一个新 VM，每个用例先完整预热一次，再测量一次。编译、模块加载、矩阵
初始化和预热都位于样本计时区间之外。runner 用 `Instant` 累计 `resume`、Promise
任务和请求完成等 VM 调用内的时间；样本同时记录从开始到结束的整轮耗时。
VM 耗时包含宿主回调、正常的 GC 和主机线程被操作系统抢占的时间。runner 调度循环、
打印终端和写结果文件在这个计时区间之外。主机按 profile 每 32 个单元让出一次。
Lua 使用 `coroutine.yield()`，TS 使用 `await system.sleep(0)`，都不请求固定时长的
休眠；Lua 的 `delay_ms(0)` 实际不让出，不能用于这项配对。宿主恢复和 Promise 桥的
成本参与测量，反映两种引擎的实际接口差异。

两种引擎均为解释器。此结果衡量当前 dangoOS 引擎与编译产物在当前主机上的表现。
CPU 频率、温度和后台负载未被固定；报告保留 CV 与原始样本，不输出合成总分。
主机硬件与 ESP32 的浮点、内存和调度差异会改变结果，设备排名必须实测。

内存指标是整个 VM 生命周期的峰值，包含初始化、所有用例和预热。Lua 统计请求的
分配大小，TS 还包含对齐头等开销，二者不是统一的 RSS。TS 另记录关闭后的分配账本；
Lua 没有对应接口，关闭后的字段为 null。自然 GC 参与测量，最终 VM 销毁位于计时之外。

## 设备构建与测量

本地生成较小分块、五个样本的设备短测包，不连接设备：

```sh
python3 -B tests/integration/benchmarks/bench.py build \
  target/script-bench-device --profile device --dango-root ../esp-32-quick
```

`device-quick` 用于短测；`device` 提供更大的计算规模，可能需要数分钟以上。
两种设备 profile 都在每个工作单元后让出一次。短测覆盖固定输入的子集，Mandelbrot
不会扫描完整图像，不能由短测推导完整分形扫描或持续高负载的速度。
单个单元保持较小，工作负载通过重复单元增加。
生产限制保持为 Lua 的 4 ms 切片和 TS 的 20 ms 执行预算、每 VM 4 MiB 内存。
主机通过不能证明任何单元在 ESP32 上都满足预算；若设备出现超时、内存不足、校验
失败或日志缺失，比较器会拒绝出分。缩小单元需要同步更新两份实现、参考和 suite 版本。

分别启动只启用 Lua 和只启用 TS 的正式固件，使用同一块板和同一份配置测试。
固件切换和上传方式沿用 [设备验收流程](../../../docs/history/ts-engine-device-validation.md)。
两份包使用同一个应用 ID，上传另一版本会覆盖测试应用。

以下命令仅在设备已连接并启动对应固件后执行；将 `<运行时端口>` 换成实际端口：

```sh
# Lua 固件
python3 ../esp-32/scripts/device/session.py --port <运行时端口> \
  --log target/script-bench-device/lua-device.log --seconds 600 \
  --push target/script-bench-device/lua/script-bench

# TS 固件
python3 ../esp-32/scripts/device/session.py --port <运行时端口> \
  --log target/script-bench-device/ts-device.log --seconds 600 \
  --push target/script-bench-device/ts/script-bench

# 两个日志都包含完整 done 后比较；比较器不访问设备
python3 -B tests/integration/benchmarks/bench.py compare \
  target/script-bench-device/lua-device.log \
  target/script-bench-device/ts-device.log \
  --device-info target/script-bench-device/device-info.json \
  --out target/script-bench-device-comparison
```

`device-info.json` 是手工保存的 JSON 条件记录，包含板卡、两份固件的 SHA-256、CPU
频率、供电、网络、屏幕与后台服务状态。该参数可以省略，但结果会标明条件未记录。
会话结束与上传成功只是传输证据，必须有完整事件和正确校验值才能生成比较报告。

设备计时使用应用的单调毫秒时钟，包含正常调度和合作式让出，代表在该系统负载下
完成整组任务的耗时。设备计时与主机 VM 耗时分别评估；同一次对比必须使用相同
profile、工作单元数量、预热次数、样本数、让出间隔和源码指纹。日志比较器拒绝
缺失、重复、乱序、校验错误或配置不同的运行。低于时钟分辨率时不计算速度比。

控制台每条日志含前缀最多 158 字节。事件以 `DANGO_BENCH_PART` 加事件序号、分片
序号、分片总数发送，每片正文为最多 64 个 ASCII 字符。宿主重组完整 JSON 后再
验证事件；缺片、重片、乱序或截断均拒绝出分。旧的完整 `DANGO_BENCH` 行仍可读取。

## 回归检查

```sh
cargo test --manifest-path ../esp-32/Cargo.toml -p script-bench-runner --locked --offline
python3 -B -m unittest discover -s tests/integration/benchmarks -p 'test_*.py'
```

Rust 检查 VM 区间计时与调度区间的分离。Python 检查独立参考向量、完整日志、错误
校验、重复/不完整运行、计时口径混用以及中位数计算。协议测试的合成数据只用于
校验比较器；实际性能报告来自生产 VM 执行源程序。

## 定向路径诊断

以下 TS 入口与六项配对计算测试分开测量，采用一次预热和五次正式样本：

| 入口 | 应用参数 | 测量内容 |
| --- | --- | --- |
| `ts/host.ts` | `mode: "sleep"` / `"generic"` | 256 次数值延时或通用异步请求 |
| `ts/host.ts` | `mode: "microtask"` | 256 次 `await Promise.resolve()` |
| `ts/host.ts` | `mode: "clock"` / `"generic-clock"` | 64 次直接或 JSON 单调时钟调用 |
| `ts/graphics.ts` | `mode: "sdk"` / `"generic"` | 256 个相同矩形，分别走标量通道和 JSON 通道 |
| `ts/present.ts` | 无 | 32 次局部帧提交，另检查空脏区域及快照申请/复制计数 |

入口通过同一个 `embedts build` 命令生成应用的 `scripts/main.etb`，`launcher.json`
中的 `args.mode` 选择模式。每个应用在测量后才输出样本，避免把 USB 打印计入循环。
完整运行必须有连续样本 `-1..4`、正确的 `count/checksum`、对应 `*_DONE` 标记，以及
VM 关闭记录中的 `used=0`、`failures=0`。编译、上传和应用启动不参与样本计时。

`display.present()` 测量包含 UI 接收屏障；`graphics.ts` 在样本计时结束后才提交帧。
`Promise.resolve()` 与宿主请求的 Promise 生命周期不同，其耗时只用于定位执行层级，
不能直接相减得到纯宿主成本。通用调用是控制组，SDK 的高频路径使用 ABI 3 的直接接口。

原生帧发布的正确性和回收检查位于 `crates/os/tests/ts_graphics.rs`：保留的快照保持
不可变；独占快照复用同一地址；局部复制与 framebuffer 像素一致；最多四个脏矩形
及 UI blit 视图通过内联元数据和借用传递，不申请临时列表。
