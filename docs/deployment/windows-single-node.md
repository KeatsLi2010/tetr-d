# Windows 单机 MVP 部署

## 已探测环境（2026-07-25）

- 主机：`192.168.10.207`，Windows 11 64-bit。
- Node.js `v24.18.0`，npm `11.16.0`，Git 可用。
- 未发现 Docker、Caddy 或 Nginx。
- `4173` 已由 `C:\Users\keats\juan\server.js` 占用，TETR-D 不触碰该进程。
- TETR-D 预留 `4180`；上线前再次检查监听状态。

## 目录与发布单元

```text
C:\Users\keats\tetr-d\
  releases\
    <release-id>\
  current.txt
  data\
  logs\
  scripts\
    run-current.ps1
```

- 每次发布先解压到新的 `<release-id>` 目录；依赖安装和验证完成后不再修改其内容。
- `<release-id>` 使用发布制品的内容标识；源码 commit、制品 SHA-256 和 release ID 分别记录。
- `data` 和 `logs` 放在 release 外，升级不覆盖。
- `current.txt` 只保存当前 release 的绝对路径；目录名同时作为服务的 `BUILD_ID`。
- 不在服务器上直接编辑 release 源码。

## 持久运行

远程 SSH 会话中直接启动的进程可能随会话退出。当前 staging 使用计划任务 `TetrD-Staging` 运行一个短生命周期的 ensure-service launcher，而不是让 PowerShell 任务永久承载 Node：

- 主体：交互式 `keats`；机器重启后必须先登录该用户。
- 触发器：用户登录时运行，并以一分钟间隔重复执行长期 watchdog。
- 设置：实例重叠时忽略新实例、无普通执行时限、`StopOnIdleEnd=false`。
- 动作：`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\keats\tetr-d\scripts\run-current.ps1 -DeploymentRoot C:\Users\keats\tetr-d -MatchTickRateHz 240`。
- 脚本先验证 `current.txt`、release 边界和 release 外的固定 secret/Origin/Host allowlist。
- 预期 build 已健康时立即退出 0；4180 被非预期服务占用时拒绝接管。
- 端口空闲时以隐藏窗口启动 detached Node，重定向 stdout/stderr，并等待预期健康状态。
- 新进程验证失败时只终止本次启动的确切 PID；成功时向 `logs\launcher.log` 追加 `server.detached` JSON 记录后退出 0。

因此正常状态是计划任务 `Ready`、最近结果为 0，而独立的 Node 进程监听 4180。服务健康必须通过 `/api/health`、监听 PID 和日志判断，不能以任务是否显示 `Running` 判断。

不得复用或修改现有 `juan` 任务/进程。

仓库已提供 `ops/windows/run-current.ps1`。部署副本位于 `scripts`，调用时必须显式传入 `-DeploymentRoot`；脚本会设置 `HOST=0.0.0.0`、`PORT=4180`、`NODE_ENV=production`、当前 release ID 和 `MATCH_TICK_RATE_HZ`。Task Scheduler 本身没有可依赖的“项目环境变量”字段。

`MATCH_TICK_RATE_HZ` 是权威比赛模拟频率，允许 `60..1000` 的整数，默认 `240`。部署脚本通过 `-MatchTickRateHz` 暴露该设置，例如 `-MatchTickRateHz 480`；未传时稳定使用 240，而不依赖启动账户的临时环境。修改频率需要受控重启，`/api/health` 的 `matchTickRateHz` 必须与启动参数一致。240 Hz 只提高服务器内部模拟时间分辨率；对局快照仍独立限为 30 Hz，不会把每个 tick 都广播给客户端。

`secrets\allowed-hosts.txt` 使用逗号分隔的精确 Host（必须包含客户端实际发送的端口），例如 staging 使用 `192.168.10.207:4180,SERVER-CHECKER:4180`。脚本会在 Origin 或 Host allowlist 为空时直接拒绝启动。

