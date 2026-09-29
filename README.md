# 多标签页同步倒计时

纯原生 Web 技术（BroadcastChannel + IndexedDB + performance.now() + DOM），无任何框架。
多个标签页 / 窗口共享同一组倒计时，任意标签页可开始、暂停、继续、重置，其余标签页实时同步。

## 运行

需要通过 HTTP 访问（ES Module 限制 file:// 协议）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000 ，多开几个标签页即可
```

## 测试

```bash
node --test test/
```

## 功能

- 设置倒计时时长（分/秒），双击标题可重命名
- 开始 / 暂停 / 继续 / 重置 / 删除，按钮按状态启停
- 多个倒计时并存，各自独立同步
- 右侧面板展示每个标签页的在线状态与最近操作
- 每个倒计时卡片可展开完整操作历史（含操作者、版本号、被忽略的乱序消息）

## 一致性设计（对应关键约束）

| 约束 | 方案 |
| --- | --- |
| 同时开始/暂停冲突 | 每个操作携带 Lamport 版本号，版本相等时按 tabId 字典序决胜（last-writer-wins），所有标签页收敛到同一结果 |
| 后台节流 | 剩余时间永远由「锚点墙钟 + 剩余基准」实时计算，不依赖定时器累计，恢复后不跳变 |
| 标签页关闭 | 每次操作写入 IndexedDB（快照 + 完整 op 日志），关闭/崩溃不丢 |
| 消息乱序 | op 携带全量状态快照，过期版本直接忽略（记入历史并标记），不会回退 |
| 离线恢复 | 重新上线后广播 sync-request，对端回全量 op 日志，幂等合并 |
| 刷新恢复 | 启动时从 IndexedDB 重放 op 日志，按 (version, tabId) 排序确定性收敛 |
| 时钟漂移 | 心跳消息携带发送方墙钟，滑动窗口中位数估计偏移并校正 |

## 文件结构

- `index.html` — 页面结构
- `css/style.css` — 样式
- `js/engine.js` — 倒计时状态机 + 一致性核心（纯逻辑，可单测）
- `js/sync.js` — BroadcastChannel 通信（op 广播、心跳、补同步）
- `js/clock.js` — 跨标签页时钟偏移估计
- `js/db.js` — IndexedDB 封装
- `js/app.js` — UI 渲染与事件
- `test/engine.test.mjs` — 一致性测试（并发/乱序/离线/重放等 10 例）
