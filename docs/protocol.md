# 实时对战协议 v4

类型契约位于 `packages/protocol/src`，运行时严格 schema 位于 `apps/server/src/gateway/schemas`。

## 传输

- WebSocket 路径：`/ws`
- 子协议：`tetr-d.v4`
- 文本 JSON；单条消息上限 8 KiB；关闭压缩扩展。
- 生产环境使用精确 `Origin` allowlist。
- 未知字段、非有限数字、超长 ID、内部命令字段和二进制消息均被拒绝。

客户端第一条消息必须是：

```json
{
  "type": "hello",
  "protocolVersion": 4,
  "buildId": "web-dev",
  "resumeToken": "optional"
}
```

服务端返回：

```json
{
  "type": "welcome",
  "protocolVersion": 4,
  "connectionId": "c_...",
  "heartbeatMs": 15000
}
```

协议版本不匹配时发送 `PROTOCOL_MISMATCH` 并以 1002 关闭。客户端 5 秒内不发送 hello，或累计 3 条非法消息，会以策略错误关闭。

## 游客会话与恢复

新游客发送 `auth.guest(displayName)`，收到 `auth.ok(player, resumeToken)`。

Resume token 是 256-bit 不透明值。服务端只保存 HMAC-SHA256 digest。成功恢复时必须原子完成：

1. 消费旧 token；
2. 生成并返回新 token；
3. 增加 `connectionGeneration`；
4. 关闭被替代的旧 Socket；
5. 用 `connection.replace` 或 `connection.resumed` 恢复房间连接。

旧 token、旧 generation、旧 Socket 的迟到消息和迟到 close 全部失效。

## 房间消息

创建与加入：

- `room.create(requestId, settings?)`
- `room.join(requestId, roomCode, participation, preferredSeat?)`

其余写命令携带：

```json
{
  "requestId": "client-unique-id",
  "roomId": "room-id",
  "expectedRevision": 12
}
```

网关逐字段映射客户端消息，并从认证会话注入玩家身份；RoomActor 注入服务端时间。客户端永远不能构造 `actorPlayerId`、`atMs`、`connection.*`、`timer.*` 或 `match.finished`。

`room.state` 是 viewer-specific 投影：包含自己的席位和权限，但不含 connection ID、token、内部 epoch 或随机 seed。

- `revision`：影响控制决策的提交版本。
- `presenceSequence`：所有公开状态提交的单调序列，包括纯在线状态变化。
- 版本冲突返回 `REVISION_CONFLICT` 与当前 revision。
- Actor 对 `(sessionId, requestId)` 做幂等；重放只返回原 receipt 和当前快照，不重放 effect。

## 倒计时与开局

双方在线且准备后，服务端发送 `match.countdown`：

```json
{
  "type": "match.countdown",
  "roomId": "...",
  "countdownId": 1,
  "seriesId": "...",
  "gameNumber": 1,
  "startsAtServerTime": 1234567890
}
```

真正的 `matchId` 只在计时器成功到期并创建比赛时生成。`match.start` 的关键字段：

```json
{
  "type": "match.start",
  "matchId": "m_...",
  "pieceSequenceVersion": "shared-seven-bag-v1",
  "pieceSequenceCommitment": "64-char-sha256-hex",
  "selfPieceCursor": 0,
  "selfPieceWindow": [
    "T", "I", "O", "L", "S", "Z", "J",
    "J", "Z", "T", "O", "I", "L", "S"
  ],
  "rulesetVersion": "versus-srs-plus-tetrio-s2-v3",
  "simulationHz": 240,
  "inputEpoch": 0,
  "serverFrame": 0,
  "players": []
}
```

同一局两名玩家收到：

- 完全相同的 commitment；
- `selfPieceCursor = 0`；
- 完全相同且固定为 14 块的 `selfPieceWindow`；
- 索引 `0..6` 和 `7..13` 分别是完整 bag，双方对应 bag 的排列完全相同。

观战者收到相同 commitment，但 `selfPieceCursor = null`、`selfPieceWindow = []`、`inputEpoch = null`。

服务端只维护一个共享序列，玩家消费游标独立。客户端速度和 Hold 不能改变任何 bag 的排列。

## Commitment 与 reveal

活动比赛期间不发送 seed。当前 commitment 绑定域、`matchId`、`rulesetVersion` 和私密 128-bit seed。

`match.end` 包含可审计的序列 reveal：

```json
{
  "pieceSequenceReveal": {
    "version": 1,
    "matchId": "m_...",
    "rulesetVersion": "versus-srs-plus-tetrio-s2-v3",
    "seedHex": "32-char-hex"
  }
}
```

客户端可用 reveal 复算 SHA-256 commitment，并重放完整共享序列。权威 Coordinator 在 top-out、同时 top-out、投降、断线超时或内部安全平局时生成 `match.end`，客户端不能自行写入结果。

## 输入与状态同步

协议定义 `match.input`、`match.inputAck`、`match.snapshot`、`match.delta`、`match.resyncRequest` 和 `match.end`。权威路径已实现按接收者选择 full/delta、基线校验、单次重同步请求与持久回放；详见 [状态同步](match-state-sync.md) 和 [持久回放](replays.md)。

当前规则：

- 玩家键位、DAS、ARR、DCD、SDF 和高级 Handling 配置只保存在本地，协议不上传整份配置。
- 客户端在本地把物理按键和重复计时展开为具体操作，再通过 `match.input` 上传。新增的具体操作包括：
  - `moveStep(direction)`：横移一格；
  - `moveToWall(direction)`：立即横移到可达墙边；
  - `softDropStep(cells)`：向下移动 `1..40` 格；
  - `sonicDrop`：移动到最低可达位置但不主动锁定；
  - `clearHeld`：窗口失焦时清理兼容 held 状态。
- 旋转、Hold 和硬降继续作为离散 action 发送；旧的 `move` / `softDrop` 边沿 action 暂时保留用于协议迁移。
- 输入按 `inputEpoch + sequence` 去重与排序；单消息最多 16 个 action。客户端可连续发送多个批次，不以 `match.inputAck` 作为下一次发送的门闩。
- 输入限流独立于普通房间消息，默认平均 120/s、突发 240。
- 客户端先本地预测再发送；ACK 和 snapshot 异步确认并触发必要的纠偏/重放，不增加每两次本地操作之间的最小 RTT。
- 服务端为 action 排序、验证并分配应用 frame，权威决定碰撞、锁定、消行、攻击、垃圾、KO 和结果；客户端不能上传坐标或结果。新具体操作路径不由服务器重新计算玩家的 DAS/ARR/SDF。
- `match.start.simulationHz` 是本局权威模拟频率；默认 240，可由服务端环境在 `60..1000` 范围配置。它不是 snapshot 或浏览器渲染频率。
- 权威模拟默认以 30 Hz 发送 snapshot；重连或 `match.resyncRequest` 可立即请求完整 snapshot。
- Snapshot 只向本人公开私有游标/窗口、输入与垃圾洞口状态；对手和观战者只接收公开状态。
- `match.end` 是唯一结果裁决，客户端本地 top-out 不能写入战绩。

## 心跳、限流与背压

- WebSocket ping/pong 检测死连接；应用层 `ping(clientTime)` 返回 `pong`。
- 普通消息 token bucket 默认平均 10/s、突发 20。
- 每连接发送缓冲区有硬上限；持续背压会隔离该连接，不能阻塞房间 actor。
- 房间关键 effect 经有序 outbox 投递；网络广播是 best-effort，状态可通过最新 `room.state` 恢复。
