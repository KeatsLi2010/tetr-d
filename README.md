# TETR-D

TETR-D 是一个现代俄罗斯方块 1v1 对战网站框架。当前已完成 SRS+、双人房间、公平随机序列、服务端权威比赛内核，以及浏览器本地配置、低延迟输入基础与单人练习场。

项目采用独立品牌和自行实现的代码、画面与音效，不复制 TETR.IO 的商标、素材、私有协议或页面代码。这里的 `SRS+` 仅指按公开规则实现并版本化的旋转行为。

## 公平随机序列

同一场比赛只有一个服务端 `SharedSevenBagState`：

- 两名玩家的第 N 个 7-Bag 是完全相同的排列，不只是“都包含七种方块”。
- 两人各自维护消费游标；操作速度、延迟和 Hold 不会重排任一方的序列。
- 开局只公开 SHA-256 commitment 和最多 14 块的有限窗口，不公开实时 seed。
- 两名参赛者在开局游标均为 0，因此收到完全相同的 14 块窗口；观战者收到 `null / []`。
- 局末 `match.end` 发送 seed reveal，客户端可复算 commitment 和整条序列。

实现位于 `packages/game-core/src/sevenBag.ts` 与 `apps/server/src/matchPieceSequence.ts`，端到端测试会用两个真实 WebSocket 客户端核对双方窗口逐块相等。

## 当前已实现

- `packages/game-core`：确定性 SRS+、棋盘/锁定/消行、Spin、TETR.IO Season 2 参考攻击规则、垃圾与共享 7-Bag。
- `packages/room-core`：固定双人席位、可选观战、房主、准备、3 秒倒计时、番战、重连、过期与不变量。
- `packages/protocol`：WebSocket 协议 v4 类型契约，包含 `match.delta` 与重同步。
- `apps/server`：严格 schema、会话/连接隔离、room actor/runtime、effect outbox，以及可配置固定步进 Match Coordinator；权威模拟默认 240 Hz，允许通过 `MATCH_TICK_RATE_HZ` 设置为 `60..1000`。
- 比赛链路：共享同包 7-Bag、`match.input` 调度与 ack、30 Hz snapshot、攻击/垃圾/KO、断线或投降裁决和完整 `match.end`。
- `apps/web`：React + Vite 首页与设置界面、本地键位/Handling 配置、Handling Lab、`/play/solo` 单人练习，以及 `/play/duel` 双人房间和对战棋盘。
- 双人前端：本地即时输入预测、权威 snapshot 校正与待确认输入重放、双方同包序列、双方左侧 FIFO 受击预览条，以及双方醒目的 B2B 状态。
- 自动化测试覆盖双方同包独立游标、固定步进循环、棋盘与攻击规则、Coordinator、网络安全边界、输入时钟漂移和 400 行单文件上限；另有真实双浏览器房间流程验收。

## 尚未完成

当前 LAN 版本已可完成双人房间对局。后续增强项包括：

- 音效、观战 UI、完整确定性局面预测与更细粒度的 snapshot/delta 校正；
- 锁定方块逐格颜色；当前使用中性色显示锁定块；
- IRS/IHS 生成缓冲、SRS+ 旋转与完整方块生成控制器已接线；
- `match.delta` 带宽优化、持久回放与异常恢复校验已完成；
- 持久账号、战绩、匹配、排位和多节点扩展。

## 本地运行

需要 Node.js 24 或更高版本。

```powershell
npm ci
Copy-Item .env.example .env
npm run typecheck
npm test
npm run build
npm run dev:server
```

默认地址：

- Web 首页：`http://127.0.0.1:4180/`
- 单人练习：`http://127.0.0.1:4180/play/solo`
- 双人对战：`http://127.0.0.1:4180/play/duel`
- 健康检查：`http://127.0.0.1:4180/api/health`
- WebSocket：`ws://127.0.0.1:4180/ws`
- 子协议：`tetr-d.v4`

环境变量：

- `HOST`、`PORT`、`BUILD_ID`
- `WS_ALLOWED_ORIGINS`：逗号分隔的精确 Origin；生产环境必须设置。
- `WS_ALLOWED_HOSTS`：逗号分隔的精确 Host（含对外端口）；生产环境必须设置，不支持通配或后缀匹配。
- `WS_ALLOW_INSECURE_DEVELOPMENT=true`：仅在没有完整 allowlist 的本地开发中显式开启；默认开发配置也会 fail-closed，且生产环境或非 loopback 监听始终拒绝开放模式。
- `WS_MAX_CONNECTIONS`、`WS_MAX_CONNECTIONS_PER_IP`：升级前的总连接与单 IP admission 上限。
- `WS_SHUTDOWN_GRACE_MS`：优雅关闭等待期；到期后强制终止剩余 WebSocket。
- `SESSION_HMAC_KEY`：至少 32 字节的 hex 或 base64url；生产环境必须固定保存，不能每次重启随机生成。
- `MATCH_TICK_RATE_HZ`：权威模拟频率，整数 `60..1000`，默认 `240`；网络 snapshot 独立保持 30 Hz。

## 设计文档

- [系统架构](docs/architecture.md)
- [双人房间模式](docs/room-mode.md)
- [实时协议 v4](docs/protocol.md)
- [状态同步](docs/match-state-sync.md)
- [持久回放](docs/replays.md)
- [SRS+ 规则](docs/rules/srs-plus.md)
- [玩家本地配置](docs/ui/player-config.md)
- [单人练习模式](docs/ui/solo-mode.md)
- [本地 Handling 与具体操作协议决策](docs/decisions/0002-local-handling-discrete-input.md)
- [Windows 单节点部署](docs/deployment/windows-single-node.md)
