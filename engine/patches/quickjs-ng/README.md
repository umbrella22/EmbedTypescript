# QuickJS-NG 内核补丁

上游基线为 `e22ce4de4362dc5fd4794cfa3c03fc7fdba5f015`，遵循 MIT 许可。
`vendor/quickjs-ng/` 保留上游原始文件；`build.rs` 将补丁按下表顺序应用到构建目录，
随后编译该副本。补丁仅接受固定源码摘要、精确行位置和逐行上下文；匹配失败终止构建。

| 补丁 | 执行路径 | 保留的行为 |
| --- | --- | --- |
| `0001-settled-promise-reactions.patch` | 已兑现或拒绝的 Promise 直接为 reaction job 保存参数，省去两个临时 reaction 记录 | 异步 job 数量及顺序、默认 handler、拒绝跟踪、species 和引用释放；未完成 Promise 仍建立两个 reaction 记录 |
| `0002-integer-remainder.patch` | int32 负数取余走整数指令；binary64 精确整数与非零 int32 除数从有效位重建整数后取余 | 负零、零除数、int32 最小值与 -1；小数、非有限数及绝对值大于 `2^53-1` 的输入进入上游路径；BigInt 和对象转换路径保持原有分派 |

第二项补丁使用已经存储的 binary64 位表示，限定转换范围并检查全部小数位。
余数的绝对值小于除数的绝对值，非零结果始终可以用 int32 表示。该路径不改写
`number` 精度，不跨字节码合并表达式，也不改变操作数求值或转换顺序。

`build_support/patch.rs` 只应用本目录针对 `quickjs.c` 的统一差异文件，不依赖外部
补丁程序。补丁字节、应用实现、构建配方和所选 profile 均参与 `ENGINE_ID`。
两个 profile 的包互相拒绝，应用从可信源码重新编译。

## 对照与验证

默认 `EMBEDTS_QJS_KERNEL_PROFILE=optimized` 应用全部补丁；`upstream` 用于执行同一
源码、相同优化级别和平台适配下的未打补丁对照。设置对主机编译器和设备构建同时生效。

```sh
cargo test -p embedts-engine --features compiler --locked --offline
cargo run -p embedts-engine --features compiler --release --example kernel-bench -- 7
EMBEDTS_QJS_KERNEL_PROFILE=upstream cargo run -p embedts-engine --features compiler \
  --release --example kernel-bench -- 7
```

`tests/kernel.rs` 对照 Rust 的独立浮点余数结果，覆盖全部候选指数、范围边界、
随机整数与随机 binary64 位模式，并检查 BigInt、转换顺序、Promise reaction
顺序、thenable、species、异常和内存不足后的释放。`tests/kernel_patches.rs` 检查
上游摘要、补丁顺序、上下文偏移和重复应用拒绝。

`kernel-bench` 在生产 VM 内编译固定 JS 工作负载，以独立整数计算校验每个样本，
记录时间、执行 job 数和 backing allocator 峰值。初始化、编译、销毁位于计时之外，
不包含 OS 调度或显示。比较采用交替进程顺序；主机结果与设备结果分别记录。

引擎 backing allocator 的峰值包含 arena 页面，不能显示每次内部小对象申请。
省去临时 reaction 记录可能降低申请次数而不改变页面峰值。设备碎片证据还需要
最大连续块、实际连续申请和重复生命周期结果。

上游升级时先更新 vendor 清单，再逐项重新评估补丁。语义测试、未打补丁对照、
原生目标构建与设备测量共同决定补丁是否继续保留。
