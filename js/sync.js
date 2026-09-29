// BroadcastChannel 通信层：op 广播、在线状态心跳、时钟采样、缺漏补同步。
export const CHANNEL_NAME = 'sync-countdown-v1';
const PEER_TIMEOUT_MS = 6000;
const HEARTBEAT_MS = 2000;

export class SyncBus {
  /**
   * @param {object} deps
   * @param {string} deps.tabId
   * @param {() => string} deps.getTabName
   * @param {(sample:number) => void} deps.onClockSample 收到任何消息时的时钟偏移采样
   * @param {(op:object) => void} deps.onOp
   * @param {(req:object) => void} deps.onSyncRequest 对端请求全量数据
   * @param {(ops:object[]) => void} deps.onSyncState 收到对端全量 op
   * @param {(peers:object[]) => void} deps.onPeers 在线标签页列表变化
   * @param {() => string} deps.getLastAction 本标签页最近一次操作描述
   */
  constructor({ tabId, getTabName, onClockSample, onOp, onSyncRequest, onSyncState, onPeers, getLastAction }) {
    this.tabId = tabId;
    this.getTabName = getTabName;
    this.onClockSample = onClockSample;
    this.onOp = onOp;
    this.onSyncRequest = onSyncRequest;
    this.onSyncState = onSyncState;
    this.onPeers = onPeers;
    this.getLastAction = getLastAction;
    this.peers = new Map(); // tabId -> { tabId, tabName, lastAction, lastSeen, online }
    this.channel = null;
    this.timer = null;
  }

  start() {
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (e) => this._handle(e.data);
    this.timer = setInterval(() => {
      this._sendPresence();
      this._prunePeers();
    }, HEARTBEAT_MS);
    this._sendPresence();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this._post({ kind: 'bye' });
      });
    }
  }

  broadcastOp(op) {
    this._post({ ...op, kind: 'op' });
  }

  requestSync() {
    this._post({ kind: 'sync-request' });
  }

  sendSyncState(ops, toTabId) {
    this._post({ kind: 'sync-state', ops, toTabId });
  }

  _post(msg) {
    msg.tabId = this.tabId;
    msg.tabName = this.getTabName();
    msg.sentWall = Date.now();
    try {
      this.channel.postMessage(msg);
    } catch (err) {
      console.warn('广播失败', err);
    }
  }

  _sendPresence() {
    this._post({ kind: 'presence', lastAction: this.getLastAction() });
  }

  _handle(msg) {
    if (!msg || msg.tabId === this.tabId) return;
    // 任何消息都携带发送方墙钟，用于估计时钟偏移（同机传输延迟可忽略）
    if (Number.isFinite(msg.sentWall)) {
      this.onClockSample(msg.sentWall - Date.now());
    }
    switch (msg.kind) {
      case 'op':
        this._touchPeer(msg);
        this.onOp(msg);
        break;
      case 'presence':
        this._touchPeer(msg);
        break;
      case 'bye': {
        const peer = this.peers.get(msg.tabId);
        if (peer) {
          peer.online = false;
          peer.lastSeen = Date.now();
          this.onPeers(this._peerList());
        }
        break;
      }
      case 'sync-request':
        this._touchPeer(msg);
        this.onSyncRequest(msg);
        break;
      case 'sync-state':
        if (msg.toTabId && msg.toTabId !== this.tabId) return;
        this._touchPeer(msg);
        this.onSyncState(msg.ops || []);
        break;
      default:
        break;
    }
  }

  _touchPeer(msg) {
    const prev = this.peers.get(msg.tabId);
    this.peers.set(msg.tabId, {
      tabId: msg.tabId,
      tabName: msg.tabName || msg.tabId,
      lastAction: msg.lastAction !== undefined ? msg.lastAction : (prev ? prev.lastAction : ''),
      lastSeen: Date.now(),
      online: true,
    });
    this.onPeers(this._peerList());
  }

  _prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const peer of this.peers.values()) {
      if (peer.online && now - peer.lastSeen > PEER_TIMEOUT_MS) {
        peer.online = false;
        changed = true;
      }
    }
    if (changed) this.onPeers(this._peerList());
  }

  _peerList() {
    return [...this.peers.values()].sort((a, b) => a.tabId.localeCompare(b.tabId));
  }
}
