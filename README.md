# 多标签页同步倒计时

纯原生 Web 技术（BroadcastChannel + IndexedDB + performance.now/rAF + DOM），无任何框架与构建步骤。

## 运行

需要通过 HTTP 访问（BroadcastChannel / IndexedDB 要求同源上下文）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开多个标签页访问 http://localhost:8000
```

## 功能

- 设置倒计时时长（时/分/秒），支持多个倒计时并存
- 开始 / 暂停 / 继续 / 重置 / 删除，任意标签页均可操作
- 多标签页实时同步剩余时间（误差 < 50ms）
- 顶部展示每个在线标签页及其最近操作
- 每个倒计时可展开操作历史（时间、操作标签页、操作、剩余时间）

## 关键设计

**时间表示：绝对纪元截止时间，而非递减计数**
运行中的倒计时只存 `deadline = Date.now() + remainingMs`，剩余时间每帧按
`deadline - Date.now()` 现算。由此直接获得：

- 后台节流：rAF 被暂停不影响计时，回到前台按当前时钟现算，无跳变
- 标签页关闭/刷新：状态在 IndexedDB，重开后按同一 deadline 继续，不丢不错
- 时钟漂移：所有标签页共享同一系统时钟，误差为 0；NTP 校时对所有标签页等效

**并发与乱序：Lamport 版本 + tabId 决胜的 LWW 合并**
每个状态携带 `(version, lastWriter)`，构成全序。本地操作使 version+1；
收到远程状态时仅当 `(version, lastWriter)` 更大才应用。

- 同时开始/暂停：两个操作版本相同，由 tabId 字典序决定唯一胜者，
  所有标签页收敛到同一状态，不冲突
- 消息乱序/延迟：旧版本消息被版本比较直接丢弃，时间不会回跳

**持久化与离线恢复**
- 每次状态变更写入 IndexedDB `timers` 表（put 幂等）
- 历史写入 `history` 表，key 含写入方 tabId + 时间戳 + 序号，全局唯一，
  多标签页历史合并时天然去重
- 启动时先从 IndexedDB 恢复基线，再广播 `hello` 请求全量状态，
  按版本合并离线期间错过的操作；回到前台时也会重新同步

**在线状态**
每 2s 心跳广播（含最近操作描述），6s 未收到心跳判定离线。

## 验收对照

| 验收标准 | 实现 |
|---|---|
| 4 标签页误差 < 50ms | 共享系统时钟 + 绝对 deadline，误差仅为渲染帧差 |
| 同时操作不冲突 | Lamport + tabId 全序，确定性收敛 |
| 后台节流不跳变 | 剩余时间现算，visibilitychange 立即重绘 |
| 离线恢复合并正确 | IndexedDB 基线 + hello/full 全量合并 |
| 刷新后一致 | sessionStorage 保持 tabId，IndexedDB 恢复状态 |
| 历史可查 | history 表持久化，按 key 去重合并 |

## 文件结构

- `index.html` — 页面结构
- `styles.css` — 样式
- `js/db.js` — IndexedDB 封装
- `js/store.js` — 状态机 + BroadcastChannel 同步 + 合并规则
- `js/app.js` — DOM 渲染与交互
