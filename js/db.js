/* IndexedDB 轻量封装：持久化倒计时状态与操作历史 */
(function (global) {
  'use strict';

  var DB_NAME = 'multi-tab-countdown';
  var DB_VERSION = 1;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('timers')) {
          db.createObjectStore('timers', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('history')) {
          var store = db.createObjectStore('history', { keyPath: 'key' });
          store.createIndex('byTimer', 'timerId', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function withStore(name, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, mode);
        var store = tx.objectStore(name);
        var result = fn(store);
        tx.oncomplete = function () { resolve(result && result._value); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function reqToPromise(req, store) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var TimerDB = {
    /* 状态读取/写入（put 幂等，同 key 覆盖） */
    putTimer: function (state) {
      return withStore('timers', 'readwrite', function (s) { s.put(state); });
    },
    getAllTimers: function () {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('timers', 'readonly');
          var req = tx.objectStore('timers').getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        });
      });
    },
    deleteTimer: function (id) {
      return withStore('timers', 'readwrite', function (s) { s.delete(id); });
    },

    /* 历史：key 由写入方标签页生成，全局唯一，合并时天然去重 */
    putHistory: function (entry) {
      return withStore('history', 'readwrite', function (s) { s.put(entry); });
    },
    getHistory: function (timerId) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('history', 'readonly');
          var req = tx.objectStore('history').index('byTimer').getAll(timerId);
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        });
      });
    },
    clearHistory: function (timerId) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('history', 'readwrite');
          var store = tx.objectStore('history');
          var req = store.index('byTimer').getAllKeys(timerId);
          req.onsuccess = function () {
            (req.result || []).forEach(function (k) { store.delete(k); });
          };
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }
  };

  global.TimerDB = TimerDB;
})(window);
