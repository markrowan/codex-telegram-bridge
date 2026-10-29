import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { chunkText } from './common.js';
import { RpcError, type CodexPort } from './codex-client.js';
import { Store } from './store.js';

export interface TelegramPort {
  send(chatId: string, text: string, extra?: any): Promise<{ message_id: number }>;
  edit(chatId: string, messageId: number, text: string): Promise<void>;
  answer(callbackId: string, text: string): Promise<void>;
}
export type Project = { name: string; cwd: string };
type Route = { epoch: number; run: (updateId: number) => Promise<void> };
type Prompt = {
  token: string; id: number | string; threadId: string; turnId: string; epoch: number;
  method: string; params: any; messages: number[]; active: boolean; sending: boolean;
  answers: Record<string, { answers: string[] }>; question?: number; expires?: number; updateId?: number;
};

function fingerprint(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 24); }
function messageText(item: any): string | undefined {
  if (item?.type !== 'agentMessage' && item?.type !== 'plan') return;
  return typeof item.text === 'string' && item.text.trim() ? item.text : undefined;
}
export class Controller {
  private routes = new Map<string, Route>();
  private prompts = new Map<string, Prompt>();
  private fileItems = new Map<string, any>();
  private flushing?: Promise<void>;
  private reconnecting = false;

  constructor(readonly store: Store, readonly codex: CodexPort, readonly telegram: TelegramPort, readonly projects: Project[], private readonly allowed: () => boolean = () => true) {}
  label(id: string): string {
    return `[${this.store.data.threads[id]?.name || 'Codex'} · ${id.slice(0, 8)}]`;
  }
  private owner(): { userId: string; chatId: string } {
    if (!this.store.data.owner) throw new Error('Pair a private Telegram account locally first');
    return this.store.data.owner;
  }
  private async send(key: string, text: string, extra?: any): Promise<number[]> {
    const newline = text.indexOf('\n');
    const header = text.startsWith('[') && newline > 0 ? text.slice(0, newline) : '';
    const body = header ? text.slice(newline + 1) : text;
    const parts = chunkText(body, 3800 - header.length - 25);
    const chunks = parts.map((part, i) => `${header ? header + (parts.length > 1 ? ` (${i + 1}/${parts.length})` : '') + '\n' : ''}${part}`);
    chunks.forEach((part, index) => this.store.enqueue(`${key}:${index}`, part, index === chunks.length - 1 ? extra : undefined));
    await this.flush();
    if (chunks.some((_, index) => this.store.data.deliveries[`${key}:${index}`]?.state !== 'sent')) return [];
    return chunks.flatMap((_, index) => {
      const id = this.store.data.deliveries[`${key}:${index}`]?.messageId;
      return id === undefined ? [] : [id];
    });
  }
  async flush(): Promise<void> {
    if (!this.store.data.owner || !this.allowed()) return;
    if (this.flushing) {
      await this.flushing;
      if (Object.values(this.store.data.deliveries).some(d => d.state === 'queued')) await this.flush();
      return;
    }
    const task = this.flushQueued(); this.flushing = task;
    try { await task; } finally { this.flushing = undefined; }
  }
  private async flushQueued(): Promise<void> {
    while (true) {
      if (!this.allowed()) return;
      const delivery = Object.values(this.store.data.deliveries).find(value => value.state === 'queued');
      if (!delivery) break;
      delivery.state = 'sending'; this.store.save();
      try {
        const message = await this.telegram.send(this.owner().chatId, delivery.text, delivery.extra);
        delivery.messageId = message.message_id; delivery.state = 'sent'; delivery.text = ''; delete delivery.extra; this.store.save();
      } catch (error: any) {
        // Telegram explicitly rejected 429 requests, so retrying these is safe.
        delivery.state = error?.error_code === 429 ? 'queued' : 'uncertain'; this.store.save();
        throw new Error(error?.error_code === 429 ? 'Telegram rate limited delivery; it remains queued' : 'Telegram delivery is uncertain; it will not be resent automatically');
      }
    }
  }
  private button(text: string, run: (updateId: number) => Promise<void>): { text: string; callback_data: string } {
    const token = randomBytes(12).toString('hex');
    if (this.routes.size >= 1000) this.routes.delete(this.routes.keys().next().value!);
    this.routes.set(token, { epoch: this.codex.epoch, run });
    return { text, callback_data: `r:${token}` };
  }
  private async mutate(updateId: number, method: string, params: Record<string, any>): Promise<any> {
    this.store.update(updateId, { state: 'dispatching', operation: method, threadId: params.threadId });
    try {
      const result = await this.codex.request(method, params);
      this.store.update(updateId, { state: 'accepted', threadId: result.thread?.id ?? params.threadId, turnId: result.turn?.id ?? result.turnId });
      return result;
    } catch (error) {
      this.store.update(updateId, { state: error instanceof RpcError ? 'rejected' : 'uncertain', error: (error as Error).message });
      throw error;
    }
  }

