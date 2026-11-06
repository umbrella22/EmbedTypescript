# 数值比较优化与 Lua / TS 计算验证（2026-11-06）

## 运行路径与变更

TypeScript 继续通过 tsrs、Rolldown 和 QuickJS-NG 字节码链路执行。64 位目标的运行时
在 `js_relational_slow` 中检查两个操作数的实际标签；两者均为 int32 或 binary64 时，
直接进入上游已有的 `float64_compare` 分支，省去两次 `JS_ToPrimitiveFree`。
其他类型继续执行原有转换路径。已有 int32 / int32 指令路径和相等判断没有修改。
32 位目标的比较实现保持原有代码；ESP32-S31 的候选实测出现回退，未启用新路径。

`rust/engine/patches/quickjs-ng/0003-numeric-comparisons.patch` 按顺序应用到构建副本；
vendor 源码保持上游原样。该路径服务所有数值关系比较，无需为应用添加类型标注，
不改变 `number` 精度、数组布局、算法、Promise job 或宿主调度策略。

| 身份 | 值 |
| --- | --- |
| 本次对照基线 | `248b9ad579b72957b43fbdb610c3c2bcc391d946` |
| QuickJS-NG | `e22ce4de4362dc5fd4794cfa3c03fc7fdba5f015` |
| 构建器 / 引擎版本 | `0.2.0` |
| `.etb` 格式 / 宿主 ABI | `1` / `3` |
| 基线引擎指纹 | `ee250cff0a7d84a7ad12e21fcf380fe1ae3d85c60f1e75ea6f151bb809518eef` |
| 优化引擎指纹 | `4191193c9b2331bd0de49b09ff24a09d32ae4124f3791ef112614e925faba5fe` |
| OS 对照源码 | dangoOS `5a214b0243c922ddeb332135f77b39bafc89e751` |
| Lua | `5.5.1` |

补丁内容参与引擎指纹。构建器、应用和固件必须配套更新；旧指纹的 `.etb` 不能直接
载入新引擎。基准应用优化前后的字节码载荷逐字节一致，差异位于包头的引擎身份。

## Lua 能力缺口核对

dangoOS v0.4.3 的 Flappy、2048 调用 `audio.open_output()`，并使用输出句柄的
`write()`、`info()`、`close()`。Lua 宿主只注册 `status`、`set_volume`、`set_muted`，
因此在进入 codec / I²S 前就发生 nil 调用。该缺口在 v0.4.0 中也存在。

独立 WAV 播放已有 DMA 发送和实际听感证据，Lua PCM 输出桥仍未实现。对应来源是
dangoOS 的 `crates/lua-engine/src/services.rs`、游戏脚本及
`target/ts-cleanup-audio-20261106/investigation-receipt.json`。

TS 宿主也只提供音频状态、音量和静音控制。`@dango/sdk` 没有声明 PCM 输出接口，
TS 游戏没有调用 `open_output`，所以当前没有相同的缺失方法调用。SDK 文档与
`AudioStatus` 注释已明确播放能力边界；`available` 表示音频服务可用，不能据此
推导应用能够写入 PCM。PCM 播放需要共享宿主服务、流句柄和退出释放的完整实现。

旧 `main.rsts` 下载应用已在 dangoOS 侧清理，存档与系统 Lua 应用校验保持一致。
`sensor drain hit 24 events` 属于 OS 输入队列告警，不由 TS 数值补丁处理。

## 测量方法与瓶颈证据

六项工作负载为整数 PRNG、Mandelbrot、试除素数、矩阵乘法、插入排序和对象粒子
更新。Lua / TS 使用相同算法、固定输入、工作量和让出间隔，每个预热及正式样本
均与独立 Python 参考结果核对。源码、suite 和配置未为优化修改。

`tests/integration/benchmarks/bench.py` 现在生成独立测量工作区，复用 OS runner
源码，并直接链接本 checkout 的 `rust/engine` 和指定 OS 的 `crates/lua-engine`。
此前 runner 由 OS 工作区构建，会解析 OS 锁定的旧 Git 引擎，无法衡量本地修改。
独立工作区记录 manifest / lock 摘要，运行后检查实际引擎指纹与编译器一致。
OS checkout 的依赖和锁文件不受此构建影响。

主机使用 Apple M2、macOS arm64、Rust 1.99.1；Rust release 配置为 opt-level 3、
fat LTO、单 codegen unit，QuickJS C 为 O2。两种解释器均未启用 JIT。每轮使用独立
进程，每个用例先完整预热，再测量一次；九轮轮换 Lua / 基线 TS / 优化 TS 的顺序，
隔轮反转。正式样本共 162 个，全部校验正确。