## 更新流程

以下流程部署当前可玩的 LAN 双人版本；公网 TLS、持久账号和完整异常恢复演练完成前，该服务仍标识为 staging：

1. 本地执行 `npm ci`、`npm run typecheck`、`npm test` 和 `npm run test:size`，记录源码来源。
2. 生成发布 zip、SHA-256 和唯一 release ID。
3. 上传到服务器临时目录，校验 hash。
4. 解压到全新的 `releases\<release-id>`，安装依赖并在切换前完成测试；此后不再修改 release。
5. 备份 `current.txt`，核对现有 4180 监听的 PID、进程所有者、命令行与健康 build。
6. 排空并受控停止已验证的旧 TETR-D PID，确认端口空闲；不得终止身份不明的监听进程。
7. 原子替换 `current.txt`，再启动 `TetrD-Staging`；ensure-service launcher 会创建新的 detached Node。
8. 在服务器本机请求 `http://127.0.0.1:4180/api/health`，核对 build、协议/规则版本及 `matchTickRateHz`。
9. 从开发机请求 `http://192.168.10.207:4180/api/health` 并完成 WebSocket 1v1 smoke test；比赛 smoke 至少覆盖同包开局、输入 ack、snapshot 和一条终局路径。
10. 失败时只停止已验证的新 TETR-D PID，恢复旧 `current.txt` 并重新启动任务；不删除失败 release，保留日志供诊断。

仅切换 `current.txt` 后重启任务是不够的：若旧 build 仍监听 4180，launcher 会按设计拒绝接管端口。

## 网络与 TLS

LAN 验证阶段可以使用 `http://192.168.10.207:4180` 和 `ws://...`，Windows 防火墙规则只开放 TCP 4180 给可信内网网段。即使只在 LAN，WebSocket 握手也必须校验 `Origin` 与 `Host` allowlist，防止恶意公网网页借用户浏览器直接连接内网服务。

公网阶段需要域名，不能为普通私网 IP 申请公开受信任证书。届时安装 Caddy 或由现有反向代理终止 TLS：

- 外部只开放 80/443；
- `/` 代理静态 web/API；
- `/ws` 保留 Upgrade/Connection 头并代理到 `127.0.0.1:4180`；
- Node 端口仅绑定 loopback；
- 启用 HSTS、安全 cookie、origin allowlist 和代理来源校验。

## 上线门槛

当前仓库已完成 WebSocket 握手、房间、共享开局序列、权威比赛内核和浏览器双人对局。LAN staging 已可玩，但尚不标成公网生产版本。当前已完成的门槛包括：

- 严格 WebSocket schema、心跳、Origin/Host/子协议校验、限流与背压；
- room actor/runtime/outbox 与真实两客户端集成测试；
- 同一局唯一共享 7-Bag、双方独立游标、commitment 与 14 块同窗测试；
- 可配置固定步进 Match Coordinator（默认 240 Hz）、服务端棋盘/输入/攻击/垃圾/终局和 30 Hz snapshot 测试；
- `versus-srs-plus-tetrio-s2-v2` 规则版本与独立攻击、垃圾洞随机域；
- 单次轮换 resume token、connection generation 与重连房间状态；
- LAN 内外健康检查、Origin 拒绝测试和真实双客户端 `match.start` smoke test；
- 双人棋盘、本地即时预测、权威快照校正、同包显示、双方受击预览条与 B2B 状态；
- 双浏览器创建、加入、并发准备、输入同步和认输终局验收；
- TCP 4180 私有 LAN 防火墙边界；
- launcher 退出和 SSH 断开后 Node 仍存活，watchdog 重复运行不会创建重复进程。

公网生产版本仍至少需要：

- tick 频率变更/过载恢复演练；
- 完整比赛内重连、持久回放和异常退出恢复测试；
- 更新/回滚时的排空、受控停止与恢复演练；
- 公网域名、TLS、反向代理和生产级服务托管。