  async process(update: any): Promise<void> {
    if (!this.allowed()) {
      if (this.store.data.updates[String(update.update_id)]?.state === 'received') this.store.update(update.update_id, { state: 'done' });
      return;
    }
    const owner = this.owner();
    const message = update.message;
    const callback = update.callback_query;
    const from = String(message?.from?.id ?? callback?.from?.id ?? '');
    const chat = message?.chat ?? callback?.message?.chat;
    if (from !== owner.userId || chat?.type !== 'private' || String(chat.id) !== owner.chatId) return;
    this.store.receive([update]);
    const record = this.store.data.updates[String(update.update_id)];
    if (!record || record.state !== 'received') return;
    try {
      if (callback) await this.callback(update.update_id, callback);
      else if (typeof message.text === 'string') await this.text(update.update_id, message);
      else await this.send(`update:${update.update_id}`, 'This version accepts text messages only.');
      if (record.state === 'received') this.store.update(update.update_id, { state: 'done' });
    } catch (error) {
      if (record.state === 'received') this.store.update(update.update_id, { state: 'done', error: (error as Error).message });
      await this.send(`error:${update.update_id}`, `Request was not retried: ${(error as Error).message}`).catch(() => {});
    }
  }
  private async text(updateId: number, message: any): Promise<void> {
    const text = message.text.trim();
    const key = `update:${updateId}`;
    if (message.reply_to_message?.message_id) {
      const prompt = [...this.prompts.values()].find(p => p.active && p.messages.includes(message.reply_to_message.message_id));
      if (prompt?.method === 'item/tool/requestUserInput') { await this.answerQuestion(prompt, text, updateId); return; }
      await this.send(key, 'That message has no live question attached. Send ordinary text without replying to address the selected conversation.'); return;
    }
    if (text === '/start' || text === '/help') {
      await this.send(key, 'Choose /threads, then send text. While Codex works, text steers its active turn.\n/threads — choose an existing thread\n/watch — watch the selected thread\n/unwatch — stop its notifications\n/new — choose a project for a new thread\n/status — connection, selection and delivery state\n/stop — interrupt the selected active turn\n/help — these commands\nReply to a question card to enter a free-text answer. Approvals apply only to the displayed action.'); return;
    }
    if (text === '/status') {
      const uncertain = Object.values(this.store.data.updates).filter(r => r.state === 'uncertain').length;
      const deliveries = Object.values(this.store.data.deliveries).filter(r => r.state === 'uncertain').length;
      await this.send(key, `Codex: ${this.codex.connected && !this.reconnecting ? 'connected' : 'reconnecting'}\nSelected: ${this.store.data.selected ? this.label(this.store.data.selected) : 'none'}\nWatched: ${this.store.data.watched.length}\nUncertain dispatches: ${uncertain}; uncertain Telegram deliveries: ${deliveries}. These are not automatically repeated.\n${this.store.data.watched.map(id => `${this.label(id)}${this.store.data.threads[id]?.lastError ? ': ' + this.store.data.threads[id].lastError : ''}`).join('\n')}`); return;
    }
    if (text === '/threads') { await this.threadPicker(key); return; }
    if (text === '/new') {
      await this.send(key, 'Choose the project for the new Codex conversation:', { reply_markup: { inline_keyboard: this.projects.map(project => [this.button(project.name, async id => {
        const result = await this.mutate(id, 'thread/start', { cwd: project.cwd });
        await this.watch(result.thread.id, true, result.thread);
        await this.send(`new:${id}`, `${this.label(result.thread.id)} New conversation in ${project.name}. Repository instructions still apply.`);
      })]) } }); return;
    }
    const selected = this.store.data.selected;
    if (!selected) { await this.send(key, 'Choose a conversation with /threads or create one with /new first.'); return; }
    if (text === '/unwatch') {
      this.store.data.watched = this.store.data.watched.filter(id => id !== selected); this.store.save();
      await this.invalidate(p => p.threadId === selected, 'Thread is no longer watched');
      await this.send(key, `${this.label(selected)} Notifications stopped. Selection is unchanged.`); return;
    }
    if (text === '/watch') { await this.watch(selected, false); await this.send(key, `${this.label(selected)} Notifications enabled.`); return; }
    if (text.startsWith('/') && text !== '/stop') { await this.send(key, 'Unknown command. Use /help.'); return; }
    if (!this.codex.connected || this.reconnecting) throw new Error('Codex is reconnecting; send this message again after /status shows connected');
    if (!this.store.data.watched.includes(selected)) await this.watch(selected, false);
    const current = await this.history({ threadId: selected, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    const turn = current.data?.[0];
    const active = turn?.status === 'inProgress' ? turn.id : undefined;
    if (text === '/stop') {
      if (!active) { await this.send(key, `${this.label(selected)} There is no active turn.`); return; }
      await this.mutate(updateId, 'turn/interrupt', { threadId: selected, turnId: active });
      await this.send(key, `${this.label(selected)} Interrupt requested.`); return;
    }
    const input = [{ type: 'text', text, text_elements: [] }];
    if (active) await this.mutate(updateId, 'turn/steer', { threadId: selected, expectedTurnId: active, input });
    else await this.mutate(updateId, 'turn/start', { threadId: selected, input });
    await this.send(key, `${this.label(selected)} ${active ? 'Steering accepted.' : 'Message accepted.'}`);
  }
  private async callback(updateId: number, callback: any): Promise<void> {
    const data = String(callback.data ?? '');
    if (data.startsWith('r:')) {
      const route = this.routes.get(data.slice(2));
      this.routes.delete(data.slice(2));
      if (!route || route.epoch !== this.codex.epoch || !this.codex.connected) { await this.telegram.answer(callback.id, 'This control expired. Use the command again.'); return; }
      await this.telegram.answer(callback.id, 'Selected'); await route.run(updateId); return;
    }
    const parts = data.split(':');
    const prompt = this.prompts.get(parts[1]);
    if (!prompt || !this.valid(prompt)) { await this.telegram.answer(callback.id, 'This request was resolved or expired.'); return; }
    await this.telegram.answer(callback.id, 'Decision received');
    if (parts[0] === 'q') {
      if (Number(parts[2]) !== prompt.question) throw new Error('That question was already answered');
      const index = Number(parts[3]);
      const option = prompt.params.questions[prompt.question ?? 0]?.options?.[index];
      if (!option) return;
      await this.answerQuestion(prompt, option.label, updateId); return;
    }
    if (parts[0] !== 'a' || !['accept', 'decline'].includes(parts[2])) return;
    const accept = parts[2] === 'accept';
    const available = prompt.params.availableDecisions;
    if (available && !available.includes(accept ? 'accept' : 'decline')) throw new Error('The daemon does not offer that decision');
    const result = prompt.method === 'item/permissions/requestApproval'
      ? { permissions: accept ? prompt.params.permissions : {}, scope: 'turn' }
      : { decision: accept ? 'accept' : 'decline' };
    await this.respond(prompt, result, updateId);
  }
  private async threadPicker(key: string, cursor?: string): Promise<void> {
    const loaded = await this.codex.request('thread/loaded/list', {});
    const page = await this.codex.request('thread/list', { limit: 8, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) });
    const ids = new Set<string>(cursor ? [] : loaded.data ?? []);
    for (const t of page.data ?? []) ids.add(t.id);
    const rows = [];
    for (const id of [...ids].slice(0, 20)) {
      const result = await this.codex.request('thread/read', { threadId: id, includeTurns: false });
      const t = result.thread;
      if (t.source && typeof t.source === 'object' && ('subAgent' in t.source || t.source.kind === 'subAgent')) continue;
      const name = String(t.name || t.preview || 'Untitled').replace(/\s+/g, ' ').slice(0, 48);
      const info = `${name} · ${basename(t.cwd || 'project').slice(0, 20)} · ${t.status?.type || 'stored'} · ${id.slice(0, 8)}`;
      rows.push([this.button(info, async updateId => { await this.watch(id, true); await this.send(`selected:${updateId}`, `${this.label(id)} Selected; notifications enabled.`); })]);
    }
    if (page.nextCursor) rows.push([this.button('More threads', id => this.threadPicker(`page:${id}`, page.nextCursor))]);
    await this.send(key, rows.length ? 'Choose a Codex conversation:' : 'No conversations found. Use /new.', { reply_markup: { inline_keyboard: rows } });
  }
  private async history(params: Record<string, any>): Promise<any> {
    try { return await this.codex.request('thread/turns/list', params); }
    catch (error) {
      // New daemon-owned threads acquire history only after their first real user turn.
      if (error instanceof RpcError && error.message.includes('not materialized yet')) return { data: [] };
      throw error;
    }
  }
  async watch(id: string, select: boolean, createdThread?: any): Promise<void> {
    const old = this.store.data.threads[id];
    if (!old?.baseline) {
      const latest = await this.history({ threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'full' });
      this.store.data.threads[id] = { ...old, name: old?.name || 'Codex', cursor: latest.backwardsCursor, baseline: true };
      for (const turn of latest.data ?? []) for (const item of turn.items ?? []) {
        const text = messageText(item);
        if (text) this.store.data.deliveries[this.itemKey(id, item.id, text)] = { text: '', state: 'sent' };
      }
      this.store.save();
    }
    const alreadyWatched = this.store.data.watched.includes(id);
    if (!alreadyWatched) { this.store.data.watched.push(id); this.store.save(); }
    let resumed;
    try { resumed = createdThread ? { thread: createdThread } : await this.codex.request('thread/resume', { threadId: id, excludeTurns: true }); }
    catch (error) {
      if (!alreadyWatched) this.store.data.watched = this.store.data.watched.filter(value => value !== id);
      this.store.save(); await this.invalidate(p => p.threadId === id, 'Thread subscription failed'); throw error;
    }
    const t = resumed.thread;
    Object.assign(this.store.data.threads[id], { name: String(t.name || t.preview || 'Codex').replace(/\s+/g, ' ').slice(0, 60), cwd: t.cwd, lastError: undefined });
    if (!this.store.data.watched.includes(id)) this.store.data.watched.push(id);
    if (select) this.store.data.selected = id;
    this.store.save();
    await this.reconcile(id);
  }
  private itemKey(threadId: string, itemId: string, text: string): string { return `item:${threadId}:${itemId}:${fingerprint(text)}`; }
  private async relayItem(threadId: string, item: any): Promise<void> {
    const text = messageText(item);
    if (!text || !item.id) return;
    const key = this.itemKey(threadId, item.id, text);
    if (this.store.data.deliveries[key]?.state === 'sent') return;
    const ids = await this.send(key, `${this.label(threadId)}\n${text}`);
    if (ids.length) { this.store.data.deliveries[key] = { text: '', state: 'sent' }; this.store.save(); }
  }
  async reconcile(threadId: string): Promise<void> {
    const state = this.store.data.threads[threadId];
    let cursor = state.cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.history({ threadId, limit: 50, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      for (const turn of result.data ?? []) {
        state.activeTurn = turn.status === 'inProgress' ? turn.id : undefined;
        if (turn.status !== 'inProgress') for (const item of turn.items ?? []) await this.relayItem(threadId, item);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      if (page === 99) throw new Error('History reconciliation limit reached; review the conversation in ChatGPT');
    }
    const latest = await this.history({ threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
    for (const turn of latest.data ?? []) if (turn.status !== 'inProgress') for (const item of turn.items ?? []) await this.relayItem(threadId, item);
    state.cursor = latest.backwardsCursor; state.lastError = undefined; this.store.save();
  }
  async reconnect(): Promise<void> {
    this.reconnecting = true;
    try {
      for (const id of this.store.data.watched) {
        try { await this.watch(id, false); }
        catch (error) { this.store.data.threads[id].lastError = (error as Error).message; this.store.save(); }
      }
      await this.flush();
    } finally { this.reconnecting = false; }
  }
  async notification(message: any): Promise<void> {
    const p = message.params ?? {};
    if (message.method === 'serverRequest/resolved') {
      await this.invalidate(r => r.threadId === p.threadId && String(r.id) === String(p.requestId), 'Resolved in Codex'); return;
    }
    if (!this.store.data.watched.includes(p.threadId)) return;
    if (message.method === 'item/started' && ['fileChange', 'commandExecution'].includes(p.item?.type)) {
      if (this.fileItems.size >= 500) this.fileItems.delete(this.fileItems.keys().next().value!);
      this.fileItems.set(`${p.threadId}:${p.item.id}`, p.item);
    }
    if (message.method === 'item/completed') await this.relayItem(p.threadId, p.item);
    if (message.method === 'turn/started') {
      this.store.data.threads[p.threadId].activeTurn = p.turn?.id; this.store.save();
    }
    if (message.method === 'turn/completed') {
      this.store.data.threads[p.threadId].activeTurn = undefined; this.store.save();
      await this.invalidate(r => r.threadId === p.threadId && r.turnId === p.turn?.id, 'Turn ended');
      if (p.turn?.status === 'failed' || p.turn?.status === 'interrupted') {
        await this.send(`turn:${p.threadId}:${p.turn.id}`, `${this.label(p.threadId)} Turn ${p.turn.status}.${p.turn.error?.message ? '\n' + p.turn.error.message : ''}`);
      }
      await this.reconcile(p.threadId);
    }
  }
  async disconnected(): Promise<void> {
    this.routes.clear();
    for (const entry of Object.values(this.store.data.updates)) if (entry.state === 'dispatching') entry.state = 'uncertain';
    this.store.save(); await this.invalidate(() => true, 'Connection closed; continue in ChatGPT or wait for a fresh request');
  }
  private valid(p: Prompt): boolean {
    return this.allowed() && p.active && p.messages.length > 0 && !p.sending && p.epoch === this.codex.epoch && this.codex.connected && this.store.data.watched.includes(p.threadId) && (!p.expires || p.expires > Date.now());
  }
  async serverRequest(request: any): Promise<void> {
    const params = request.params ?? {};
    if (!this.allowed() || !this.store.data.watched.includes(params.threadId) || !this.store.data.owner || !params.turnId) return;
    if ([...this.prompts.values()].some(p => p.id === request.id && p.epoch === this.codex.epoch)) return;
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!supported.includes(request.method)) {
      await this.send(`unsupported:${this.codex.epoch}:${request.id}`, `${this.label(params.threadId)} A request requires ChatGPT: ${request.method}`); return;
    }
    const prompt: Prompt = { token: randomBytes(12).toString('hex'), id: request.id, threadId: params.threadId, turnId: params.turnId, epoch: this.codex.epoch, method: request.method, params, messages: [], active: true, sending: false, answers: {}, expires: params.autoResolutionMs ? Date.now() + params.autoResolutionMs : undefined };
    this.prompts.set(prompt.token, prompt);
    if (prompt.method === 'item/tool/requestUserInput') {
      if (!Array.isArray(params.questions) || !params.questions.length || params.questions.some((q: any) => q.isSecret)) {
        prompt.active = false;
        await this.send(`unsupported:${prompt.token}`, `${this.label(params.threadId)} Answer this question in ChatGPT.`); return;
      }
      prompt.question = 0; await this.showQuestion(prompt); return;
    }
    const details = { ...params };
    delete details.threadId; delete details.turnId; delete details.startedAtMs;
    if (prompt.method === 'item/commandExecution/requestApproval') {
      details.command ??= this.fileItems.get(`${params.threadId}:${params.itemId}`)?.command;
      if (!details.command && !details.commandActions?.length && !details.networkApprovalContext) {
        prompt.active = false; await this.send(`unsupported:${prompt.token}`, `${this.label(params.threadId)} Review the command details in ChatGPT.`); return;
      }
    }
    if (prompt.method === 'item/fileChange/requestApproval') {
      details.changes = this.fileItems.get(`${params.threadId}:${params.itemId}`)?.changes;
      if (!params.grantRoot && !details.changes?.length) {
        prompt.active = false; await this.send(`unsupported:${prompt.token}`, `${this.label(params.threadId)} Review the file-change details in ChatGPT.`); return;
      }
    }
    const scope = prompt.method === 'item/permissions/requestApproval' ? 'Requested permissions apply to this turn only; no session grant.' : 'One action only.';
    const text = `${this.label(params.threadId)}\n${prompt.method}\n${scope} Requested details:\n${JSON.stringify(details, null, 2)}`;
    if (text.length > 16000) {
      prompt.active = false; await this.send(`unsupported:${prompt.token}`, `${this.label(params.threadId)} This request is too large to display completely; review it in ChatGPT.`); return;
    }
    const available: string[] = params.availableDecisions ?? ['accept', 'decline'];
    const buttons = ['accept', 'decline'].filter(value => available.includes(value)).map(value => ({ text: value === 'accept' ? 'Approve once' : 'Decline', callback_data: `a:${prompt.token}:${value}` }));
    if (!buttons.length) { prompt.active = false; await this.send(`unsupported:${prompt.token}`, `${this.label(params.threadId)} This request requires a decision in ChatGPT.`); return; }
    prompt.messages = await this.send(`request:${prompt.epoch}:${prompt.id}`, text, { reply_markup: { inline_keyboard: [buttons] } });
    if (!prompt.active) await this.editExpired(prompt, 'Resolved while the card was being delivered');
  }
  private async showQuestion(prompt: Prompt): Promise<void> {
    const q = prompt.params.questions[prompt.question!];
    const text = `${this.label(prompt.threadId)}\n${q.header || 'Question'}: ${q.question}\n${(q.options ?? []).map((o: any, i: number) => `${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`).join('\n')}\nReply to this message to enter your own answer.`;
    prompt.messages = await this.send(`question:${prompt.token}:${prompt.question}`, text, {
      reply_markup: { inline_keyboard: (q.options ?? []).map((o: any, i: number) => [{ text: o.label.slice(0, 100), callback_data: `q:${prompt.token}:${prompt.question}:${i}` }]) },
    });
    if (!prompt.active) await this.editExpired(prompt, 'Question resolved');
  }
  private async answerQuestion(prompt: Prompt, text: string, updateId: number): Promise<void> {
    if (!this.valid(prompt)) throw new Error('The question expired');
    const q = prompt.params.questions[prompt.question!];
    prompt.answers[q.id] = { answers: [text] };
    await this.editExpired(prompt, 'Answer recorded');
    if (!this.valid(prompt)) return;
    prompt.question! += 1;
    if (prompt.question! < prompt.params.questions.length) await this.showQuestion(prompt);
    else await this.respond(prompt, { answers: prompt.answers }, updateId);
  }
  private async respond(prompt: Prompt, result: any, updateId: number): Promise<void> {
    if (!this.valid(prompt)) throw new Error('The request expired');
    prompt.sending = true;
    prompt.updateId = updateId;
    this.store.update(updateId, { state: 'dispatching', operation: `response:${prompt.method}`, threadId: prompt.threadId, turnId: prompt.turnId });
    try { this.codex.respond(prompt.id, result, prompt.epoch); }
    catch (error) { this.store.update(updateId, { state: 'uncertain', error: (error as Error).message }); throw error; }
    await this.editExpired(prompt, 'Decision sent to Codex; waiting for resolution');
  }
  private async editExpired(prompt: Prompt, reason: string): Promise<void> {
    if (!this.allowed()) return;
    for (const messageId of prompt.messages) await this.telegram.edit(this.owner().chatId, messageId, `${this.label(prompt.threadId)} ${reason}.`).catch(() => {});
  }
  private async invalidate(predicate: (prompt: Prompt) => boolean, reason: string): Promise<void> {
    const affected = [...this.prompts.values()].filter(p => p.active && predicate(p));
    for (const prompt of affected) {
      prompt.active = false;
      if (prompt.updateId !== undefined && reason === 'Resolved in Codex') this.store.update(prompt.updateId, { state: 'accepted' });
      for (const [key, delivery] of Object.entries(this.store.data.deliveries)) {
        if ((key.startsWith(`request:${prompt.epoch}:${prompt.id}:`) || key.startsWith(`question:${prompt.token}:`)) && delivery.state === 'queued') delivery.state = 'cancelled';
      }
    }
    if (affected.length) this.store.save();
    for (const prompt of affected) await this.editExpired(prompt, reason);
    for (const prompt of affected) this.prompts.delete(prompt.token);
  }
}
