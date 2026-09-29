// 端到端集成测试：真实 BroadcastChannel（Node 18+ 全局支持）模拟 4 个标签页。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, OP, STATUS } from '../js/engine.js';
import { SyncBus } from '../js/sync.js';
import { ClockSync } from '../js/clock.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTab(id) {
  const clock = new ClockSync();
  const tab = { id, clock, peers: [] };
  tab.engine = new Engine({
    tabId: id,
    tabName: id,
    now: () => clock.now(),
    emit: (op) => tab.bus.broadcastOp(op),
    requestSync: () => tab.bus.requestSync(),
  });
  tab.bus = new SyncBus({
    tabId: id,
    getTabName: () => id,
    getLastAction: () => '',
    onClockSample: (s) => clock.addSample(s),
    onOp: (op) => tab.engine.receiveOp(op),
    onSyncRequest: (req) => {
      const ops = tab.engine.exportOps();
      if (ops.length) tab.bus.sendSyncState(ops, req.tabId);
    },
    onSyncState: (ops) => { for (const op of ops) tab.engine.receiveOp(op); },
    onPeers: (peers) => { tab.peers = peers; },
  });
  tab.bus.start();
  return tab;
}

test('4 个标签页实时同步：剩余时间误差 < 50ms，并发操作收敛', async () => {
  const tabs = [makeTab('tab-1'), makeTab('tab-2'), makeTab('tab-3'), makeTab('tab-4')];
  try {
    // tab-1 创建并开始一个 60s 倒计时
    tabs[0].engine.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
    tabs[0].engine.doOp('t1', OP.START);
    await sleep(300); // 等待广播送达 + 真实流逝

    // 验收：4 个标签页剩余时间两两误差 < 50ms
    const remainings = tabs.map((t) => t.engine.remaining(t.engine.getTimer('t1')));
    for (const r of remainings) {
      assert.ok(Math.abs(r - remainings[0]) < 50, `误差过大: ${remainings}`);
    }
    assert.ok(remainings[0] < 60000 && remainings[0] > 59000);

    // 并发暂停：tab-2 与 tab-3 同时暂停
    tabs[1].engine.doOp('t1', OP.PAUSE);
    tabs[2].engine.doOp('t1', OP.PAUSE);
    await sleep(200);
    const states = tabs.map((t) => t.engine.getTimer('t1'));
    for (const s of states) {
      assert.equal(s.status, STATUS.PAUSED);
      assert.deepEqual(s, states[0]); // 全部收敛到同一状态
    }

    // 心跳后每个标签页都能看到其他 3 个在线
    await sleep(2200);
    for (const t of tabs) {
      assert.ok(t.peers.filter((p) => p.online).length >= 3);
    }

    // 离线恢复：tab-4 “断线”（停止接收），其余继续操作，随后补同步合并
    tabs[3].bus.channel.onmessage = () => {};
    tabs[0].engine.doOp('t1', OP.RESUME);
    await sleep(150);
    tabs[0].engine.doOp('t1', OP.RESET);
    await sleep(150);
    assert.equal(tabs[3].engine.getTimer('t1').status, STATUS.PAUSED); // 断线期间停留在旧状态
    // 恢复：tab-4 请求全量同步
    tabs[3].bus.channel.onmessage = (e) => tabs[3].bus._handle(e.data);
    tabs[3].bus.requestSync();
    await sleep(200);
    assert.equal(tabs[3].engine.getTimer('t1').status, STATUS.IDLE);
    assert.deepEqual(tabs[3].engine.getTimer('t1'), tabs[0].engine.getTimer('t1'));
  } finally {
    for (const t of tabs) {
      clearInterval(t.bus.timer);
      t.bus.channel.close();
    }
  }
});
