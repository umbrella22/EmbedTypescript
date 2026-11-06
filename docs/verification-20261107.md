# 可移植指令合并、解释器诊断与多架构验证（2026-11-07）

## 执行路径与兼容性

QuickJS-NG 继续执行既有设备子集的 JavaScript 语义。新增的
`0004-nullish-branches.patch` 在解释器中识别连续的 `dup`、
`is_undefined_or_null` 和条件跳转，一次分派完成三条逻辑指令。
栈上的原值始终存活，省去临时副本的引用复制与释放、临时布尔值和两次分派。
短、长跳转及原跳转的中断检查均保留；其他 `dup` 序列执行原路径。

该实现使用可移植 C，所有目标应用同一段空值指令合并代码，没有 ESP、STM32 或
ARM64 专属 API。此前的数值比较补丁仍只对 64 位值表示启用；各项优化的适用范围
按值表示和实际验证分别记录。硬件相关代码继续位于宿主的分配、时钟与设备服务层。
同一语义可跨平台运行，收益仍受目标编译器、缓存、浮点硬件及程序指令分布影响。

本次不增加 opcode，`.etb` 格式、宿主 ABI、数值精度、算法、Promise job 和合作式
让出策略均保持原有契约。基准在旧、新编译器生成的包头之后，字节码载荷逐字节相同。
内核补丁及构建配方改变引擎指纹，应用和 OS 集成输入需要使用匹配工具链重新生成。

| 身份 | 值 |
| --- | --- |
| 对照基线 | `d686abddf72540fb8a8d858def5ca635dbe8869d` |
| QuickJS-NG | `e22ce4de4362dc5fd4794cfa3c03fc7fdba5f015` |
| 构建器 / 引擎版本 | `0.2.0` |
| `.etb` 格式 / 宿主 ABI | `1` / `3` |
| 本次默认引擎指纹 | `2ceba6aeba27ee74f2015292b538ddd8419289fdb05276542e8ca5008b991688` |

## 诊断边界与工作量

可选 `diagnostics` feature 为每个 VM 记录逻辑指令直方图、实际分派次数、相邻指令
组合候选数及 QuickJS 分配函数调用数。`Vm::interpreter_diagnostics(reset)` 读取并
可重置当前 VM 的计数，`opcode_name()` 返回当前内核的指令名称。计数器同时支持
`optimized` 与 `upstream` profile，默认关闭；正式计时全部使用关闭诊断的构建。

诊断构建每个 runtime 增加 2,128 B 计数存储，计入分配账本，并产生独立引擎指纹。
相邻候选可能包含随后抛出异常的操作。分配调用数包含嵌套入口和零大小调用，不能
当作 backing allocator 次数或分配耗时。默认构建没有诊断存储、更新或查询接口。

保留实现的六个计算核与基线逐项通过独立参考结果校验，逻辑指令直方图完全相同：

| 计算核 | 基线分派数 | 优化分派数 | 减少分派数 |
| --- | ---: | ---: | ---: |
| integer | 70,764 | 70,764 | 0 |
| mandelbrot | 121,188 | 121,188 | 0 |
| primes | 344,949 | 344,949 | 0 |
| matrix | 521,100 | 465,804 | 55,296 |
| sort | 318,743 | 281,471 | 37,272 |
| objects | 124,428 | 124,428 | 0 |

这些计数来自相同计算核的诊断 JS 包装入口，排除模块初始化，不能直接换算为
完整应用的耗时或 CPU 周期比例。候选阶段的 S31 完整诊断应用还记录了 277,704 次
空值序列，9,084,547 条逻辑指令对应 8,529,139 次分派，每个命中减少两次分派。
该实机诊断镜像使用较早的分派实现，其计时未纳入保留实现的性能对照。

对象核仍有大量动态属性建立与分配：诊断包装入口记录 7,776 次 malloc 入口和
7,968 次 realloc 入口。减少解释器分派无法消除这些成本。S31 的 binary64 计算
仍依赖部分软件双精度例程，普通 TypeScript `number` 不能改成 float32 来获得
兼容的通用加速。

## 主机性能

Apple M2 / macOS arm64，Rust 1.99.1；Rust release 为 O3、fat LTO、单 codegen
unit，QuickJS C 为 O2，Lua 和 TS 均无 JIT。五轮轮换 Lua、基线 TS、优化 TS 的
顺序并隔轮反转，每次独立进程，每个用例先完整预热。90 个正式样本全部校验正确。

主机计时累计 VM 调用内的 wall time，包含宿主回调、自然 GC 和线程抢占，排除
编译、加载、初始化、预热及调用外调度。每 32 个工作单元让出一次；频率、温度和
其他进程负载未固定。下表为中位数，速度变化为 `基线耗时 / 优化耗时 - 1`。

