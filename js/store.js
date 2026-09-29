/*
 * TimerStore：倒计时状态机 + 多标签页同步
 *
 * 同步模型：
 * - 每个倒计时状态携带 (version, lastWriter)。version 为 Lamport 时钟，
 *   lastWriter 为标签页 id，二者构成全序，所有标签页按同一规则收敛。
 * - 运行中的倒计时用「绝对纪元截止时间 deadline」表示，剩余时间永远按
 *   deadline - Date.now() 现算，不做递减计数。因此：
 *     · 后台节流（rAF/setInterval 被暂停）不会造成误差；
 *     · 标签页关闭后重开，只要时钟未变，剩余时间依然正确；
 *     · 消息乱序/延迟只会被版本比较丢弃，不会引起时间跳变。
 */
(function (global) {
  'use strict';

  var CHANNEL_NAME = 'multi-tab-countdown-v1';
  var HEARTBEAT_INTERVAL = 2000;
  var PEER_TIMEOUT = 6000;

  function compareVersion(v1, w1, v2, w2) {
    if (v1 !== v2) return v1 - v2;
    return w1 < w2 ? -1 : (w1 > w2 ? 1 : 0);
  }

  function TimerStore(tabId) {
    this.tabId = tabId;
    this.timers = new Map();      // id -> state
    this.peers = new Map();       // tabId -> { lastSeen, lastAction }
    this.lamport = 0;
    this.historyCache = new Map(); // timerId -> [entries]
    this.listeners = { state: [], peers: [], history: [] };
    this.channel = null;
    this.lastAction = '启动';
    this._histSeq = 0;
  }

  TimerStore.prototype.on = function (event, fn) {
    this.listeners[event].push(fn);
  };

  TimerStore.prototype._emit = function (event, payload) {
    this.listeners[event].forEach(function (fn) { fn(payload); });
  };

  /* ---------- 生命周期 ---------- */

  TimerStore.prototype.start = function () {
    var self = this;

    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = function (e) { self._onMessage(e.data); };

    return TimerDB.getAllTimers().then(function (states) {
      // 离线恢复：以 IndexedDB 中已持久化的最新版本为基线
      states.forEach(function (s) {
        self.timers.set(s.id, s);
        self.lamport = Math.max(self.lamport, s.version || 0);
      });
      self._emit('state');

      // 向其他标签页请求全量同步，合并自己离线期间错过的操作
      self._post({ type: 'hello', tabId: self.tabId });

      self._hbTimer = setInterval(function () { self._heartbeat(); }, HEARTBEAT_INTERVAL);
      self._heartbeat();

      // 前台恢复时主动再同步一次，兜底任何错过的消息
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
          self._post({ type: 'hello', tabId: self.tabId });
          self._heartbeat();
        }
      });
    });
  };

  /* ---------- 消息收发 ---------- */

  TimerStore.prototype._post = function (msg) {
    try { this.channel.postMessage(msg); } catch (e) { /* 序列化失败忽略 */ }
  };

  TimerStore.prototype._heartbeat = function () {
    this._post({
      type: 'hb',
      tabId: this.tabId,
      lastAction: this.lastAction,
      at: Date.now()
    });
    this._prunePeers();
  };

  TimerStore.prototype._prunePeers = function () {
    var now = Date.now(), changed = false, self = this;
    this.peers.forEach(function (p, id) {
      if (now - p.lastSeen > PEER_TIMEOUT) { self.peers.delete(id); changed = true; }
    });
    if (changed) this._emit('peers');
  };

  TimerStore.prototype._onMessage = function (msg) {
    if (!msg || msg.tabId === this.tabId) return;

    switch (msg.type) {
      case 'hello':
        // 新标签页（或前台恢复的标签页）请求全量状态
        this._post({ type: 'full', tabId: this.tabId, to: msg.tabId, timers: this._serializeTimers() });
        this._notePeer(msg);
        break;
      case 'full':
        if (msg.to !== this.tabId) { this._notePeer(msg); break; }
        (msg.timers || []).forEach(this._applyRemoteState, this);
        this._notePeer(msg);
        break;
      case 'op':
        this._applyRemoteState(msg.state);
        this._notePeer(msg);
        break;
      case 'history':
        // 其他标签页代为持久化历史，key 相同，put 幂等
        TimerDB.putHistory(msg.entry);
        this._addHistoryToCache(msg.entry);
        this._notePeer(msg);
        break;
      case 'hb':
        this._notePeer(msg);
        break;
    }
  };

  TimerStore.prototype._notePeer = function (msg) {
    if (!msg.tabId || msg.tabId === this.tabId) return;
    var existing = this.peers.get(msg.tabId);
    this.peers.set(msg.tabId, {
      lastSeen: Date.now(),
      lastAction: msg.lastAction || (existing && existing.lastAction) || '在线'
    });
    this._emit('peers');
  };

  TimerStore.prototype._serializeTimers = function () {
    var out = [];
    this.timers.forEach(function (t) { out.push(t); });
    return out;
  };

  /* ---------- 合并规则（LWW：version 大者胜，并列时 tabId 字典序大者胜） ---------- */

  TimerStore.prototype._applyRemoteState = function (state) {
    if (!state || !state.id) return;
    this.lamport = Math.max(this.lamport, state.version || 0);
    var local = this.timers.get(state.id);
    if (!local || compareVersion(state.version, state.lastWriter, local.version, local.lastWriter) > 0) {
      this.timers.set(state.id, state);
      TimerDB.putTimer(state);
      this._emit('state');
    }
  };

  /* ---------- 本地操作 ---------- */

  TimerStore.prototype._mutate = function (id, opLabel, fn) {
    var t = this.timers.get(id);
    if (!t) return;
    this.lamport = Math.max(this.lamport, t.version || 0) + 1;
    fn(t);
    t.version = this.lamport;
    t.lastWriter = this.tabId;
    t.updatedAt = Date.now();
    TimerDB.putTimer(t);
    this._post({ type: 'op', tabId: this.tabId, state: t, lastAction: opLabel });
    this.lastAction = opLabel;
    this._recordHistory(t, opLabel);
    this._emit('state');
  };

  TimerStore.prototype.createTimer = function (name, durationMs) {
    var id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    this.lamport += 1;
    var state = {
      id: id,
      name: name || '倒计时',
      durationMs: durationMs,
      running: false,
      remainingMs: durationMs,
      deadline: null,
      deleted: false,
      version: this.lamport,
      lastWriter: this.tabId,
      updatedAt: Date.now()
    };
    this.timers.set(id, state);
    TimerDB.putTimer(state);
    this._post({ type: 'op', tabId: this.tabId, state: state, lastAction: '创建「' + state.name + '」' });
    this.lastAction = '创建「' + state.name + '」';
    this._recordHistory(state, '创建（时长 ' + formatDuration(durationMs) + '）');
    this._emit('state');
    return id;
  };

  TimerStore.prototype.startTimer = function (id) {
    this._mutate(id, '开始', function (t) {
      if (t.running || t.remainingMs <= 0) return;
      t.running = true;
      t.deadline = Date.now() + t.remainingMs;
    });
  };

  TimerStore.prototype.pauseTimer = function (id) {
    this._mutate(id, '暂停', function (t) {
      if (!t.running) return;
      t.remainingMs = Math.max(0, t.deadline - Date.now());
      t.running = false;
      t.deadline = null;
    });
  };

  TimerStore.prototype.resetTimer = function (id) {
    this._mutate(id, '重置', function (t) {
      t.running = false;
      t.deadline = null;
      t.remainingMs = t.durationMs;
    });
  };

  TimerStore.prototype.deleteTimer = function (id) {
    this._mutate(id, '删除', function (t) {
      t.deleted = true; // 墓碑：防止旧的全量同步把它复活
      t.running = false;
      t.deadline = null;
    });
  };

  /* ---------- 历史 ---------- */

  TimerStore.prototype._recordHistory = function (state, opLabel) {
    this._histSeq += 1;
    var entry = {
      key: this.tabId + ':' + Date.now().toString(36) + ':' + this._histSeq,
      timerId: state.id,
      tabId: this.tabId,
      op: opLabel,
      at: Date.now(),
      remainingMs: remainingOf(state),
      version: state.version
    };
    TimerDB.putHistory(entry);
    this._post({ type: 'history', tabId: this.tabId, entry: entry });
    this._addHistoryToCache(entry);
  };

  TimerStore.prototype._addHistoryToCache = function (entry) {
    var list = this.historyCache.get(entry.timerId);
    if (!list) { list = []; this.historyCache.set(entry.timerId, list); }
    if (!list.some(function (e) { return e.key === entry.key; })) {
      list.push(entry);
      list.sort(function (a, b) { return b.at - a.at; });
    }
    this._emit('history', entry.timerId);
  };

  TimerStore.prototype.loadHistory = function (timerId) {
    var self = this;
    return TimerDB.getHistory(timerId).then(function (entries) {
      entries.forEach(function (e) {
        var list = self.historyCache.get(timerId);
        if (!list) { list = []; self.historyCache.set(timerId, list); }
        if (!list.some(function (x) { return x.key === e.key; })) list.push(e);
      });
      var list = self.historyCache.get(timerId) || [];
      list.sort(function (a, b) { return b.at - a.at; });
      self._emit('history', timerId);
      return list;
    });
  };

  /* ---------- 查询 ---------- */

  function remainingOf(t) {
    if (t.running && t.deadline != null) {
      return Math.max(0, t.deadline - Date.now());
    }
    return t.remainingMs;
  }

  function formatDuration(ms) {
    var s = Math.round(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var parts = [];
    if (h) parts.push(h + ' 小时');
    if (m) parts.push(m + ' 分');
    if (sec || !parts.length) parts.push(sec + ' 秒');
    return parts.join(' ');
  }

  TimerStore.prototype.remainingOf = remainingOf;
  TimerStore.prototype.getPeers = function () {
    var out = [];
    this.peers.forEach(function (p, id) { out.push({ tabId: id, lastAction: p.lastAction, lastSeen: p.lastSeen }); });
    return out;
  };

  global.TimerStore = TimerStore;
  global.TimerFormat = { formatDuration: formatDuration };
})(window);
