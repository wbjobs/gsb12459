// 倒计时引擎：纯逻辑，无 DOM 依赖，可在 Node 中测试。
// 一致性模型：每个操作(op)携带 Lamport 版本号 + 全量状态快照。
// 收敛规则：last-writer-wins，按 (version, tabId) 字典序比较，保证并发/乱序下所有标签页收敛到同一状态。

export const STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
});

export const OP = Object.freeze({
  CREATE: 'create',
  CONFIGURE: 'configure',
  START: 'start',
  PAUSE: 'pause',
  RESUME: 'resume',
  RESET: 'reset',
  EXPIRE: 'expire',
  DELETE: 'delete',
});

export const OP_LABELS = Object.freeze({
  create: '创建',
  configure: '设置',
  start: '开始',
  pause: '暂停',
  resume: '继续',
  reset: '重置',
  expire: '到时',
  delete: '删除',
});

export function makeTimer(id, name = '倒计时', durationMs = 60000) {
  return {
    id,
    name,
    durationMs,
    status: STATUS.IDLE,
    baseRemainingMs: durationMs, // 最近一次锚定时的剩余时间
    anchorWall: 0,               // 最近一次锚定的墙钟时间（发送方时钟域）
    version: 0,                  // Lamport 版本
    lastTabId: '',               // 最后一次写入的标签页（版本相等时决胜）
    deleted: false,
  };
}

// (version, tabId) 字典序：a 是否比 b 新
export function isNewer(versionA, tabIdA, versionB, tabIdB) {
  if (versionA !== versionB) return versionA > versionB;
  return tabIdA > tabIdB;
}

export class Engine {
  /**
   * @param {object} deps
   * @param {string} deps.tabId 本标签页唯一 id
   * @param {string} deps.tabName 本标签页显示名
   * @param {() => number} deps.now 返回“全局一致”的墙钟毫秒（已做时钟偏移校正）
   * @param {(timer:object) => void} [deps.persistTimer]
   * @param {(record:object) => void} [deps.persistOp]
   * @param {(op:object) => void} [deps.emit] 广播本地产生的 op
   * @param {(timerId:string, haveVersion:number) => void} [deps.requestSync] 检测到版本空洞时回调
   */
  constructor({ tabId, tabName, now, persistTimer, persistOp, emit, requestSync }) {
    this.tabId = tabId;
    this.tabName = tabName;
    this.now = now;
    this.persistTimer = persistTimer || (() => {});
    this.persistOp = persistOp || (() => {});
    this.emit = emit || (() => {});
    this.requestSync = requestSync || (() => {});
    this.timers = new Map();   // id -> timer
    this.seenOps = new Set();  // 已处理的 opId（幂等）
    this.opCounter = 0;
    this.onChange = () => {};
  }

  remaining(timer, now = this.now()) {
    if (timer.status !== STATUS.RUNNING) return Math.max(0, timer.baseRemainingMs);
    return Math.max(0, timer.baseRemainingMs - (now - timer.anchorWall));
  }

  getTimer(id) {
    return this.timers.get(id) || null;
  }

  listTimers() {
    return [...this.timers.values()].filter((t) => !t.deleted);
  }

  // 状态迁移：返回下一个状态；非法迁移返回 null
  transition(cur, type, payload = {}) {
    const now = this.now();
    const t = { ...cur };
    switch (type) {
      case OP.CREATE:
        t.name = payload.name || t.name;
        t.durationMs = payload.durationMs ?? t.durationMs;
        t.baseRemainingMs = t.durationMs;
        t.status = STATUS.IDLE;
        t.anchorWall = 0;
        break;
      case OP.CONFIGURE:
        if (t.status === STATUS.RUNNING) return null; // 运行中不允许改时长
        if (payload.name !== undefined) t.name = payload.name;
        if (payload.durationMs !== undefined) {
          t.durationMs = payload.durationMs;
          t.baseRemainingMs = payload.durationMs;
          t.status = STATUS.IDLE;
          t.anchorWall = 0;
        }
        break;
      case OP.START:
        if (t.status === STATUS.RUNNING) return null;
        t.baseRemainingMs = t.durationMs;
        t.anchorWall = now;
        t.status = STATUS.RUNNING;
        break;
      case OP.PAUSE:
        if (t.status !== STATUS.RUNNING) return null;
        t.baseRemainingMs = this.remaining(cur, now);
        t.anchorWall = now;
        t.status = STATUS.PAUSED;
        break;
      case OP.RESUME:
        if (t.status !== STATUS.PAUSED) return null;
        t.anchorWall = now;
        t.status = STATUS.RUNNING;
        break;
      case OP.RESET:
        t.baseRemainingMs = t.durationMs;
        t.anchorWall = 0;
        t.status = STATUS.IDLE;
        break;
      case OP.EXPIRE:
        if (t.status !== STATUS.RUNNING) return null;
        t.baseRemainingMs = 0;
        t.anchorWall = now;
        t.status = STATUS.DONE;
        break;
      case OP.DELETE:
        t.deleted = true;
        t.status = STATUS.IDLE;
        t.anchorWall = 0;
        break;
      default:
        return null;
    }
    return t;
  }

