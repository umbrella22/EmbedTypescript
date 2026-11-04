> 历史记录：路径、命令和包后缀对应拆分前的团子 OS 工作区。当前入口见 [EmbedTS 架构](../architecture.md)。

# TS 引擎实体设备验收

本记录对应 2026-11-03 的工具链与实体固件。2026-11-04 迁移到 tsrs 后的构建
检查单独记录；本轮原始 ELF 已归档到 `target/ts-parity/pre-tsrs-engine-checks/`，
物理设备结果与原指纹保持一致。

## 产物与目标

本记录对应 `codex/ts-engine` 工作区，基于提交
`f49e1992f94b51ad5c163021bbab402c633275a8`，包含尚未提交的实现。
目标为 ESP-Mosaico S31 v1.2 实体板、480×480 显示、16 MiB PSRAM，使用
`MOSAICO_S31_AB_LAYOUT_V2_6M_NAND`。部署使用控制台 A/B OTA，未进行 ROM
烧写、恢复分区改写或 NAND 格式化。

设备证据根目录为 `target/ts-parity/`。`device-results.json` 汇总固件、包和日志的
SHA-256、OTA 状态与各项结论；原始日志和截图保留在同目录。构建流水线生成的
`target/engine-checks/evidence.json` 仅描述构建阶段，其 `device_execution=not_run`
不承担独立设备运行回执的职责。

诊断固件来自 `ts-embedscope-4.elf`，EmbedScope build ID 为
`dango-0.4.0+escope.a1abb404bc63071cc9cf`。测试中主动重启过一次，boot ID
从 `2717598213` 变为 `3314604143`；每组采集同时保存当时的身份和 UI revision。

最终设备已通过 A/B OTA 切到普通 TS 固件（不含 EmbedScope）：槽 0、seq131、
Valid，`sys=1 data=1 frame=1 vm=1 valid=1`。镜像 SHA-256 为
`27dc0d237b6ed890b936ba7d4395720af3f8796140ec248c3b97ee8c9df6871f`，
ELF SHA-256 为 `e87b019206e3b0c49acb404088b32de10c569753c3ddc00b9002b76332d7f66a`。
`ota-production.log` 保存激活回执，`production-device.log` 的
`TS_PRODUCTION_DEVICE_PASS` 保存自检后 SDK 完整探针及五个应用的重复烟测结果；
全部退出账本 used=0，内置 TS brain `crc=46d1edff error=0`。

## SDK 与物理输入

探针由 `tests/device/ts-parity/build.py` 构建，包指纹位于
`probe-ready/build-report.json`。它使用正式 SDK 和宿主任务，已在实体板通过：

- 包含 NUL 与中文的文本、二进制存储、重命名、删除和清理。
- 原生 DFN1 字体、PNG alpha、JPEG 保存/加载/缩放与 framebuffer 发布。
- 实际 IMU、磁力计校准与电量计读取；音量/静音写入、读取并恢复。
- 独立 worker、二进制队列、信号量、归属锁、超时/停止释放锁及异常隔离。
- 原生 LVGL 按钮、事件处理和退出后的 `closed used=0`。

`probe-run-3.log` 记录扩展探针完整通过。`probe-physical-input.log` 中没有
EmbedScope 注入输入，记录了实际操作产生的 12 次 UI 点击及两组
`press_down` / `press_up` / `single_click`，对应原始 GPIO7 短按事件。
该轮 VM 峰值 271,908 字节、失败分配 0、关闭后 used=0。

扩展 LED 板未接入，探针明确报告 `TS_PROBE_LED_UNAVAILABLE`。振动请求已被宿主
接受，操作者尚未单独回报触感。二者都没有被计为物理输出验收通过。

## 五个官方应用与真实相册文件

最终应用树由 `scripts/build_apps.py --engine ts` 生成，再经 `app-pack bundles`
打包和原安装事务部署。`apps-fixed/build-report.json` 与 `bundles-fixed/` 保存
源文件、字节码和资源指纹。

`official-fixed-device.log` 和 `official-results.json` 记录 snake、2048、dino、
flappy、photo 全部通过启动、运行、最终显示平面采集、注入点击和停止；最终轮没有
Budget 或 Exception，关闭账本均为 used=0。各应用截图以 `*-fixed-device.png`
保存。游戏规则、碰撞和重置的确定性断言由主机应用测试覆盖，这次板端流程没有把
单次注入点击扩写为全部游戏交互的人工验收。

