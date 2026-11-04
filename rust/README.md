# Rust 工作区

`builder/` 提供原生 `embedts` CLI，`engine/` 提供供固件集成的 `no_std + alloc` QuickJS-NG 运行时。此目录包含 Cargo workspace、锁文件和固定 Rust 工具链，可独立复制、编译和执行 Rust 测试。

在本目录执行：

```sh
cargo fetch --locked
cargo build -p embedts-builder --locked
cargo fmt --all --check
cargo test --workspace --features embedts-engine/compiler --locked --offline
```

默认构建产物位于 `target/`，Cargo 的 `CARGO_TARGET_DIR` 覆盖继续生效。构建器的 TypeScript 标准库与编译规则来自原生依赖及 `builder/defaults/`。SDK 在编译应用时通过项目配置或 `--sdk` 提供，Rust 构建不读取相邻的 TypeScript 工作区。

设备依赖 `embedts-engine` 时保持默认 feature 集为空；`compiler` 只供主机工具与引擎测试使用。构建器的 `export-dangoos` example 是仓库级集成入口，执行时读取相邻 TypeScript 工作区和集成夹具。

完整应用构建、分发安装与 OS 接入命令见[仓库说明](../README.md)。
