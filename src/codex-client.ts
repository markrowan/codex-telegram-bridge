import WebSocket from 'ws';

export class RpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}
export interface CodexPort {
  epoch: number; connected: boolean;
  request(method: string, params: Record<string, any>): Promise<any>;
  respond(id: string | number, result: Record<string, any>, epoch: number): void;
}

// Extracted from upstream CodexClient; this client never owns the daemon process.
export class CodexClient implements CodexPort {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private connecting?: Promise<void>;
  epoch = 0;
  connected = false;
  onNotification: (message: any) => void = () => {};
  onServerRequest: (message: any) => void = () => {};
  onClose: () => void = () => {};

  constructor(readonly url: string, private readonly timeoutMs = 30000) {
    if (!url.startsWith('ws+unix://')) throw new Error('This fork requires a local ws+unix:// Codex control socket.');
  }
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const promise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: this.timeoutMs, maxPayload: 16 * 1024 * 1024 });
      this.ws = ws;
      ws.on('open', () => {
        this.epoch += 1;
        void this.request('initialize', {
          clientInfo: { name: 'codex_telegram_bridge', title: 'Codex Telegram Bridge', version: '0.2.0' },
          capabilities: { experimentalApi: true },
        }).then(() => {
          ws.send(JSON.stringify({ method: 'initialized' }));
          this.connected = true; resolve();
        }).catch(error => { reject(error); ws.terminate(); });
      });
      ws.on('message', raw => {
        let message;
        try { message = JSON.parse(String(raw)); } catch { ws.terminate(); return; }
        if (message.id !== undefined && !message.method) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new RpcError(message.error.message ?? 'Codex rejected the request', message.error.code));
          else pending.resolve(message.result);
        } else if (message.id !== undefined && message.method) this.onServerRequest(message);
        else if (message.method) this.onNotification(message);
      });
      ws.on('error', () => reject(new Error('Cannot connect to the existing Codex control socket')));
      ws.on('close', () => {
        this.connected = false;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex connection closed; delivery may be uncertain')); }
        this.pending.clear(); this.onClose(); reject(new Error('Codex disconnected'));
      });
    });
    this.connecting = promise;
    try { await promise; } finally { this.connecting = undefined; }
  }
  request(method: string, params: Record<string, any>): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex daemon is disconnected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Codex ${method} timed out; delivery may be uncertain`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(new Error('Codex write failed; delivery may be uncertain'));
      });
    });
  }
  respond(id: string | number, result: Record<string, any>, epoch: number): void {
    if (!this.connected || epoch !== this.epoch || this.ws?.readyState !== WebSocket.OPEN) throw new Error('This request belongs to a disconnected client');
    this.ws.send(JSON.stringify({ id, result }));
  }
  close(): void { this.ws?.terminate(); }
}
