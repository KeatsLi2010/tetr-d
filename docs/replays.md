# 权威对局回放

服务端回放是权威模拟的输入日志，不是定时棋盘截图。默认由
`MATCH_REPLAY_DIR` 指定目录；正式部署应把它放在 immutable release
之外，例如 `C:\Users\keats\tetr-d\data\replays`。

## 记录边界

每局文件包含：

- 开头：协议、规则、旋转系统、共享 7-BAG 版本、tick 频率、双方身份及
  7-BAG/三路比赛 RNG 的 SHA-256 commitment；
- 过程：`MatchInputQueue.drain(serverFrame)` 后真正进入该权威帧的动作，
  以及 `clearHeld`、`resetInput` 控制事件；
- 结尾：胜者、原因、共享 7-BAG seed、双方攻击取整 RNG、垃圾洞 RNG，
  以及双方最终权威状态哈希。

回放不会记录客户端本地键位、DAS/ARR/DCD/SDF、IRS/IHS 偏好，也不会记录
30 Hz 周期 snapshot。这样重放的是服务器实际接受并应用的离散操作，而不是
客户端配置或网络到达抖动。

## 文件完整性

格式是逐行 JSON。每条记录带递增 ordinal、上一条记录哈希和本条 SHA-256
哈希，读取时会逐条验证：

- ordinal 连续；
- `previousHash` 正确；
- 内容哈希正确；
- header / frame / end 顺序正确；
- header 的 match ID 与请求一致。

写入期间文件以 `<matchId>.jsonl.partial` 存在。完整终局会等待前序动作写入，
执行文件同步并关闭后，再原子改名为 `<matchId>.jsonl`。服务器中途关闭时只
同步并关闭 `.partial`，不会生成伪造的完整终局。

## 确定性重放

重放器先验证两个 seed commitment，再按原 participant 顺序恢复每帧 action
批次。空白帧由 tick 频率补齐；同帧之后的 `clearHeld` / `resetInput` 保持日志
顺序。对局自然 top-out 时由同一 `MatchCoordinator` 判定；认输、断线判负和
强制平局只在日志终局帧执行。

完成后，重放得到的双方最终状态哈希必须与日志终局哈希一致。垃圾包的顺序、
攻击取整和垃圾洞都由终局 reveal 的三路独立 RNG 恢复，因此也包含在这项
确定性校验内。
