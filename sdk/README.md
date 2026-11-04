# @dango/sdk

dangoOS TS 应用使用的统一 SDK，包含有类型的宿主接口和应用公共代码：

```ts
import { print, sleep } from "@dango/sdk/system";
import * as ui from "@dango/sdk/ui";
import { Random } from "@dango/sdk/game";
```

`src/api/` 提供 system、hardware、storage、ui、display、image、thread、schema
和 brain 模块。`bridge.ts` 连接原生 `dango:host`。这些适配代码参与完整 TS 7
类型检查，内部 JSON/二进制编解码和类型映射属于可信宿主边界。

`src/helpers/` 提供应用公共代码，当前通过 `@dango/sdk/game` 导出游戏、参数和
随机数辅助功能。这里与普通应用一样接受完整受限 TS 规则检查；放在同一个 SDK
包内不赋予它宿主适配层的豁免。没有单独的 app-support 包。

## 原生 UI 构建与更新

`ui.build(parent, nodes)` 在一个宿主请求内创建一组控件、布局和事件绑定，返回通过
`get(key)` 访问命名控件的 `BuiltView`。节点可以包含 `children`；`msgbox` 的
`footer` 支持按钮文字、样式和事件。key 是本次构建的名字，支持中文，重复名字使
请求在提交前失败。

```ts
import * as ui from "@dango/sdk/ui";

export async function main(): Promise<void> {
  await ui.init();
  const screen = await ui.createScreen();
  let clicks = 0;
  const view: ui.BuiltView = await ui.build(screen, [
    { kind: "label", key: "count", options: { text: "点击 0 次" } },
    {
      kind: "button",
      options: { text: "增加", y: 50 },
      on: [{
        event: "clicked",
        handler: async () => {
          clicks++;
          await ui.batch([{ widget: view.get("count"), text: `点击 ${clicks} 次` }]);
        },
      }],
    },
  ], { publish: false });
  await screen.load();
  await ui.frameEnd();
  await ui.run(20);
}
```

`ui.batch(updates)` 合并已有控件的样式、大小、位置、对齐、文字、flex、scroll 和
flag 更新。每个数组元素按上述字段顺序展开为原生命令，元素之间保持数组顺序。
默认成功后解除已有的重绘屏障，将变化交给 LVGL；短属性批次保留局部脏区和
正在进行的指针手势，需要跨轮续跑时暂缓刷新与指针命中。`{ publish: false }` 持有
屏障直到 `frameEnd()`，设备应用运行器也会在真实等待前发布尚未完成的页面。

每批最多 64 条命令、16 个新建句柄和 16 KiB UTF-8 JSON。宿主在原生命令之间检查
4 ms 已调度时间，达到后由同一 UI 任务在后续轮次续跑，整批完成后返回一次结果。
正常冷启动耗时不会使请求失败；正在执行的单条 LVGL 调用、最终布局与清理仍可能
超过这个分片窗口。大型列表由应用按配额拆成多批。文件图像、canvas 创建、图像解码
和像素上传使用原有独立接口。

结构错误在执行前拒绝；执行中的错误会删除本批创建的所有控件和新事件绑定。
已有控件保留已执行的修改，失败返回不提供属性回滚。`BuiltView` 中的控件沿用
`Widget` 生命周期：删除父控件使所有后代句柄失效，事件闭包通过原有退休回执
注销。`build` 与 `batch` 提供声明与提交边界，响应式状态和 JSX/TSX 组件层仍在设计中。

## 工作区与编译

包通过根 pnpm workspace 链接，公开入口由 `package.json` 的 `exports` 定义。
编译器读取相同导出表，原生 Cargo 编译也可以解析这些入口。正式应用不需要通过
相对路径引用 SDK 或编译工具。已有独立客户端的 `dango:*` 平台别名继续解析到
同一份 API 代码。

[编译工具](../builder/README.md) 位于 `builder/`。宿主实现位于团子 OS 的 Rust 适配层，独立引擎不依赖 OS 的 app-host。
