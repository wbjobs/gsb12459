import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, STATUS, OP, isNewer } from '../js/engine.js';

// 可控假时钟
function makeNow(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function makeEngine(tabId, now, sink = []) {
  return new Engine({
    tabId,
    tabName: tabId,
    now,
    emit: (op) => sink.push(op),
    persistTimer: () => {},
    persistOp: () => {},
  });
}

test('并发开始：两个标签页同时 start，按 (version, tabId) 决胜收敛', () => {
  const now = makeNow();
  const opsA = [];
  const opsB = [];
  const a = makeEngine('tab-a', now, opsA);
  const b = makeEngine('tab-b', now, opsB);

  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
  b.receiveOp(opsA[0]);

  // 双方同时 start（相同 version=2）
  a.doOp('t1', OP.START);
  b.doOp('t1', OP.START);
  assert.equal(opsA[1].version, opsB[0].version);

  // 交叉投递
  a.receiveOp(opsB[0]);
  b.receiveOp(opsA[1]);

  const ta = a.getTimer('t1');
  const tb = b.getTimer('t1');
  assert.equal(ta.status, STATUS.RUNNING);
  assert.deepEqual(ta, tb); // 收敛到同一状态（tab-b 的 tabId 更大，胜出）
  assert.equal(ta.lastTabId, 'tab-b');
});

test('消息乱序：旧版本后到达不会引起状态回退/时间跳变', () => {
  const now = makeNow();
  const ops = [];
  const a = makeEngine('tab-a', now, ops);
  const b = makeEngine('tab-b', now);

  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
  a.doOp('t1', OP.START);            // v2
  now.advance(10000);
  a.doOp('t1', OP.PAUSE);            // v3, 剩余 50000

  // b 先收到 v3，再收到 v2（乱序）
  b.receiveOp(ops[0]);
  b.receiveOp(ops[2]);
  b.receiveOp(ops[1]);

  const t = b.getTimer('t1');
  assert.equal(t.status, STATUS.PAUSED);
  assert.equal(t.baseRemainingMs, 50000); // 没有被 v2 覆盖回 60000
  assert.equal(t.version, 3);
});

test('暂停后继续：剩余时间连续，不重置', () => {
  const now = makeNow();
  const a = makeEngine('tab-a', now);
  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
  a.doOp('t1', OP.START);
  now.advance(15000);
  a.doOp('t1', OP.PAUSE);
  assert.equal(a.remaining(a.getTimer('t1')), 45000);
  now.advance(999999); // 暂停期间时间流逝不影响剩余
  assert.equal(a.remaining(a.getTimer('t1')), 45000);
  a.doOp('t1', OP.RESUME);
  now.advance(5000);
  assert.equal(a.remaining(a.getTimer('t1')), 40000);
});

test('后台节流模拟：运行中长时间未渲染，恢复后剩余时间仍正确', () => {
  const now = makeNow();
  const a = makeEngine('tab-a', now);
  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 30000 });
  a.doOp('t1', OP.START);
  now.advance(25000); // 标签页被节流 25s，期间没有 tick
  assert.equal(a.remaining(a.getTimer('t1')), 5000); // 恢复后直接由锚点计算，无跳变
});

test('重置回到初始时长；到时后状态为 done', () => {
  const now = makeNow();
  const a = makeEngine('tab-a', now);
  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 10000 });
  a.doOp('t1', OP.START);
  now.advance(4000);
  a.doOp('t1', OP.RESET);
  assert.equal(a.getTimer('t1').status, STATUS.IDLE);
  assert.equal(a.remaining(a.getTimer('t1')), 10000);
  a.doOp('t1', OP.START);
  now.advance(10000);
  a.doOp('t1', OP.EXPIRE);
  assert.equal(a.getTimer('t1').status, STATUS.DONE);
  assert.equal(a.remaining(a.getTimer('t1')), 0);
});

test('离线合并：标签页关闭期间错过的 op，通过全量同步幂等合并', () => {
  const now = makeNow();
  const opsA = [];
  const a = makeEngine('tab-a', now, opsA);
  const b = makeEngine('tab-b', now);

  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
  b.receiveOp(opsA[0]);
  // b “离线”（收不到消息），a 继续操作
  a.doOp('t1', OP.START);
  now.advance(5000);
  a.doOp('t1', OP.PAUSE);
  // b 重新上线，收到 sync-state 全量 op（含已收到的 create，幂等）
  for (const op of opsA) b.receiveOp(op);

  const t = b.getTimer('t1');
  assert.equal(t.status, STATUS.PAUSED);
  assert.equal(t.baseRemainingMs, 55000);
  assert.equal(t.version, 3);
});

test('刷新恢复：从快照 + op 日志重放，收敛到一致状态', () => {
  const now = makeNow();
  const opsA = [];
  const a = makeEngine('tab-a', now, opsA);
  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
  a.doOp('t1', OP.START);
  now.advance(7000);
  a.doOp('t1', OP.PAUSE);

  // 模拟刷新：全新引擎用 IndexedDB 中的行重放
  const timerRows = [a.getTimer('t1')];
  const b = makeEngine('tab-b', now);
  b.boot(timerRows, opsA);
  const t = b.getTimer('t1');
  assert.equal(t.status, STATUS.PAUSED);
  assert.equal(t.baseRemainingMs, 53000);
  assert.equal(t.version, 3);
});

test('重放确定性：op 日志任意顺序重放结果一致', () => {
  const now = makeNow();
  const opsA = [];
  const a = makeEngine('tab-a', now, opsA);
  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
  a.doOp('t1', OP.START);
  now.advance(3000);
  a.doOp('t1', OP.PAUSE);
  a.doOp('t1', OP.RESUME);
  a.doOp('t1', OP.RESET);

  const shuffled = [...opsA].reverse();
  const b = makeEngine('tab-b', now);
  b.boot([], shuffled);
  assert.deepEqual(b.getTimer('t1'), a.getTimer('t1'));
});

test('重复投递幂等；isNewer 决胜规则', () => {
  const now = makeNow();
  const opsA = [];
  const a = makeEngine('tab-a', now, opsA);
  const b = makeEngine('tab-b', now);
  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
  b.receiveOp(opsA[0]);
  const r = b.receiveOp(opsA[0]);
  assert.equal(r.dup, true);
  assert.equal(b.getTimer('t1').version, 1);

  assert.equal(isNewer(2, 'a', 1, 'z'), true);
  assert.equal(isNewer(2, 'a', 2, 'b'), false);
  assert.equal(isNewer(2, 'c', 2, 'b'), true);
});

test('删除同步：delete op 后计时器从列表消失', () => {
  const now = makeNow();
  const opsA = [];
  const a = makeEngine('tab-a', now, opsA);
  const b = makeEngine('tab-b', now);
  a.doOp('t1', OP.CREATE, { name: 'x', durationMs: 60000 });
  b.receiveOp(opsA[0]);
  a.doOp('t1', OP.DELETE);
  b.receiveOp(opsA[1]);
  assert.equal(a.listTimers().length, 0);
  assert.equal(b.listTimers().length, 0);
});