| 用例 | Lua ms | TS 基线 ms | TS 优化 ms | 速度变化 | TS 基线 / 优化 CV |
| --- | ---: | ---: | ---: | ---: | ---: |
| integer | 86.074 | 174.180 | 173.932 | +0.14% | 0.55% / 0.34% |
| mandelbrot | 124.352 | 141.751 | 143.778 | -1.41% | 0.70% / 0.34% |
| primes | 61.999 | 72.276 | 72.673 | -0.55% | 0.41% / 0.75% |
| matrix | 189.446 | 196.831 | 180.383 | +9.12% | 0.26% / 0.46% |
| sort | 67.689 | 93.736 | 86.691 | +8.13% | 3.06% / 0.46% |
| objects | 108.346 | 150.358 | 149.329 | +0.69% | 0.98% / 0.71% |

矩阵和排序的收益与分派工作量减少一致，先前的两组五轮对照也观察到约 8% 的
收益。Mandelbrot 本轮回退 1.41%；其他项目中位数变化小于 1%。这组结果支持
特定指令分布的加速，不支持所有计算均提速的结论。除矩阵外，Lua 仍更快。

较长的候选或正式尝试曾在基线或优化进程因 wall time 超过 20 ms 预算而中止，
包括 34.317 ms 和 45.363 ms 的样本。失败尝试原样保存，未抽取其中成功轮次
并入正式统计；五轮正式对照重新完整执行，预算、算法和让出配置没有放宽。

## ESP32-S31 性能与资源

同一块 ESP-Mosaico S31 v1.2、16 MiB PSRAM，使用生产动态 160 / 320 MHz 策略和
`device-quick` 配置。工作单元数为 `[32, 256, 128, 96, 32, 32]`，每单元让出一次。
按基线、新版、新版、基线的顺序运行；每次每个用例预热一次并正式采样五次。
两版分别每个用例十个样本，120 个正式样本全部校验正确。

设备计时使用应用单调毫秒时钟，包含 VM、合作式让出、宿主恢复、后台调度和自然
GC，与主机 VM 调用计时分开评估。下表为两次完整运行合并后的中位数。

| 用例 | TS 基线 ms | TS 优化 ms | 速度变化 | 基线 / 优化 CV |
| --- | ---: | ---: | ---: | ---: |
| integer | 61.0 | 62.0 | -1.61% | 3.84% / 16.71% |
| mandelbrot | 393.5 | 412.5 | -4.61% | 1.79% / 0.97% |
| primes | 214.0 | 223.0 | -4.04% | 2.45% / 1.96% |
| matrix | 260.5 | 255.0 | +2.16% | 2.19% / 2.98% |
| sort | 135.0 | 135.5 | -0.37% | 4.27% / 2.75% |
| objects | 185.0 | 170.0 | +8.82% | 0.60% / 1.88% |

S31 上对象项目改善较清楚；矩阵变化与样本波动接近，排序没有确认收益。
Mandelbrot 和素数出现约 4% 的回退，integer 有明显的单次完成耗时波动。
对象核没有命中空值融合序列，其改善是该镜像整体实测结果，不能归因为属性缓存。
新增代码对代码生成、布局、缓存和调度的影响没有单独定量分离。

每次运行均保持 3,456 次 delay / job、3,457 次运行器 turn，关闭时 `used=0`、
`failures=0`，引擎峰值 171,563 B，与基线相同。`jobs_us` 包含嵌套宿主回调，
`dispatch_us`、`enqueue_us`、`complete_us` 等不能相加为独立成本百分比。
`pause/cooperate/idle/barrier` 记录调用外的调度等待；完整账本包含预热和报告工作，
也不能直接当作某个用例的解释器耗时。

保留版 TS OTA 镜像为 5,584,960 B，比基线增加 256 B，SHA-256 为
`4053b373a82a1656a81942a24194a808df4832066276f9cbd11b2779f8998220`。
内部已分配 section 为 461,984 B，RTC 为 288 B，主栈 49,928 B；资源预算通过。
符号检查确认没有 Lua、诊断接口和实际 JS 源码解析入口 `__JS_EvalInternal`。
关闭 parser 后仍可保留 `JS_EvalInternal` 的调度 / 错误桩及 JSON / 数值解析辅助函数。

## 语义、移植与集成

空值回归覆盖 false、正负零、NaN、无穷、空字符串、BigInt、Symbol、对象、函数、
数组身份，fallback 惰性执行、`??=` getter / setter 次序、可选链、短 / 长跳转及
异常身份。预算测试连续执行两万次空值表达式，无循环或嵌套调用提供替代中断检查。
相同测试在优化和上游 profile 通过；保留版实机探针输出
`TS_NULLISH_SEMANTICS_PASS`，关闭时分配归零且无失败。

| 验证 | 结果与边界 |
| --- | --- |
| `scripts/check.sh` | 89 项 Rust 测试、2 项 SDK 集成、11 项基准协议、9 项 Node 测试、TS 类型和 7 个应用检查通过 |
| 工具链安装 | 新指纹安装及无覆盖变量的应用检查通过 |
| 可选诊断 | 引擎完整测试、VM 隔离 / 重置、上游 profile 对照通过；六个计算核独立校验通过 |
| RV32IMC / ESP32-C3 | 最终源码的 C 与 Rust release 静态库编译通过；未做 C3 固件链接、刷写或性能测量 |
| ARM Cortex-M0 | 最终源码的 `thumbv6m-none-eabi` C 与 Rust release 静态库编译通过；未做 STM32 固件链接或实机性能测量 |
| OS TS 输入 | 18 份匹配字节码导出成功；独立 OS 快照完成固件链接与设备验证 |
| OS TS 主机测试 | 372 项通过、2 项原有私有素材测试忽略；正式 OS checkout 未修改 |
| CI 配置 | 增加 Linux x64 / ARM64 的语义与诊断测试矩阵；远端执行结果按提交另行记录 |

