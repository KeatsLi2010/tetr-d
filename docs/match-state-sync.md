# 对局状态同步

权威模拟以配置的 tick 频率推进；网络状态默认只在 30 Hz 发送。协议 v4
允许服务器在完整 `match.snapshot` 与增量 `match.delta` 之间逐接收者选择，
因此双方不必共享同一条增量基线。

## 发送基线

以下情况发送完整 snapshot：

- 接收者尚无已确认发送的基线；
- WebSocket connection generation 变化；
- 前一次发送因背压、连接失效或同步发送异常而未被接受；
- Coordinator 已丢弃接收者所缺的事件；
- 生成的 delta 不小于完整 snapshot；
- 客户端发送 `match.resyncRequest`。

服务器只有在 `ConnectionHub.send` 返回 `accepted` 后才推进该接收者的基线。
这里的 accepted 表示消息已进入当前可靠 WebSocket 的发送缓冲，并不表示客户端
已经渲染。若发送被拒绝，基线立即清除，下一次可发送状态必须是完整 snapshot。

## Delta 内容

每条 `match.delta` 都携带：

- `baseStateSequence` 与 `basePublicStateHash`，指明唯一可应用的前态；
- 新的 state/event sequence、server frame 和公开/私有状态哈希；
- 按玩家拆分的 patch；
- 自上一基线后的连续公开事件；
- 当前 viewer 的完整私有 `self` 状态。

棋盘 patch 只列出变化行，并同时携带占用 bit mask 与垃圾来源标志。仅活动块等
字段变化时，客户端 reducer 复用原 `boardRows` / `garbageRows` 数组引用，使
分层 Canvas 渲染可以跳过静态层重画。

## 客户端恢复

客户端只在以下条件全部满足时应用 delta：

1. match ID 与当前比赛一致；
2. base sequence 与本地 snapshot 相等；
3. base public hash 相等；
4. 事件 sequence 连续；
5. 所有玩家 patch 与棋盘行索引合法。

任一条件失败时保留最后一份可信 snapshot，并发送一次
`match.resyncRequest`。等待完整 snapshot 期间，重复坏 delta 不会产生请求风暴。
服务器可能返回与本地相同 state sequence、但重新投影过的完整 snapshot；存在
未完成 resync 时客户端必须接受这份同序列 snapshot，并清除等待状态。没有
未完成 resync 时，同序列或更旧 snapshot 仍按 stale 忽略。

## 带宽验收

`apps/server/test/matchDeltaProjection.test.ts` 使用 240 Hz 模拟、30 Hz 状态
发送和连续活动块移动作为稳定基准。30 个发送点中，实际 full + delta JSON 为
22,166 bytes，对应全部发送完整 snapshot 的 50,009 bytes，即 44.3%。

该数字是防回归夹具，不是公网流量承诺；棋盘大幅变化或事件突发时比例会变化。
实现始终先比较实际 UTF-8 JSON 字节数，delta 无优势时自动发送完整 snapshot。