主机计时累计 VM 调用内的 wall time，包含宿主回调、自然 GC 和线程被抢占的时间，
排除编译、模块加载、初始化、预热和调用外调度。CPU 频率、温度和后台负载没有
固定；CV 与全部原始样本保存在报告中。主机每 32 个工作单元让出一次。

基线进程的 macOS `sample` 记录显示，计算阶段主要执行 `JS_CallInternal`，可见
属性建立与扩容、arena / realloc、整数余数辅助函数及关系比较转换路径。该采样
支持继续优化解释器数值路径和对象分配；嵌套调用样本不能相加成独立耗时比例，
主机采样也不能代表 ESP32 的热点占比。

ESP32-S31 固件的符号还包含 `__muldf3`、`__divdf3`、`__ledf2`、`__gedf2` 等软件
双精度例程。RV32IMAF 目标提供单精度浮点指令；维持 JavaScript binary64 语义的
代价不能靠将普通 `number` 改为 float32 消除。对象建立、动态属性和分配同样仍有
成本；本次补丁只减少数值比较中不需要的通用转换工作。

## 主机结果

下表为九轮正式样本的中位数。速度变化为 `基线耗时 / 优化耗时 - 1`，正值表示
加速；CV 为样本标准差 / 均值。

| 用例 | Lua ms | TS 基线 ms | TS 优化 ms | 速度变化 | TS 基线 / 优化 CV |
| --- | ---: | ---: | ---: | ---: | ---: |
| integer | 85.813 | 173.443 | 173.195 | +0.14% | 0.51% / 1.26% |
| mandelbrot | 123.497 | 148.994 | 140.952 | +5.71% | 0.62% / 1.53% |
| primes | 61.752 | 71.580 | 71.855 | -0.38% | 0.71% / 0.75% |
| matrix | 188.609 | 196.422 | 196.231 | +0.10% | 1.72% / 0.49% |
| sort | 67.239 | 93.228 | 93.147 | +0.09% | 3.00% / 0.26% |
| objects | 106.807 | 149.035 | 148.756 | +0.19% | 2.45% / 0.41% |

Mandelbrot 的耗时减少 5.40%，对应速度提升 5.71%。其余项目中位数变化均小于
0.4%，没有稳定的明显加速。该结果不支持所有通用计算均加速的结论，Lua 在这六项
主机用例中仍然更快。

## ESP32-S31 结果

同一块 ESP-Mosaico S31 v1.2、16 MiB PSRAM，以生产动态 160 / 320 MHz 策略执行
`device-quick`。每个用例先预热一次，再测量五次；工作单元数为
`[32, 256, 128, 96, 32, 32]`，每单元让出一次。以下是应用单调毫秒时钟的完成耗时，
包含合作式让出、宿主恢复、后台调度和自然 GC，与主机 VM 调用计时分别评估。

| 用例 | Lua ms | TS 基线复测 ms | TS 最终 ms | 最终 TS / Lua |
| --- | ---: | ---: | ---: | ---: |
| integer | 18 | 61 | 61 | 3.39 |
| mandelbrot | 112 | 394 | 397 | 3.54 |
| primes | 104 | 222 | 211 | 2.03 |
| matrix | 163 | 258 | 265 | 1.63 |
| sort | 76 | 138 | 137 | 1.80 |
| objects | 119 | 187 | 185 | 1.55 |

Lua 与 TS 最终运行的 60 个正式样本，以及基线复测的 30 个正式样本均校验正确。
TS 最终运行保持 3,456 次 delay / job、3,457 次运行器 turn，与基线一致；关闭时
`used=0`、`failures=0`，引擎峰值为 171,563 B。

本次没有确认板端通用计算加速。32 位目标未启用新比较路径，表中素数约 5% 的速度
变化、矩阵约 2.7% 的耗时增加不能归因为该数值补丁。频率、温度和后台服务未逐样本
固定，短测也只覆盖固定输入子集。最初基线的六项中位数为
`[61, 395, 222, 258, 137, 186]`，复测后相近。

将路径同时用于 32 位目标的候选使对象项目达到 202–209 ms；最终限定为 64 位后，
该项目回到 185 ms。具体的代码布局、缓存和调度影响没有单独定量分离。

最终实验 TS 镜像为 5,584,704 B，比对照基线小 128 B，SHA-256 为
`46dae36ccf708e2025490e7ea24d0def08640ec3140e89d8ca0faa0f1f83bb40`。
内部已分配 section 为 461,984 B，RTC 为 288 B，主栈 49,928 B；应用槽剩余
706,752 B。资源预算及单引擎 / 设备无源码解析器符号检查通过。这些 section 数据
描述静态链接占用，运行时 VM 峰值由分配账本另行记录。

