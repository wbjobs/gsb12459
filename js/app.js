import { Engine, OP, OP_LABELS, STATUS } from './engine.js';
import { ClockSync } from './clock.js';
import { SyncBus } from './sync.js';
import { openDB, putTimer, getAllTimers, putOp, getAllOps } from './db.js';

const STATUS_LABELS = {
  [STATUS.IDLE]: '就绪',
  [STATUS.RUNNING]: '运行中',
  [STATUS.PAUSED]: '已暂停',
  [STATUS.DONE]: '到时',
};

// ---------- 标签页身份（sessionStorage 每个标签页独立） ----------
function loadIdentity() {
  let tabId = sessionStorage.getItem('sc-tab-id');
  if (!tabId) {
    tabId = 'tab-' + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem('sc-tab-id', tabId);
  }
  let tabName = sessionStorage.getItem('sc-tab-name');
  if (!tabName) {
    tabName = '标签页 ' + tabId.slice(-4).toUpperCase();
    sessionStorage.setItem('sc-tab-name', tabName);
  }
  return { tabId, tabName };
}

const { tabId, tabName } = loadIdentity();
let lastAction = '（暂无操作）';

// ---------- 初始化 ----------
const clock = new ClockSync();
let engine;
let bus;
let db;

const timersEl = document.getElementById('timers');
const peersEl = document.getElementById('peers');
const emptyEl = document.getElementById('empty');

async function init() {
  db = await openDB();

  engine = new Engine({
    tabId,
    tabName,
    now: () => clock.now(),
    persistTimer: (t) => putTimer(db, t).catch(console.error),
    persistOp: (op) => putOp(db, op).catch(console.error),
    emit: (op) => bus.broadcastOp(op),
    requestSync: () => bus.requestSync(),
  });
  engine.onChange = render;

  // 1) 先从 IndexedDB 重放（覆盖刷新 / 标签页关闭后重开）
  const [timerRows, opRows] = await Promise.all([getAllTimers(db), getAllOps(db)]);
  engine.boot(timerRows, opRows);

  bus = new SyncBus({
    tabId,
    getTabName: () => nameInput.value.trim() || tabName,
    getLastAction: () => lastAction,
    onClockSample: (s) => clock.addSample(s),
    onOp: (op) => engine.receiveOp(op),
    onSyncRequest: (req) => {
      const ops = engine.exportOps();
      if (ops.length) bus.sendSyncState(ops, req.tabId);
    },
    onSyncState: (ops) => {
      // 2) 离线期间错过的操作：幂等合并，乱序安全
      for (const op of ops) engine.receiveOp(op);
      render();
    },
    onPeers: renderPeers,
  });
  bus.start();
  // 启动后向其他标签页要一次全量，合并离线期间的变更
  bus.requestSync();

  render();
  requestAnimationFrame(tick);
}

