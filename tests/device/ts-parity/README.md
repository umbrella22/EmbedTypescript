# TS 设备能力探针

探针通过正式 TS SDK 运行在所选 TS 固件上，验证二进制/NUL 文本存储、DFN1 字体、
PNG alpha、JPEG 保存/加载/缩放、framebuffer、原生 LVGL、服务音量/静音控制、可用的
IMU/磁力计/电量计、worker 二进制同步、归属锁、超时、停止和异常隔离。
运行恢复原音量/静音并清理探针数据，不读取或删除用户照片。

```sh
python3 tests/device/ts-parity/build.py target/ts-device-probe
python3 ../esp-32/scripts/device/session.py --log target/probe-device.log --seconds 85 \
  --push target/ts-device-probe/app
```

`build.py` 固定使用本仓库 embedts 与主机测试图像/字体，输出每个包的 SHA-256。
输出目录必须尚不存在。`TS_PROBE_FRAME_READY` 后显示 framebuffer 4 秒；
`TS_PROBE_UI_READY` 后显示原生按钮 60 秒。点击中央按钮并短按 AI 键，分别记录
`TS_PROBE_UI_CLICK` 与 `TS_PROBE_BUTTON_EVENT`。`TS_PROBE_DONE` 和关闭日志的 `used=0`
共同标识运行完成。串口会话本身成功不表示探针断言或物理输出通过。

EmbedScope `input tap` 可验证平台事件路由；只有实际手指操作与原始按键事件可作为
物理输入证据。传感器按设备 `available` 位决定执行范围；缺少扩展板时明确输出 LED
不可用。振动/LED 请求接受需要与操作者观察分开记录。

受限 brain 的设备事务检查：

```sh
python3 tests/device/ts-parity/brain_check.py target/ts-device-probe/brain --dango-root ../esp-32 \
  > target/ts-brain-device.log 2>&1
```

该命令要求当前为内置 TS brain，临时替换为 Happy，验证初始化/首 tick 失败不提交、
重启持久选择、后续异常回退原生，最后恢复内置行为。它会重启设备一次。
重连后等待存储、显示和 VM 启动就绪再检查选择；USB 可用不表示持久选择已经加载。
通过标记为 `TS_BRAIN_DEVICE_PASS`；持久提交 I/O 故障另由主机事务测试注入验证。