不具备 32 位原子 CAS 的目标使用 `portable-atomic` 分配唯一 VM 实例编号，保留
编号耗尽行为，宿主需提供有效的 `critical-section` 实现。原生支持目标继续使用
`core` 原子操作。C3 与 Cortex-M0 的检查也覆盖了这条非原子指令移植路径。

Cortex-M0 检查使用 LLVM clang 和 newlib 头文件作为编译 sysroot；这证明 C / Rust
代码可生成目标静态库，尚未验证 STM32 的 libc / libm 链接、HAL、完整固件及设备
内存预算。STM32 各型号的 RAM、Flash 和浮点能力不同，不能用一次编译结果代替
整个平台的适配或速度承诺。

## 未采用的候选

比较与条件跳转融合没有获得稳定收益，并在部分主机用例出现回退。带形状、当前
属性位置和 atom 校验的 32 项属性提示缓存通过语义探针，但对象用例只改善 0.87%，
小于波动，且增加 256 B / 512 B 的 32 / 64 位常驻存储，两项均未纳入补丁序列。

空值融合首版在 S31 上将矩阵从 266 ms 推高到 391 ms，未保留。当前实现使用
独立局部变量处理融合跳转，避免改写主解释器 opcode 变量；重新生成的机器码不同，
完整设备复测消除了这次大幅回退。具体编译器优化或代码布局原因尚未单独证明。

## 设备恢复

临时 `script-bench` 与 `nullish-probe` 已删除，下载应用列表为空，与测试前一致。
设备通过 A/B OTA 恢复同一份公开 Lua v0.4.3 镜像，SHA-256 为
`27574f89b3798434281f5838b6917609f24fb9e7e5bff7769ef34f553dc6e2fb`。
活动槽 1 为 `Valid seq=168`，`sys/data/frame/vm/valid` 均为 1；备用槽 0 恢复为
本次对照用的原 d686abd TS 镜像，`Valid seq=167`。默认 Lua brain `error=0`，
音量 74、静音关闭；NAND mounted / ready 均为 1，uncorrectable 为 0，串口已释放。

本次没有重新执行人工 UI、真实触摸或听感验收。恢复使用此前已验收的相同公开镜像，
自动健康状态与人工验收分别记录。清理过程中一次连续删除返回 app management busy，
分开执行后成功，并通过新的 `ls` 回执确认清理完成。

## 复现与交付边界

```sh
./scripts/check.sh
pnpm -C typescript toolchain:build --offline
(cd rust && cargo test -p embedts-engine --features compiler,diagnostics --locked --offline)
(cd rust && EMBEDTS_QJS_KERNEL_PROFILE=upstream cargo test -p embedts-engine --features compiler,diagnostics --locked --offline --test kernel --test diagnostics)
(cd rust && cargo run -p embedts-builder --locked --offline --example export-dangoos -- ../artifacts/dangoos-inputs)
```

主机对照保存两版解释器、对应编译器和字节码，每轮核对引擎身份及独立参考结果；
包头之后的字节码要求相同。设备使用各自对应的镜像和载荷，诊断镜像另行配套。
本地原始证据位于忽略目录 `artifacts/dispatch-review-20261107/`：

- `host-local-branch/`、`host-release-final/`：保留版可执行文件、环境与源码摘要、五轮三方正式原始样本和比较报告。
- `profile-before.json`、`profile-release.json`、`device-diagnostic-counts.json`：逻辑工作量与诊断边界。
- `check-release.log`、`diagnostics-release-tests.log`、`upstream-release-tests.log`、`c3-release-compile.log`、`arm-release-compile.log`：最终源码检查。
- `inputs-local-branch/`、`firmware-local-branch.*`：OS 输入、实测镜像、资源预算和符号检查。
- `ts-baseline-device.log`、`ts-local-branch-device.log`、`ts-local-branch-repeat-device.log`、`ts-baseline-repeat-device.log`、`device-release-comparison.json`：设备四次运行与合并统计。
- `probe-local-branch-device.log`、`device-cleanup-verified.log`、`device-restored-health.log`、`verification-receipt.json`：语义、清理、恢复状态与交付回执。

OS 正式 checkout 保持 `5a214b0243c922ddeb332135f77b39bafc89e751`，继续固定原引擎
Git revision。固件通过独立 OS 源码快照和本地路径覆盖构建，正式源码及锁文件
未修改。消费端采用本次优化时需要更新依赖提交及全部配套输入。没有执行新版本的
公开发行，也没有 C3、STM32 或其他 ARM64 设备的性能结论。