相册最初扫描为空。只上传以下两张专用测试图片：

- `/data/appdata/photo/photos/ts-parity-20261103-a.jpg`
- `/data/appdata/photo/photos/ts-parity-20261103-b.jpg`

`photo-check-device-3.log`、对应 `photo-*-tree.json` 和最终平面截图记录：
缩略图 → 原图 A → 下一张 B（2 / 2）→ 取消删除仍保留 B → 确认删除 B →
剩余 A（1 / 1）→ 确认删除 A → 空相册 → 重启应用重新扫描 0 张。
删除确认前检查对话框中的完整测试文件名。未删除其他照片。
相册完整轮关闭峰值 277,401 字节，重新扫描空相册后峰值 195,817 字节，均 used=0。

`photo-full-final-device-3.png` 为真实 JPEG 原图界面，
`photo-empty-final-device.png` 为清理后的空相册。`device-gallery.png` 仅把五张
原始平面截图缩小拼接用于浏览，原始文件仍是像素证据。

## brain 事务与应用生命周期

`brain-device-2.log` 的 `TS_BRAIN_DEVICE_PASS` 记录：

1. 安装 Happy，自定义选择 CRC 为 `4948867d`。
2. 初始化错误与首 tick 错误均拒绝，旧状态和 CRC 保持一致。
3. 重启后等待存储和 VM 就绪，持久选择仍为同一 CRC。
4. 安装后续异常脚本，发生 `probe:later fault` 后为
   `active=native source=custom error=1`。
5. 恢复内置 TS brain，CRC 回到 `46d1edff`，`error=0`。

USB 重连早于持久选择加载；设备 runner 使用 `ota-status` 的存储/显示/VM
就绪位再采样 brain。提交 I/O 故障由主机事务测试注入；本轮未以断电或损坏 NAND
制造提交失败。

`lifecycle-device-2.log` 与 `lifecycle-results.json` 记录五个应用各两次启停，外加
Dino 运行中重装同一 bundle 并重启。每次旧 VM 关闭均 used=0，新实例正常启动。
内部空闲堆保持 31,592 字节，最大空闲块保持 31,352 字节；PSRAM 基线
12,398,040 字节，最终 12,397,872 字节，差 168 字节。该结果仅覆盖约 44 秒的
有界轮次，不能证明长期碎片、全部宿主暂存峰值或最坏调度延迟。
结束时诊断 crash summary 为 `present=false`。

## 资源与剩余限制

普通 TS 固件的生产预算通过：镜像 5,666,384 字节，OTA 槽剩余 625,072 字节，
内部已分配 ELF 段 461,488 字节，主栈 50,424 字节。Lua 固件预算和两个引擎的
依赖/ELF 隔离检查也通过。普通构建默认仍选择 Lua，设备本次选择 TS。

诊断固件镜像 5,728,096 字节，能放入 OTA 槽，但诊断代码和 crash summary
使其超过生产增量门禁：镜像增量 116,416 > 65,536，RTC 增量 76 > 0。
`device-resource-budget-final.json` 保留 fail；没有调宽门禁。截图、树和性能诊断
使用该固件，最终部署与控制台复测使用不含 EmbedScope 的普通 TS 固件。

Home 仍可见 `sensor drain hit 24 events`；旧 Lua 设备基线
`device-before.log` 也存在该告警。TS brain 已采用直接输入编码、重复输出缓存和
按回调成本请求性能频率，Home 采样约 5.3 ms/回调，仍有明显解释执行成本，不能
宣称性能或功耗已经追平 Lua。`frame_ms` 表示最终平面输出耗时，不能作为应用 FPS。

CST9220 `invalid report: Header` 在旧 Lua 基线与当前固件均存在；物理触摸事件
已经单独验证。配置的更新代理 `10.26.104.212:7777` 在测试中连接超时，首次
连续启停脚本因此碰到系统 OTA busy；后台检查结束后复跑通过。该网络环境没有
被记为在线更新服务验收。

完整主机门禁日志为 `checks-final.log`：Lua OS 库 351 通过、2 忽略；TS OS 库
339 通过、2 忽略；runtime 16、worker 4、checker 43、Python 123，以及真实
LVGL/LittleFS 集成、双固件预算和 3,240 个 C 符号检查通过。
