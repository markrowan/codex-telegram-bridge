import { openSync, closeSync, fsyncSync, writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export type Dispatch = { state: 'received' | 'dispatching' | 'accepted' | 'done' | 'uncertain' | 'rejected'; update: any; threadId?: string; turnId?: string; operation?: string; error?: string };
export type Delivery = { text: string; state: 'queued' | 'sending' | 'sent' | 'uncertain' | 'cancelled'; messageId?: number; extra?: any };
export type RuntimeState = {
  version: 1; selected?: string; watched: string[]; owner?: { userId: string; chatId: string };
  threads: Record<string, { name: string; cwd?: string; activeTurn?: string; cursor?: string; baseline?: boolean; lastError?: string }>;
  updates: Record<string, Dispatch>; deliveries: Record<string, Delivery>; offset: number;
};

export function atomicWrite(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file); chmodSync(file, 0o600);
  const dir = openSync(dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export class Store {
  readonly data: RuntimeState;
  constructor(readonly file: string) {
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
      version: 1, watched: [], threads: {}, updates: {}, deliveries: {}, offset: 0,
    };
    if (this.data.version !== 1 || !Array.isArray(this.data.watched) || !this.data.updates || !this.data.deliveries || !this.data.threads) {
      throw new Error('Unsupported or damaged runtime journal. Restore its backup; do not reset dispatch history.');
    }
    for (const dispatch of Object.values(this.data.updates)) {
      if (dispatch.state === 'dispatching') dispatch.state = 'uncertain';
    }
    for (const [key, delivery] of Object.entries(this.data.deliveries)) {
      if (delivery.state === 'sending') delivery.state = 'uncertain';
      else if (delivery.state === 'queued' && /^(request|question):/.test(key)) delivery.state = 'cancelled';
    }
    this.save();
  }
  save(): void {
    const confirmed = Object.entries(this.data.updates).filter(([, value]) => ['done', 'accepted', 'rejected'].includes(value.state) && value.update.update_id < this.data.offset).sort((a, b) => Number(a[0]) - Number(b[0]));
    for (const [id] of confirmed.slice(0, Math.max(0, confirmed.length - 4096))) delete this.data.updates[id];
    atomicWrite(this.file, this.data);
  }
  receive(updates: any[]): void {
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id)) throw new Error('Invalid Telegram update id');
      if (update.update_id < this.data.offset) continue;
      this.data.updates[String(update.update_id)] ??= { state: 'received', update };
    }
    this.save();
  }
  update(id: number, patch: Partial<Dispatch>): void {
    const entry = this.data.updates[String(id)];
    if (!entry) throw new Error('Update was not journaled');
    Object.assign(entry, patch);
    if (['done', 'accepted', 'rejected'].includes(entry.state)) entry.update = { update_id: entry.update.update_id };
    this.save();
  }
  enqueue(key: string, text: string, extra?: any): void {
    if (!this.data.deliveries[key]) { this.data.deliveries[key] = { text, extra, state: 'queued' }; this.save(); }
  }
}