// ---------- 操作入口 ----------
function doOp(timerId, type, payload) {
  const op = engine.doOp(timerId, type, payload);
  if (op) {
    const t = engine.getTimer(timerId);
    lastAction = `${OP_LABELS[type]}「${t ? t.name : timerId}」 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  }
  return op;
}

// ---------- 渲染 ----------
function fmtTime(ms) {
  const neg = ms < 0;
  const abs = Math.abs(ms);
  const cs = Math.floor((abs % 1000) / 10);
  const totalSec = Math.floor(abs / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hr = Math.floor(totalSec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  const core = hr > 0 ? `${pad(hr)}:${pad(min)}:${pad(sec)}` : `${pad(min)}:${pad(sec)}`;
  return `${neg ? '-' : ''}${core}.${pad(cs)}`;
}

function fmtWall(wall) {
  return new Date(wall).toLocaleTimeString('zh-CN', { hour12: false });
}

function render() {
  const timers = engine.listTimers();
  emptyEl.hidden = timers.length > 0;
  timersEl.innerHTML = '';
  for (const t of timers) {
    timersEl.appendChild(renderTimerCard(t));
  }
}

function renderTimerCard(t) {
  const card = document.createElement('section');
  card.className = 'timer-card';
  card.dataset.timerId = t.id;
  card.dataset.status = t.status;

  const remaining = engine.remaining(t);
  const progress = t.durationMs > 0 ? Math.min(1, Math.max(0, remaining / t.durationMs)) : 0;

  card.innerHTML = `
    <header class="timer-head">
      <h3 class="timer-name" title="双击重命名"></h3>
      <span class="badge">${STATUS_LABELS[t.status]}</span>
    </header>
    <div class="time" role="timer">${fmtTime(remaining)}</div>
    <div class="progress"><div class="progress-bar" style="width:${(progress * 100).toFixed(2)}%"></div></div>
    <div class="config">
      <label>时长
        <input class="dur-min" type="number" min="0" max="999" value="${Math.floor(t.durationMs / 60000)}"> 分
        <input class="dur-sec" type="number" min="0" max="59" value="${Math.floor((t.durationMs % 60000) / 1000)}"> 秒
      </label>
      <button class="btn set-duration" ${t.status === STATUS.RUNNING ? 'disabled' : ''}>设置</button>
    </div>
    <div class="controls">
      <button class="btn primary act-start" ${t.status === STATUS.IDLE || t.status === STATUS.DONE ? '' : 'disabled'}>开始</button>
      <button class="btn act-pause" ${t.status === STATUS.RUNNING ? '' : 'disabled'}>暂停</button>
      <button class="btn act-resume" ${t.status === STATUS.PAUSED ? '' : 'disabled'}>继续</button>
      <button class="btn act-reset">重置</button>
      <button class="btn danger act-delete">删除</button>
    </div>
    <details class="history">
      <summary>操作历史（${engine.history(t.id).length}）</summary>
      <ul class="history-list"></ul>
    </details>
  `;

  card.querySelector('.timer-name').textContent = t.name;
  card.querySelector('.timer-name').addEventListener('dblclick', () => {
    const name = prompt('重命名倒计时', t.name);
    if (name && name.trim()) doOp(t.id, OP.CONFIGURE, { name: name.trim() });
  });

  card.querySelector('.set-duration').addEventListener('click', () => {
    const min = Math.max(0, Number(card.querySelector('.dur-min').value) || 0);
    const sec = Math.max(0, Number(card.querySelector('.dur-sec').value) || 0);
    const durationMs = (min * 60 + sec) * 1000;
    if (durationMs > 0) doOp(t.id, OP.CONFIGURE, { durationMs });
  });

  card.querySelector('.act-start').addEventListener('click', () => doOp(t.id, OP.START));
  card.querySelector('.act-pause').addEventListener('click', () => doOp(t.id, OP.PAUSE));
  card.querySelector('.act-resume').addEventListener('click', () => doOp(t.id, OP.RESUME));
  card.querySelector('.act-reset').addEventListener('click', () => doOp(t.id, OP.RESET));
  card.querySelector('.act-delete').addEventListener('click', () => {
    if (confirm(`删除「${t.name}」？所有标签页将同步删除。`)) doOp(t.id, OP.DELETE);
  });

  const historyList = card.querySelector('.history-list');
  for (const rec of engine.history(t.id).slice(-50).reverse()) {
    const li = document.createElement('li');
    li.className = rec.stale ? 'stale' : '';
    li.textContent = `${fmtWall(rec.wall)}  [${rec.tabName || rec.tabId}] ${OP_LABELS[rec.type] || rec.type} (v${rec.version})${rec.stale ? ' · 乱序已忽略' : ''}`;
    historyList.appendChild(li);
  }

  return card;
}

function renderPeers(peers) {
  const rows = [
    { tabName: nameInput.value.trim() || tabName, tabId, lastAction, online: true, self: true },
    ...peers,
  ];
  peersEl.innerHTML = '';
  for (const p of rows) {
    const li = document.createElement('li');
    li.className = p.online ? 'peer online' : 'peer offline';
    li.innerHTML = `
      <span class="dot"></span>
      <span class="peer-name"></span>
      <span class="peer-status">${p.self ? '本标签页' : p.online ? '在线' : '已离线'}</span>
      <span class="peer-action"></span>
    `;
    li.querySelector('.peer-name').textContent = p.tabName + (p.self ? '' : ` (${p.tabId.slice(-4)})`);
    li.querySelector('.peer-action').textContent = p.lastAction || '';
    peersEl.appendChild(li);
  }
}

// ---------- 帧循环：显示用 performance.now 单调时钟插值，后台节流恢复后不跳变 ----------
let lastFrameWall = 0;
let lastFramePerf = 0;

function smoothNow() {
  const wall = clock.now();
  const perf = performance.now();
  // 用 performance.now() 的单调增量修正两次帧之间的墙钟，避免本机墙钟回调造成显示抖动
  if (lastFramePerf && perf - lastFramePerf < 1000) {
    const est = lastFrameWall + (perf - lastFramePerf);
    lastFrameWall = Math.abs(est - wall) < 250 ? est : wall;
  } else {
    lastFrameWall = wall;
  }
  lastFramePerf = perf;
  return lastFrameWall;
}

function tick() {
  const now = smoothNow();
  for (const card of timersEl.children) {
    const t = engine.getTimer(card.dataset.timerId);
    if (!t) continue;
    const remaining = engine.remaining(t, now);
    card.querySelector('.time').textContent = fmtTime(remaining);
    const progress = t.durationMs > 0 ? Math.min(1, Math.max(0, remaining / t.durationMs)) : 0;
    card.querySelector('.progress-bar').style.width = `${(progress * 100).toFixed(2)}%`;
    // 运行中的计时到 0：本标签页发起 expire（多标签页并发发起时按版本决胜收敛）
    if (t.status === STATUS.RUNNING && remaining <= 0) {
      doOp(t.id, OP.EXPIRE);
    }
  }
  requestAnimationFrame(tick);
}

// ---------- 顶部表单 ----------
const nameInput = document.getElementById('tab-name');
nameInput.value = tabName;
nameInput.addEventListener('change', () => {
  sessionStorage.setItem('sc-tab-name', nameInput.value.trim() || tabName);
  renderPeers(bus ? [] : []);
});

document.getElementById('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('new-name').value.trim() || '倒计时';
  const min = Math.max(0, Number(document.getElementById('new-min').value) || 0);
  const sec = Math.max(0, Number(document.getElementById('new-sec').value) || 0);
  const durationMs = (min * 60 + sec) * 1000;
  if (durationMs <= 0) return;
  const id = 'timer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  doOp(id, OP.CREATE, { name, durationMs });
  document.getElementById('new-name').value = '';
});

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<p class="fatal">初始化失败：${err.message}</p>`);
});
