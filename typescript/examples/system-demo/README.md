# TS 系统示例

TypeScript 7 应用使用原生 LVGL 显示服务状态，通过按钮更新服务/硬件快照，并在应用
私有目录保存启动次数。字体、输入、应用导航和退出清理由 dangoOS 提供。

需要 TS 固件。构建和安装：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @dango-examples/ts-system-demo check
pnpm --filter @dango-examples/ts-system-demo build
python3 ../esp-32/scripts/device/console.py push examples/system-demo/dist/ts-system-demo --run --follow
```

`launches.txt` 使用相对路径，解析为 `/data/appdata/ts-system-demo/launches.txt`。
按钮事件由现有 LVGL 输入任务排队，TS `ui.run()` 顺序执行异步回调并提交重绘。
关闭应用释放脚本 UI 和在途 Promise；独立应用数据继续保留。

示例源码纳入主机编译检查。宿主集成测试使用真实 LVGL/LittleFS 和模拟板级快照；
示例的实际显示、触摸和存储行为仍需设备验收。
