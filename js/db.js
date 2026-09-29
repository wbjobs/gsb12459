// IndexedDB 持久化：timers 存状态快照，ops 存完整操作日志（含快照，可重放）。
const DB_NAME = 'sync-countdown-db';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('timers')) {
        db.createObjectStore('timers', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('ops')) {
        const ops = db.createObjectStore('ops', { keyPath: 'opId' });
        ops.createIndex('byTimer', 'timerId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function putTimer(db, timer) {
  return wrap(db.transaction('timers', 'readwrite').objectStore('timers').put(timer));
}

export function deleteTimerRow(db, id) {
  return wrap(db.transaction('timers', 'readwrite').objectStore('timers').delete(id));
}

export function getAllTimers(db) {
  return wrap(db.transaction('timers').objectStore('timers').getAll());
}

export function putOp(db, op) {
  return wrap(db.transaction('ops', 'readwrite').objectStore('ops').put(op));
}

export function getAllOps(db) {
  return wrap(db.transaction('ops').objectStore('ops').getAll());
}
