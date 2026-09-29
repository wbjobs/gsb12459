/* UI 层：渲染倒计时列表、标签页状态、操作历史 */
(function () {
  'use strict';

  var tabId = (function () {
    var rand = Math.random().toString(36).slice(2, 6);
    var stored = null;
    try {
      // sessionStorage：同一标签页刷新后 id 不变，新标签页生成新 id
      stored = sessionStorage.getItem('countdown-tab-id');
      if (!stored) {
        stored = rand + Date.now().toString(36);
        sessionStorage.setItem('countdown-tab-id', stored);
      }
    } catch (e) {
      stored = rand + Date.now().toString(36);
    }
    return stored;
  })();

  var store = new TimerStore(tabId);
  var openHistory = new Set(); // 展开了历史面板的 timerId

  /* ---------- 工具 ---------- */

  function $(sel) { return document.querySelector(sel); }

  function pad(n, len) {
    var s = String(n);
    while (s.length < len) s = '0' + s;
    return s;
  }

  function fmtClock(ms) {
    ms = Math.max(0, ms);
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var cs = Math.floor((ms % 1000) / 10);
    return (h > 0 ? pad(h, 2) + ':' : '') + pad(m, 2) + ':' + pad(s, 2) + '.' + pad(cs, 2);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
  }

  function statusOf(t) {
    var remaining = store.remainingOf(t);
    if (t.running && remaining > 0) return { key: 'running', label: '运行中' };
    if (remaining <= 0) return { key: 'done', label: '已完成' };
    if (!t.running && remaining < t.durationMs) return { key: 'paused', label: '已暂停' };
    return { key: 'idle', label: '待开始' };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 渲染：标签页状态 ---------- */

  function renderPeers() {
    var box = $('#peer-list');
    var peers = store.getPeers();
    var html = '<li class="peer self"><span class="dot"></span>本标签页 <code>' + esc(tabId.slice(0, 6)) + '</code><span class="peer-action">' + esc(store.lastAction) + '</span></li>';
    peers.forEach(function (p) {
      html += '<li class="peer"><span class="dot"></span>标签页 <code>' + esc(p.tabId.slice(0, 6)) + '</code><span class="peer-action">' + esc(p.lastAction) + '</span></li>';
    });
    box.innerHTML = html;
    $('#peer-count').textContent = String(peers.length + 1);
  }

  /* ---------- 渲染：倒计时卡片 ---------- */

  function renderTimers() {
    var list = $('#timer-list');
    var timers = [];
    store.timers.forEach(function (t) { if (!t.deleted) timers.push(t); });
    timers.sort(function (a, b) { return a.id < b.id ? -1 : 1; });

    if (!timers.length) {
      list.innerHTML = '<p class="empty">还没有倒计时，先在上方创建一个。</p>';
      return;
    }

    list.innerHTML = timers.map(function (t) {
      var st = statusOf(t);
      var histOpen = openHistory.has(t.id);
      return '' +
        '<article class="timer-card status-' + st.key + '" data-id="' + esc(t.id) + '">' +
          '<header>' +
            '<h3>' + esc(t.name) + '</h3>' +
            '<span class="badge badge-' + st.key + '">' + st.label + '</span>' +
          '</header>' +
          '<div class="clock" data-clock="' + esc(t.id) + '">' + fmtClock(store.remainingOf(t)) + '</div>' +
          '<div class="progress"><div class="progress-fill" data-progress="' + esc(t.id) + '"></div></div>' +
          '<div class="actions">' +
            '<button data-op="start" ' + (t.running ? 'disabled' : '') + '>' + (statusOf(t).key === 'paused' ? '继续' : '开始') + '</button>' +
            '<button data-op="pause" ' + (!t.running ? 'disabled' : '') + '>暂停</button>' +
            '<button data-op="reset">重置</button>' +
            '<button data-op="history" class="ghost">' + (histOpen ? '收起历史' : '操作历史') + '</button>' +
            '<button data-op="delete" class="danger">删除</button>' +
          '</div>' +
          '<div class="meta">时长 ' + esc(TimerFormat.formatDuration(t.durationMs)) +
            ' · 版本 v' + t.version + ' · 最后操作标签页 <code>' + esc(String(t.lastWriter).slice(0, 6)) + '</code></div>' +
          '<div class="history" data-history="' + esc(t.id) + '" style="display:' + (histOpen ? 'block' : 'none') + '"></div>' +
        '</article>';
    }).join('');

    timers.forEach(function (t) {
      if (openHistory.has(t.id)) renderHistory(t.id);
    });
  }

  function renderHistory(timerId) {
    var box = document.querySelector('[data-history="' + timerId + '"]');
    if (!box) return;
    var entries = store.historyCache.get(timerId) || [];
    if (!entries.length) {
      box.innerHTML = '<p class="empty">暂无历史记录</p>';
      return;
    }
    box.innerHTML = '<table><thead><tr><th>时间</th><th>标签页</th><th>操作</th><th>剩余</th></tr></thead><tbody>' +
      entries.slice(0, 50).map(function (e) {
        return '<tr><td>' + fmtTime(e.at) + '</td><td><code>' + esc(e.tabId.slice(0, 6)) + '</code></td>' +
          '<td>' + esc(e.op) + '</td><td>' + fmtClock(e.remainingMs) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- 高频刷新：只更新时间与进度条 ---------- */

  function tick() {
    store.timers.forEach(function (t) {
      if (t.deleted) return;
      var remaining = store.remainingOf(t);
      var clockEl = document.querySelector('[data-clock="' + t.id + '"]');
      if (clockEl) clockEl.textContent = fmtClock(remaining);
      var fill = document.querySelector('[data-progress="' + t.id + '"]');
      if (fill) {
        var pct = t.durationMs > 0 ? (remaining / t.durationMs) * 100 : 0;
        fill.style.width = pct.toFixed(2) + '%';
      }
      // 状态可能随时间变化（运行中 -> 已完成），变化时重渲染卡片
      var card = document.querySelector('.timer-card[data-id="' + t.id + '"]');
      if (card) {
        var st = statusOf(t).key;
        if (!card.classList.contains('status-' + st)) renderTimers();
      }
    });
    requestAnimationFrame(tick);
  }

  /* ---------- 事件 ---------- */

  function bindEvents() {
    $('#create-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('#timer-name').value.trim();
      var h = parseInt($('#dur-h').value, 10) || 0;
      var m = parseInt($('#dur-m').value, 10) || 0;
      var s = parseInt($('#dur-s').value, 10) || 0;
      var durationMs = ((h * 3600) + (m * 60) + s) * 1000;
      if (durationMs <= 0) { alert('请设置大于 0 的时长'); return; }
      store.createTimer(name || '倒计时', durationMs);
      $('#timer-name').value = '';
    });

    $('#timer-list').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-op]');
      if (!btn) return;
      var card = btn.closest('.timer-card');
      var id = card.getAttribute('data-id');
      var op = btn.getAttribute('data-op');
      if (op === 'start') store.startTimer(id);
      else if (op === 'pause') store.pauseTimer(id);
      else if (op === 'reset') store.resetTimer(id);
      else if (op === 'delete') {
        if (confirm('确定删除这个倒计时？所有标签页都会同步删除。')) store.deleteTimer(id);
      } else if (op === 'history') {
        if (openHistory.has(id)) openHistory.delete(id);
        else { openHistory.add(id); store.loadHistory(id); }
        renderTimers();
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) renderTimers(); // 后台恢复立即重绘，无跳变
    });
  }

  /* ---------- 启动 ---------- */

  store.on('state', renderTimers);
  store.on('peers', renderPeers);
  store.on('history', function (timerId) {
    if (openHistory.has(timerId)) renderHistory(timerId);
  });

  store.start().then(function () {
    renderTimers();
    renderPeers();
    bindEvents();
    requestAnimationFrame(tick);
  });
})();
