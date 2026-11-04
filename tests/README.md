# 验证入口

| 层 | 入口 | 范围 |
| --- | --- | --- |
| 引擎 | `cargo test -p embedts-engine --features compiler --locked` | 包、VM、ABI、资源预算、异步任务、worker 与核补丁 |
| 构建器 | `cargo test -p embedts-builder --locked` | 语义/子集检查、包导入、原子输出、独立原生 CLI |
| SDK / 示例 | `pnpm typecheck`、`pnpm check:apps` | TS 7 类型与设备子集 |
| 跨仓库输入 | `cargo run -p embedts-builder --example export-dangoos -- NEW_DIRECTORY` | 预编译 OS 集成夹具与哈希清单 |
| 基准协议 | `python3 -m unittest discover -s tests/benchmarks` | 工作量、校验和、顺序、计时与证据完整性 |
| 设备探针 | `python3 tests/device/ts-parity/build.py NEW_DIRECTORY` | 构建 parity 应用与 brain，不访问设备 |

`tests/fixtures/dangoos` 中的 `.ts` 经过正式构建器；`.mjs` 是引擎契约测试专用输入，包含用于验证错误处理的程序，由引擎主机编译入口生成。它们不属于应用子集的正例。OS 只接收输出 `.etb`。

Lua/TS 实测基准使用 OS 的宿主 runner：

```sh
python3 tests/benchmarks/bench.py host target/bench-smoke --profile smoke --rounds 1 --dango-root ../esp-32
python3 tests/benchmarks/bench.py build target/bench-device --profile device --dango-root ../esp-32
```

物理 brain 验收显式传入 OS checkout：`brain_check.py FIXTURES --dango-root ../esp-32 --port PORT`。硬件操作的结果与主机测试分开记录。
