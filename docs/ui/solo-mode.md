# 单人练习模式

## 当前范围

`/play/solo` 是浏览器内的无尽单人练习场，用来先验证棋盘、Handling、固定步进模拟与对局 UI，再接入双人房间。它直接复用 `packages/game-core` 的 SRS+、碰撞、锁定、消行、Spin、攻击统计和 7-Bag 实现，不另写一套浏览器规则。

当前模式包含开始、暂停、继续、重开、Hold、Next、Ghost，以及行数、块数、PPS 和 APM 统计。页面失去焦点或转入后台时会暂停练习并清空按住状态，避免返回页面后误触。

## 时序与输入

- `SoloGameSession` 以固定 `240 Hz` 推进，与显示器刷新率和 `requestAnimationFrame` 频率解耦；
- 每个模拟 tick 都会推进本地 Handling，因此 60、120、144 Hz 的显示器不会改变 DAS、ARR、DCD 或 SDF 的计时语义；
- 同步追帧有上限，页面长时间挂起后不会为偿还过期墙钟时间而阻塞 UI；
- 物理键先由本地 Handling 展开为具体移动、旋转、Hold 和 Drop 操作，再进入本地模拟；
- `/play/solo` 不建立对局连接，也不等待服务器 ACK，所以连续操作之间没有网络 RTT 下限。
- `preferSoftDrop` 会在有限软降与横移重复同刻到期时优先软降；
- DCD 从模拟确认的新方块出生时刻开始，覆盖自然锁定、Hard Drop 和成功 Hold；失败 Hold 不会截断 DAS；
- DCD 保留已经积累的 DAS，只暂停配置的时长；设为 `0F` 时允许跨方块 DAS preservation；
- Safe Lock 仅在自然锁定后启用两个 60 Hz 参考帧的硬降保护窗，Hard Drop/Hold 生成不会触发。

玩家的键位和 Handling 继续由版本化 `PlayerConfig` 管理，整份配置只保存在浏览器 `localStorage`。服务端不会收到配置值；未来房间对局也只上传由这些配置产生的具体操作。

## 顶部空间与镜头

- 七种方块通常都在 20 行主可视区内出生，Block Out 只检查新方块自己的四个出生格；
- 默认 No Lockout，其他列堆到 skyline 以上不会直接结束；
- 上一块消行后若下一块固定出生位受阻，Clutch 会在 40 行矩阵中向上寻找最低合法位置；这一资格也覆盖立刻 Hold 换出的方块；
- 已锁定堆叠到达 `y=17` 后，画布从 20 行开始渐进扩展，并为堆顶保留三行视野；
- 扩展约 90ms、收回约 180ms；系统启用“减少动态效果”时立即切换；
- 镜头始终以地板为锚点，最高可展示完整 40 行；顶部淡红区域与分界线只是视觉提示，不改变核心规则。

公开资料没有披露 TETR.IO 镜头的精确阈值和动画曲线；上述镜头参数是按观察复刻的 TETR-D 显示策略。出生、Clutch、No Lockout 与 40 行上界则属于共享权威规则。

## 确定性 7-Bag

每次创建本地练习会生成一个有效的 128-bit seed，并由 `LocalSevenBagPieceSource` 调用共享的确定性 7-Bag 实现。给定同一 seed，方块序列可以完全复现；当前同一练习会话内的“重开”复用该 seed，因此重开后的包序列相同。

这项确定性只描述单人练习的本地序列。双人房间仍由服务端的 `SharedSevenBagState` 提供双方完全相同、各自独立游标的序列。

## 为房间预留的边界

页面依赖 `GameSession`，而不是直接依赖 `PlayerSimulation`。该接口统一暴露：

- `start / pause / resume / restart` 生命周期；
- `advanceTo` 固定步进推进；
- `dispatch` 具体操作入口；
- snapshot、订阅与释放。

当前实现是 `SoloGameSession`。后续房间模式可以增加 room-backed session，在接口后组合本地预测、操作流水上传、服务端 snapshot 校正与终局裁决，而不要求棋盘、HUD 和 Overlay 直接理解 WebSocket 协议。

## 已知限制

- 锁定方块目前显示为中性色，垃圾行为灰色条纹；核心棋盘只保存占用与垃圾标记，尚未保存每格原方块颜色；
- 当前没有音效、回放或持久练习记录；
- 单人页面尚未接入房间、共享双人序列或服务端权威对局；
- IRS/IHS 生成缓冲仍需完成最终对局接线。