## 语义与集成验证

`rust/engine/tests/kernel.rs` 新增两项回归测试，先在基线通过，再验证补丁：

- 2,020 组数值对 × 8 种比较，以 Rust IEEE 比较为独立参考。覆盖 NaN、无穷、
  正负零、次正规数、int32 / 安全整数边界、随机 binary64 与混合 int32。
- 字符串、null / undefined、布尔值、BigInt / number、Symbol、对象身份、
  `Symbol.toPrimitive` 提示与调用顺序、转换异常和操作数求值顺序。

`js_relational_slow` 只在两个操作数实际均为数字时省略转换，没有用户回调或引用
需要释放。NaN 的四种关系比较均为 false，正负零比较相等。其他值继续走上游路径。

| 检查 | 结果 |
| --- | --- |
| 根 `scripts/check.sh` | 87 项 Rust 测试、2 项真实 SDK 集成、11 项基准协议、9 项 Node 测试、TS 类型与 7 个应用检查通过 |
| OS TS 配置主机测试 | 372 项通过、2 项原有私有素材测试忽略 |
| 新指纹工具链安装 | `toolchain:build --offline` 及无覆盖变量的普通应用检查通过 |
| OS 编译输入 | 18 份配套字节码导出成功 |
| TS release 固件 | 编译链接、资源预算、单引擎与设备无源码解析器符号检查通过 |
| 板端比较语义 | 2,020 组数值对 × 8 种比较及非数值行为通过；探针关闭时 `used=0`、`failures=0` |

## 设备恢复与交付范围

两份临时应用 `script-bench`、`numeric-probe` 已移除，下载应用列表为空，与测试前
一致。设备通过 A/B OTA 恢复公开 Lua v0.4.3 原镜像，SHA-256 为
`27574f89b3798434281f5838b6917609f24fb9e7e5bff7769ef34f553dc6e2fb`。
最终活动槽为 1、`Valid seq=162`，`sys/data/frame/vm/valid` 均为 1；默认 Lua brain
`error=0`，音量 74、静音关闭，NAND 已就绪且不可纠正错误为 0，串口已释放。
A/B 备用槽保留本次实验 TS 镜像，最初的 v0.4.0 备用镜像已在测试切换中覆盖。

本次未重新执行人工 UI、真实触摸或听感验收；恢复使用的是此前已验收的同一份
公开 Lua 镜像。主机结果来自 macOS arm64，其他 64 位目标的性能、跨平台分发与
公开发行不由这些本地结果代替。

## 复现与证据

```sh
./scripts/check.sh
pnpm -C typescript toolchain:build --offline
python3 -B tests/integration/benchmarks/bench.py host \
  artifacts/script-bench-current --profile host --dango-root ../esp-32 --rounds 9
(cd rust && cargo run -p embedts-builder --locked --offline --example export-dangoos -- ../artifacts/dangoos-inputs)
```

`bench.py host` 测量指定 checkout 的 Lua 和当前 TS。优化前后对照需分别保存基线和
优化版可执行文件及匹配载荷，再按相同配置交替运行。基线与优化版的包头指纹必须
分别核对，不能让一个运行时执行另一版载荷。

本地原始证据位于忽略目录 `artifacts/compute-review-20261106/`：

- `baseline-verified/`：基线构建器、两种解释器、应用和首次七轮结果。
- `profile-baseline/`：原生采样、实际进程输出和环境身份。
- `numeric64-final/`、`host-numeric64-final/`：本次优化的二进制、应用、九轮原始样本和三方比较。
- `check-numeric64.log`、`os-numeric64-tests.log`、`export-numeric64.log`：检查与集成日志。
- `firmware-before.*`、`firmware-numeric64.*`：实测固件、预算、符号和构建日志。
- `device-comparison/`、`ts-before-repeat-device.log`、`ts-numeric64-device.log`、
  `lua-device-v2.log`：板端三方比较、分片原始日志和全部样本。
- `numeric-probe-numeric64-device.log`、`device-final-health.log`、
  `verification-receipt.json`：语义探针、恢复健康状态及汇总回执与证据摘要。

早期将数值比较内联到主分派、重复比较分支的候选在板端出现回退，未纳入当前实现。
失败的探针加载、主机预算中断和候选结果均保留在证据目录，没有计入通过样本。

OS 正式 checkout 继续固定原 Git revision。本次固件由该 OS 提交的独立源码快照与
本地引擎路径覆盖构建；OS 的源码、Cargo.toml 和 Cargo.lock 未修改。消费端采用此
优化需要更新引擎 revision，并用匹配构建器重新生成全部字节码输入。
