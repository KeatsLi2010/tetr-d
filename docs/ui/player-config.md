# 玩家本地配置 UI

## 信息架构

首版个人配置页分为：

1. **键盘绑定**：Guideline、WASD 与 Custom；每个动作最多三个物理键码；
2. **操作手感**：ARR、DAS、DCD、SDF；
3. **高级输入**：换向 DAS cancellation、Safe Lock、软降优先、IRS、IHS；
4. **Handling Lab**：不进入房间即可用当前配置即时测试。

画面与音频保留导航位置，但在对应功能真正实现前不提供无效控件。

## 本地存储

- 使用版本化 `localStorage`；
- 保存 `KeyboardEvent.code`，不保存受键盘布局影响的 `event.key`；
- 配置不随游客会话、房间消息或比赛消息上传；
- 支持 JSON 导入、导出、恢复默认和跨标签页更新；
- 存储不可用时继续使用内存配置，并显示保存失败。

## 键位冲突

同一个物理键允许绑定多个同作用域动作，UI 会明确警告但不阻止保存。
对局按稳定动作顺序同时触发。`Esc` 取消捕获，`Backspace/Delete` 清空槽位。
浏览器原生 `KeyboardEvent.repeat` 始终忽略。

## Handling 参考

范围和默认值依据 2026-07-14 可访问的 TETR.IO CONFIG 控件与公开 FAQ：

| 参数 | 范围 | 步进 | 默认 |
|---|---:|---:|---:|
| ARR | 0–5F | 0.1F | 2F |
| DAS | 1–20F | 0.1F | 10F |
| DCD | 0–20F | 0.1F | 0F |
| SDF | 5–40 / MAX | 1 | 6× |

界面借鉴现代方块游戏对参数的分组方式，不复制 TETR.IO 的品牌、素材或页面代码。
