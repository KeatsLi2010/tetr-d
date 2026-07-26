# TETR.IO Season 2 双人攻击规则档案

项目规则版本：`versus-srs-plus-tetrio-s2-v3`。

本档案用于冻结可重放的服务器行为。TETR.IO 并未公开服务器源码；因此这里的“严格参考”指公开规则可确认的部分逐项实现和测试，而不是声称得到私有实现的逐字节副本。

## 采用的当前规则

- 基础攻击：普通或 Mini 消 1/2/3/4 行为 `0/1/2/4`；Full Spin 为 `2/4/6/10`。
- 连击原值为 `(Basic + B2B) * (1 + Combo * 0.25) + AC`。基础项为零时使用 `ln(1 + 1.25 * Combo)`。
- 本档案按第二赛季的加权随机取整：小数部分是向上取整概率。随机数来自对局专用的确定性随机流，禁止使用 `Math.random()`，也禁止与 7-Bag 或垃圾洞随机流共享状态。
- 连续 difficult clear 的 B2B 攻击固定 `+1`。显示达到 `B2B x4` 后，Surge 等于当前显示计数；普通消一/二/三打断时分三包发出，余数依次放进前面的包。
- All Clear 额外加 `5`，并把该次消行视为 difficult clear。
- Quad 或任意 Spin 若实际清除了垃圾行，最终攻击平坦 `+1`，不进入连击倍率。
- 默认 All-Mini+：非 T 的 immobile Spin 为 Mini；T 也允许 immobile Mini 回退。
- 首 14 块 Opener Phase 只加强抵消，不凭空增加对外攻击。
- 默认 Zero Passthrough、Combo Blocking、change-on-attack；每个攻击包使用一个洞，Surge 三段是三个独立包。

## 出生、Clutch 与顶出

- 内部矩阵固定为 `10×40`；`y=0..19` 是主可视区，`y=20..39` 是 No Lockout 与 Clutch 使用的隐藏空间。
- 默认 No Lockout：一块方块完全锁在 20 行 skyline 以上不会单独触发失败。
- 普通出生只检查新方块自己的四个固定出生格；固定位置与地形重叠即 Block Out，其他列高于 skyline 不构成失败。
- TETR-D 的标准出生原点为 `x=3, y=17`，保证七种方块的初生四格都位于主可视区内。
- 上一块完成消行后，下一块获得一次 Clutch 上浮资格：若固定出生位受阻，则保持 `x` 与 spawn 朝向不变，逐行上移并取 40 行矩阵内的最低合法位置。该资格也覆盖这一块立刻 Hold 后生成的替换块。
- 未消行、初局及普通 Hold 不允许上浮。垃圾把已有地形推出第 40 行时仍立即失败。
- 危险区镜头缩放只改变客户端显示范围，不参与服务端碰撞、Clutch 或胜负判定。

## 仍需回放校准的策略参数

公开材料没有完整给出 Tetra League 垃圾 cap 的增长曲线、同一逻辑帧多攻击的内部稳定排序、Opener Phase 奇数抵消的精确消费顺序，以及全部垃圾洞防重复概率。本版本把这些项目保持为集中配置；任何校准都会产生新的规则版本，旧录像仍使用旧版本。

## 参考资料

- [用户指定的俄罗斯方块中文维基 TETR.IO 页面](https://tetris.huijiwiki.com/wiki/Tetr.io)：攻击表、第二赛季加权随机取整、B2B Charging、PC5、Opener Phase 与挖垃圾 `+1`。
- [TETR.IO 官方更新日志](https://tetr.io/about/patchnotes/)：Beta 1.2.0 的 Season 2 规则、Beta 1.3.0 的挖垃圾平坦 `+1`、Beta 1.5.0 的 All-Mini+ 与新版 Clutch、Alpha 6.3.4 的默认 No Lockout。
- [TetrisWiki 的 TETR.IO 机制页](https://tetris.wiki/TETR.IO)：Multiplier 公式、Surge 三段、Opener Phase、Zero Passthrough、Clutch 与时序背景。
- [俄罗斯方块中文维基的 TETR.IO 页面](https://tetriswiki.cn/p/TETR.IO)：`10×22+18` 场地记录，以及当前 No Lockout 与 Clutch 的中文说明。
- [TETR.IO 官方术语页](https://tetrio.github.io/faq/terminology.html)：change-on-attack 的单包同洞定义。

英文 Wiki 当前将普通多人默认取整描述为向下取整，而用户指定的中文页明确把第二赛季 Tetra League 描述为按小数概率取整。本项目的这个规则版本选择后者，并同时保留 `down` 计算模式供自定义房间或之后校准使用。