  // 本地发起一个操作：迁移状态、加版本、持久化、广播
  doOp(timerId, type, payload = {}) {
    let cur = this.timers.get(timerId);
    if (!cur) {
      if (type !== OP.CREATE) return null;
      cur = makeTimer(timerId);
    }
    if (cur.deleted && type !== OP.DELETE) return null;
    const next = this.transition(cur, type, payload);
    if (!next) return null;
    next.version = cur.version + 1;
    next.lastTabId = this.tabId;
    const op = {
      kind: 'op',
      opId: `${this.tabId}:${++this.opCounter}`,
      timerId,
      type,
      payload,
      state: { ...next },
      version: next.version,
      tabId: this.tabId,
      tabName: this.tabName,
      wall: Date.now(),
    };
    this._commit(next, op, false);
    this.emit(op);
    return op;
  }

  // 收到远端 op：幂等、乱序安全、并发决胜
  receiveOp(op) {
    if (!op || op.kind !== 'op' || this.seenOps.has(op.opId)) return { applied: false, dup: true };
    this.seenOps.add(op.opId);

    const cur = this.timers.get(op.timerId);
    const incoming = { ...op.state, id: op.timerId };

    if (!cur) {
      // 首次见到该计时器（例如错过 create，直接从快照学习）
      this._commit(incoming, op, false);
      return { applied: true };
    }

    const gap = op.version > cur.version + 1;
    const newer = isNewer(op.version, op.tabId, cur.version, cur.lastTabId);

    if (newer) {
      this._commit(incoming, op, false);
    } else {
      // 过期 op：不改动状态，但仍记入历史（标记 stale），保证历史完整可查
      this._recordOp(op, true);
    }
    if (gap) this.requestSync(op.timerId, cur.version);
    return { applied: newer, stale: !newer };
  }

  // 启动时用 IndexedDB 中的快照 + op 日志重放，确定性收敛
  boot(timerRows, opRows) {
    for (const row of timerRows || []) {
      this.timers.set(row.id, { ...row });
    }
    const ops = [...(opRows || [])].sort((a, b) => {
      if (a.version !== b.version) return a.version - b.version;
      if (a.tabId !== b.tabId) return a.tabId < b.tabId ? -1 : 1;
      return a.opId < b.opId ? -1 : 1;
    });
    for (const op of ops) {
      if (this.seenOps.has(op.opId)) continue;
      this.seenOps.add(op.opId);
      if (!this._opsByTimer) this._opsByTimer = new Map();
      if (!this._opsByTimer.has(op.timerId)) this._opsByTimer.set(op.timerId, []);
      this._opsByTimer.get(op.timerId).push(op);
      const cur = this.timers.get(op.timerId);
      const incoming = { ...op.state, id: op.timerId };
      if (!cur || isNewer(incoming.version, incoming.lastTabId, cur.version, cur.lastTabId)) {
        this.timers.set(op.timerId, incoming);
      }
    }
  }

  // 响应对端的 sync-request：导出全量 op（对端幂等合并）
  exportOps() {
    const ops = [];
    for (const timer of this.timers.values()) ops.push(...(this._opsByTimer?.get(timer.id) || []));
    return ops;
  }

  _commit(timerState, op, stale) {
    this.timers.set(timerState.id, { ...timerState });
    this.persistTimer({ ...timerState });
    this._recordOp(op, stale);
    this.onChange();
  }

  _recordOp(op, stale) {
    // 持久化完整 op（含状态快照），刷新/离线后可直接重放恢复
    const record = { ...op, stale: !!stale };
    if (!this._opsByTimer) this._opsByTimer = new Map();
    if (!this._opsByTimer.has(op.timerId)) this._opsByTimer.set(op.timerId, []);
    this._opsByTimer.get(op.timerId).push(record);
    this.persistOp(record);
  }

  history(timerId) {
    const list = this._opsByTimer?.get(timerId) || [];
    return [...list].sort((a, b) => (a.wall - b.wall) || (a.version - b.version));
  }
}
