# 宿主 ABI

`dango:host` 是构建后保留的原生模块。C 桥保存 JSValue，Rust Host 接收显式长度的字符串、字节、int32 或请求编号。同步调用必须有界且不阻塞；异步服务通过队列交接，完成后继续 pump Promise jobs。

宿主 ABI 版本由 `engine::HOST_ABI` 定义并写入 `.etb` 包头。`RequestId` 带 VM 代次，过期或重复回执不复用槽位。二进制传输只复制 TypedArray 视图范围。VM 停止撤销等待状态，宿主先结束已启动的硬件/存储操作再发布停止完成。

`call` / `request` 使用 JSON 与可选二进制传输；数值时钟、延时与绘图提供专用路径。回执区分 JSON、字节、组合和 void；服务错误带数值 code，可被应用捕获。OOM、执行预算和内部状态故障终止实例。具体签名由 `typescript/packages/sdk/src/api/dango.d.ts` 与 `rust/engine/src/host.rs` 共同定义。

团子 OS 使用其原生 UI、存储、图形与硬件适配层实现上述协议；引擎不直接调用 LVGL、VFS 或板级驱动。allocator 函数表按值保存，分配与释放始终配对到同一回调集。
