# TS Hello

最小 dangoOS TS 应用。`main()` 调用 `dango:host.emit(42)` 并返回 `42`，然后退出。
此示例只输出控制台日志，没有应用 UI。

```sh
# 仓库根目录
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @dango-examples/ts-hello check
pnpm --filter @dango-examples/ts-hello build
(cd rust && cargo run -p embedts-engine --example run -- ../typescript/examples/hello/dist/ts-hello/scripts/main.etb)
(cd ../esp-32 && cargo fw-ts)
```

`.etb` 是生成产物，不提交到版本库。引擎配方变化后需要重新构建。
`build` 的输出目录必须尚不存在。已安装 TS 固件的设备上传生成的应用目录：

```sh
python3 ../esp-32/scripts/device/console.py --port RUNTIME_PORT push examples/hello/dist/ts-hello --run
```

实际设备运行仍需验证；交叉构建与主机 runner 不提供设备执行证据。
