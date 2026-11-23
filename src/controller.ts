import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { chunkText } from './common.js';
import { RpcError, type CodexPort } from './codex-client.js';
import { Store, type Dispatch, type VoiceDraft } from './store.js';
import { VoiceError, type TranscribeVoice } from './voice.js';
import { markdownChunks } from './markdown.js';

export interface TelegramPort {
  send(chatId: string, text: string, extra?: any): Promise<{ message_id: number }>;
  edit(chatId: string, messageId: number, text: string, extra?: any): Promise<void>;
  react?(chatId: string, messageId: number): Promise<void>;
  answer(callbackId: string, text: string): Promise<void>;
  typing?(chatId: string): Promise<void>;
  answerInline?(id: string, draft?: { id: string; text: string; label: string }): Promise<void>;
}
export type Project = { name: string; cwd: string };
const draftLifetime = 30 * 60_000;
const pendingVoiceLimit = 8;
type Route = { epoch: number; run: (updateId: number) => Promise<void> };
type Prompt = {
  token: string; id: number | string; threadId: string; turnId: string; epoch: number;
  method: string; params: any; messages: number[]; deliveryKeys: string[]; active: boolean; sending: boolean;
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
  private recovering = new Map<string, Promise<void>>();
  private recoveryAgain = new Set<string>();
  private recoveryRetries = new Map<string, { failures: number; after: number; subscription: boolean }>();

  private voiceWorker?: Promise<void>;
  private typingTurns = new Map<string, string>();
  private completedTurns = new Map<string, string>();
  private typingWaits = new Map<string, Map<string, string>>();
  private typingTimer?: NodeJS.Timeout;
  private typingInFlight = false;

  constructor(readonly store: Store, readonly codex: CodexPort, readonly telegram: TelegramPort, readonly projects: Project[], private readonly allowed: () => boolean = () => true,
    private readonly voice?: { transcribe: TranscribeVoice; signal: AbortSignal; botId: number }) {}
  label(id: string): string {
    return `[${this.store.data.threads[id]?.name || 'Codex'} · ${id.slice(0, 8)}]`;
  }
  private owner(): { userId: string; chatId: string } {
    if (!this.store.data.owner) throw new Error('Pair a private Telegram account locally first');
    return this.store.data.owner;
  }
  private async send(key: string, text: string, extra?: any, prompt?: Prompt, markdown = false): Promise<number[]> {
    const newline = text.indexOf('\n');
    const header = text.startsWith('[') && newline > 0 ? text.slice(0, newline) : '';
    const body = header ? text.slice(newline + 1) : text;
    const parts = chunkText(body, 3800 - header.length - 25);
    const chunks = markdown ? markdownChunks(body, header) : parts.map((part, i) => ({ text: `${header ? header + (parts.length > 1 ? ` (${i + 1}/${parts.length})` : '') + '\n' : ''}${part}`, entities: undefined }));
    if (prompt) {
      prompt.messages = [];
      prompt.deliveryKeys = chunks.map((_, index) => `${key}:${index}`);
    }
    chunks.forEach((part, index) => this.store.enqueue(`${key}:${index}`, part.text, { ...(part.entities ? { entities: part.entities } : {}), ...(index === chunks.length - 1 ? extra : {}) }));
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
      const entry = Object.entries(this.store.data.deliveries).find(([, value]) => value.state === 'queued');
      if (!entry) break;
      const [key, delivery] = entry;
      if (key.startsWith('voice-preview:') || key.startsWith('voice-progress:')) {
        const record = this.findVoice(key.split(':')[1]);
        if (!this.voice || record?.state !== 'voice' || !record.voice || record.voice.confirmationId !== undefined || record.voice.expiresAt <= Date.now()
          || (key.startsWith('voice-progress:') && !!record.voice.text)) {
          this.store.data.deliveries[key] = { text: '', state: 'cancelled' };
          this.store.save();
          continue;
        }
      }
      const prompt = [...this.prompts.values()].find(p => p.deliveryKeys.includes(key));
      delivery.state = 'sending'; this.store.save();
      try {
        const message = await this.telegram.send(this.owner().chatId, delivery.text, delivery.extra);
        delivery.messageId = message.message_id; delivery.state = 'sent'; delivery.text = ''; delete delivery.extra; this.store.save();
        if (prompt) {
          if (!prompt.active) {
            await this.editExpired({ ...prompt, messages: [message.message_id] }, 'Resolved while the card was being delivered');
          } else if (prompt.deliveryKeys.every(k => this.store.data.deliveries[k]?.state === 'sent')) {
            prompt.messages = prompt.deliveryKeys.map(k => this.store.data.deliveries[k].messageId!);
          }
        }
      } catch (error: any) {
        // Telegram explicitly rejected 429 requests, so retrying these is safe.
        delivery.state = error?.error_code === 429 ? 'queued' : 'uncertain';
        const draft = key.startsWith('voice-preview:') ? this.findVoice(key.split(':')[1]) : undefined;
        if (draft) draft.voiceFailure = 'preview';
        this.store.save();
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
    const draft = this.store.data.updates[String(updateId)]?.voice;
    if (draft) delete draft.text;
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
      else if (typeof message.text === 'string') {
        const draftId = this.voiceMessageId(message);
        if (draftId !== undefined || (this.voice && message.via_bot?.id === this.voice.botId)) {
          await this.confirmVoice(update.update_id, message.message_id, message.text,
            message.via_bot?.id === this.voice?.botId && draftId ? this.findVoice(draftId) : undefined);
        } else await this.text(update.update_id, message);
      }
      else if (message.voice && this.voice) await this.queueVoice(update.update_id, message.message_id);
      else await this.send(`update:${update.update_id}`, 'This version accepts text messages only.');
      if (record.state === 'received') this.store.update(update.update_id, { state: 'done' });
    } catch (error) {
      if (record.state === 'received') this.store.update(update.update_id, { state: 'done', error: (error as Error).message });
      await this.send(`error:${update.update_id}`, `Request was not retried: ${(error as Error).message}`).catch(() => {});
    }
  }
  private async queueVoice(updateId: number, messageId: number): Promise<void> {
    const threadId = this.store.data.selected;
    if (!threadId) { await this.send(`update:${updateId}`, 'Choose a conversation with /threads or /new before sending a voice note.'); return; }
    if (Object.values(this.store.data.updates).filter(record => record.state === 'voice').length >= pendingVoiceLimit) {
      await this.send(`update:${updateId}`, 'Voice drafts are full. Send a transcript or wait for a draft to expire.');
      return;
    }
    this.store.update(updateId, {
      state: 'voice', threadId, voice: { id: randomBytes(16).toString('hex'), messageId, expiresAt: Date.now() + draftLifetime },
    });
  }
  async serviceVoice(): Promise<void> {
    if (this.voice?.signal.aborted || this.voiceWorker) return;
    const work = this.processVoiceDrafts();
    this.voiceWorker = work;
    try { await work; } finally { this.voiceWorker = undefined; }
  }
  private async processVoiceDrafts(): Promise<void> {
    const voice = this.voice;
    for (const [key, record] of Object.entries(this.store.data.updates)) {
      if (voice?.signal.aborted) return;
      if (record.state !== 'voice' || !record.voice || !record.threadId) continue;
      const draft = record.voice;
      const updateId = Number(key);
      const expired = draft.expiresAt <= Date.now();
      const confirmation = draft.confirmationId === undefined ? undefined : this.store.data.updates[String(draft.confirmationId)];
      const authorized = !!voice && this.allowed();
      if (authorized && confirmation?.state === 'received') continue;
      if (!voice || !authorized || expired || draft.confirmationId !== undefined) {
        this.clearVoicePreview(draft.id);
        this.store.update(updateId, { state: 'done', voice: { ...draft, text: undefined } });
        if (authorized && expired && draft.confirmationId === undefined) {
          await this.send(`voice-expired:${draft.id}`, `${this.label(record.threadId)} Voice draft expired. Send the note again to make a new draft.`);
        }
        continue;
      }
      const { transcribe, signal } = voice;
      if (!draft.text) {
        let progress: Promise<unknown> | undefined;
        const timer = setTimeout(() => {
          progress = this.send(`voice-progress:${draft.id}`, `${this.label(record.threadId!)} Transcribing…`, {
            reply_parameters: { message_id: draft.messageId, allow_sending_without_reply: true },
          }).catch(() => {});
        }, 3000);
        timer.unref();
        try {
          const text = await transcribe(record.update.message.voice, signal);
          if (signal.aborted) return;
          if (!this.allowed()) { this.store.update(updateId, { state: 'done', voice: undefined }); return; }
          if (!text.trim()) throw new VoiceError('whisper', 'No speech was transcribed. Please send another voice note.');
          if (Array.from(text).length > 4096) throw new VoiceError('validation', 'The transcript is too long for one Telegram message. Please split the recording.');
          draft.text = text;
          draft.expiresAt = Date.now() + draftLifetime;
          this.store.update(updateId, { update: { update_id: updateId } });
        } catch (error) {
          if (signal.aborted) return;
          const failure = error instanceof VoiceError ? error : new VoiceError('whisper', 'Voice transcription failed. Please try again.');
          this.store.update(updateId, { state: 'done', voice: undefined, voiceFailure: failure.stage });
          await progress;
          const notice = `${this.label(record.threadId)} ${failure.message}`;
          const progressId = this.store.data.deliveries[`voice-progress:${draft.id}:0`]?.messageId;
          if (progressId === undefined || !await this.editVoiceMessage(draft.id, progressId, notice)) {
            await this.send(`voice-error:${draft.id}`, notice);
          }
          continue;
        } finally { clearTimeout(timer); }
        await progress;
      }
      await this.publishVoicePreview(record.threadId, draft);
    }
  }
  private async publishVoicePreview(threadId: string, draft: VoiceDraft): Promise<void> {
    const body = `${this.label(threadId)} To correct a phrase, reply: wrong words → corrected words.\n${draft.text}`;
    const replyMarkup = { inline_keyboard: [[{ text: 'Send transcript', switch_inline_query_current_chat: `voice:${draft.id}` }]] };
    const prefix = `voice-preview:${draft.id}`;
    const key = draft.revision === undefined ? prefix : `${prefix}:revision-${draft.revision}`;
    if (!this.store.data.deliveries[`${key}:0`]) {
      const earlier = new Set(Object.entries(this.store.data.deliveries)
        .filter(([id, value]) => id.startsWith(`${prefix}:`) && value.state === 'sent')
        .map(([, value]) => value.messageId));
      const progress = this.store.data.deliveries[`voice-progress:${draft.id}:0`]?.messageId;
      const target = draft.revision === undefined ? progress : earlier.size === 1 ? [...earlier][0] : undefined;
      if (body.length <= 3775 && target !== undefined && await this.editVoiceMessage(draft.id, target, body, replyMarkup)) {
        this.store.data.deliveries[`${key}:0`] = { text: '', state: 'sent', messageId: target };
        this.store.save();
        return;
      }
      if (body.length > 3775 && draft.revision === undefined && progress !== undefined) {
        await this.editVoiceMessage(draft.id, progress, `${this.label(threadId)} Transcript ready below.`);
      }
    }
    await this.send(key, body, {
      reply_parameters: { message_id: draft.messageId, allow_sending_without_reply: true }, reply_markup: replyMarkup,
    });
  }
  private async editVoiceMessage(id: string, messageId: number, text: string, replyMarkup?: any): Promise<boolean> {
    if (!this.allowed()) return false;
    try {
      await this.telegram.edit(this.owner().chatId, messageId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
      return true;
    } catch {
      const record = this.findVoice(id);
      if (record) { record.voiceFailure = 'preview'; this.store.save(); }
      return false;
    }
  }
  private clearVoicePreview(id: string): void {
    for (const [key, delivery] of Object.entries(this.store.data.deliveries)) {
      if (!key.startsWith(`voice-preview:${id}:`)) continue;
      if (delivery.state === 'queued') delivery.state = 'cancelled';
      delivery.text = '';
      delete delivery.extra;
    }
  }
  private findVoice(id: string): Dispatch | undefined {
    if (!/^[a-f0-9]{32}$/.test(id)) return;
    return Object.values(this.store.data.updates).find(record => record.voice?.id === id);
  }
  async inlineVoiceQuery(query: { id: string; from: { id: number }; chat_type?: string; query: string }): Promise<void> {
    if (!this.telegram.answerInline) return;
    const record = this.voice && this.allowed() && String(query.from.id) === this.owner().userId && (query.chat_type === 'sender' || query.chat_type === 'private') && query.query.startsWith('voice:')
      ? this.findVoice(query.query.slice('voice:'.length)) : undefined;
    const draft = record?.voice;
    if (record?.state !== 'voice' || !record.threadId || !draft?.text || draft.confirmationId !== undefined || draft.expiresAt <= Date.now()) {
      await this.telegram.answerInline(query.id);
      return;
    }
    await this.telegram.answerInline(query.id, { id: draft.id, text: draft.text, label: this.label(record.threadId) });
  }
  private voiceMessageId(message: any): string | undefined {
    for (const row of message.reply_markup?.inline_keyboard ?? []) {
      for (const button of row) {
        if (button.callback_data?.startsWith('voice-status:')) return button.callback_data.slice('voice-status:'.length);
      }
    }
  }
  private async confirmVoice(confirmationId: number, messageId: number, text: string, record: Dispatch | undefined): Promise<void> {
    const key = `update:${confirmationId}`;
    if (!this.voice || !record?.voice || !record.threadId) {
      await this.send(key, 'This message could not be matched to a voice draft. No Codex turn was sent.');
      return;
    }
    const draft = record.voice;
    if (draft.confirmationId !== undefined && (draft.confirmationId !== confirmationId || record.state !== 'voice')) {
      // Recovery may revisit the same Telegram post after Codex already accepted it.
      if (draft.confirmationId !== confirmationId) await this.send(key, 'This voice draft was already submitted. Check Codex delivery status on the original transcript.');
      return;
    }
    if (record.state !== 'voice' || (draft.confirmationId === undefined && draft.expiresAt <= Date.now())
      || !draft.text || text !== draft.text) {
      await this.send(key, 'This voice draft expired or changed. Use Send transcript on the latest preview.');
      return;
    }
    const updateId = record.update.update_id;
    const threadId = record.threadId;
    this.clearVoicePreview(draft.id);
    this.store.update(updateId, { voice: { ...draft, confirmationId } });
    try {
      await this.submitText(updateId, threadId, text, messageId);
    } catch (error) {
      const state = this.store.data.updates[String(updateId)]?.state;
      if (state === 'voice') this.store.update(updateId, { state: 'rejected', voice: { ...draft, confirmationId, text: undefined }, error: (error as Error).message });
      const outcome = state === 'uncertain' ? 'Codex delivery is uncertain. Check the conversation before resending.'
        : 'Codex did not accept this transcript. Send the note again when the conversation is available.';
      await this.send(key, `${this.label(threadId)} ${outcome}`);
    }
  }
  private async reviseVoice(updateId: number, text: string, record: Dispatch | undefined): Promise<void> {
    const key = `update:${updateId}`;
    const draft = record?.voice;
    if (!this.voice || record?.state !== 'voice' || !record.threadId || !draft?.text
      || draft.confirmationId !== undefined || draft.expiresAt <= Date.now()) {
      await this.send(key, 'This voice draft is no longer open for corrections.');
      return;
    }
    if (draft.revision === updateId) {
      await this.publishVoicePreview(record.threadId, draft);
      return;
    }
    let revised = text;
    const separator = text.indexOf('→');
    if (separator >= 0) {
      const before = text.slice(0, separator).trim();
      const after = text.slice(separator + 1).trim();
      const position = draft.text.indexOf(before);
      if (!before || position < 0 || draft.text.indexOf(before, position + 1) >= 0) {
        await this.send(key, 'Quote a phrase that appears exactly once in the transcript, then add → and the replacement.');
        return;
      }
      revised = draft.text.slice(0, position) + after + draft.text.slice(position + before.length);
    }
    if (!revised.trim() || Array.from(revised).length > 4096) {
      await this.send(key, 'The corrected transcript must fit in one Telegram message.');
      return;
    }
    const revision = { ...draft, text: revised, revision: updateId };
    this.store.update(record.update.update_id, { voice: revision });
    await this.publishVoicePreview(record.threadId, revision);
  }
  async voiceDeliveryStatus(callback: { id: string; from: { id: number }; data: string }): Promise<void> {
    if (!this.allowed() || String(callback.from.id) !== this.owner().userId) return;
    const record = this.findVoice(callback.data.slice('voice-status:'.length));
    const status = record?.state === 'accepted' ? 'Codex accepted the transcript.'
      : record?.state === 'uncertain' ? 'Codex delivery is uncertain. Check the conversation before resending.'
      : record?.state === 'rejected' ? 'Codex did not accept the transcript.'
      : record?.state === 'dispatching' || (record?.state === 'voice' && record.voice?.confirmationId !== undefined) ? 'Sending to Codex.'
      : 'No Codex delivery recorded for this transcript.';
    await this.telegram.answer(callback.id, status);
  }
  private async text(updateId: number, message: any): Promise<void> {
    const text = message.text.trim();
    const key = `update:${updateId}`;
    if (message.reply_to_message?.message_id) {
      const prompt = [...this.prompts.values()].find(p => p.active && p.messages.includes(message.reply_to_message.message_id));
      if (prompt?.method === 'item/tool/requestUserInput') { await this.answerQuestion(prompt, text, updateId); return; }
      const target = Object.entries(this.store.data.deliveries).find(([deliveryKey, delivery]) =>
        delivery.state === 'sent' && delivery.messageId === message.reply_to_message.message_id
        && (deliveryKey.startsWith('item:') || deliveryKey.startsWith('voice-preview:')));
      const targetKey = target?.[0];
      if (targetKey?.startsWith('voice-preview:')) {
        await this.reviseVoice(updateId, text, this.findVoice(targetKey.split(':')[1]));
        return;
      }
      const threadId = targetKey && Object.keys(this.store.data.threads).find(id => targetKey.startsWith(`item:${id}:`));
      if (!threadId || !text) {
        await this.send(key, 'This reply could not be matched to a Codex message or live draft. Send ordinary text to the selected conversation instead.');
        return;
      }
      const quote = message.quote?.text || message.reply_to_message.text;
      const input = typeof quote === 'string' && quote.trim()
        ? `${text}\n\nTelegram reply context (quoted from the earlier Codex message):\n${quote}` : text;
      await this.submitText(updateId, threadId, input, message.message_id);
      return;
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
      this.typingTurns.delete(selected);
      this.completedTurns.delete(selected);
      this.typingWaits.delete(selected);
      this.syncTyping();
      await this.invalidate(p => p.threadId === selected, 'Thread is no longer watched');
      await this.send(key, `${this.label(selected)} Notifications stopped. Selection is unchanged.`); return;
    }
    if (text === '/watch') { await this.watch(selected, false); await this.send(key, `${this.label(selected)} Notifications enabled.`); return; }
    if (text.startsWith('/') && text !== '/stop') { await this.send(key, 'Unknown command. Use /help.'); return; }
    if (text === '/stop') {
      const active = await this.activeTurnFor(selected);
      if (!active) { await this.send(key, `${this.label(selected)} There is no active turn.`); return; }
      await this.mutate(updateId, 'turn/interrupt', { threadId: selected, turnId: active });
      await this.send(key, `${this.label(selected)} Interrupt requested.`); return;
    }
    await this.submitText(updateId, selected, text, message.message_id);
  }
  private async activeTurnFor(threadId: string): Promise<string | undefined> {
    if (!this.codex.connected || this.reconnecting) throw new Error('Codex is reconnecting; send this message again after /status shows connected');
    if (!this.store.data.watched.includes(threadId)) await this.watch(threadId, false);
    const current = await this.history({ threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    const turn = current.data?.[0];
    return turn?.status === 'inProgress' ? turn.id : undefined;
  }
  private async submitText(updateId: number, threadId: string, text: string, messageId?: number): Promise<void> {
    const active = await this.activeTurnFor(threadId);
    if (!this.allowed()) throw new Error('Telegram access is no longer authorized');
    const state = this.store.data.updates[String(updateId)]?.state;
    if (state !== 'received' && state !== 'voice') throw new Error('This message is no longer awaiting delivery');
    const input = [{ type: 'text', text, text_elements: [] }];
    const epoch = this.codex.epoch;
    const result = active
      ? await this.mutate(updateId, 'turn/steer', { threadId, expectedTurnId: active, input })
      : await this.mutate(updateId, 'turn/start', { threadId, input });
    if (typeof messageId === 'number' && Number.isSafeInteger(messageId)) void this.reactToAcceptedMessage(messageId);
    const turnId = active ?? result.turn?.id ?? result.turnId;
    const alreadyFinished = this.completedTurns.get(threadId) === turnId
      || (!active && result.turn?.status && result.turn.status !== 'inProgress');
    if (turnId && !alreadyFinished && this.codex.connected && epoch === this.codex.epoch) {
      this.typingTurns.set(threadId, turnId);
      this.syncTyping();
    }
  }
  private async reactToAcceptedMessage(messageId: number): Promise<void> {
    if (!this.telegram.react || !this.allowed()) return;
    try { await this.telegram.react(this.owner().chatId, messageId); }
    catch { /* Codex has already accepted the message. */ }
  }
  private syncTyping(refresh = false): void {
    const owner = this.store.data.owner;
    const eligible = !!this.telegram.typing && !!owner && this.codex.connected && this.allowed()
      && [...this.typingTurns].some(([threadId, turnId]) => this.store.data.watched.includes(threadId)
        && ![...(this.typingWaits.get(threadId)?.values() ?? [])].includes(turnId));
    if (!eligible) {
      clearInterval(this.typingTimer);
      this.typingTimer = undefined;
      return;
    }
    if (this.typingTimer && !refresh) return;
    if (!this.typingTimer) {
      this.typingTimer = setInterval(() => this.syncTyping(true), 4000);
      this.typingTimer.unref();
    }
    void this.sendTyping(owner.chatId);
  }
  private async sendTyping(chatId: string): Promise<void> {
    if (this.typingInFlight) return;
    this.typingInFlight = true;
    try { await this.telegram.typing?.(chatId); }
    catch { /* Typing status is best effort. */ }
    finally { this.typingInFlight = false; }
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
  private async threadPicker(key: string, cursor?: string, remainingIds?: string[]): Promise<void> {
    let ids = remainingIds;
    let nextCursor = cursor;
    if (!ids) {
      const loaded = cursor ? { data: [] } : await this.codex.request('thread/loaded/list', {});
      const page = await this.codex.request('thread/list', { limit: 8, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) });
      ids = [...new Set<string>([...(page.data ?? []).map((t: any) => t.id), ...(loaded.data ?? [])])];
      nextCursor = page.nextCursor;
    }
    const remaining = ids.slice(8);
    const rows = [];
    for (const id of ids.slice(0, 8)) {
      const result = await this.codex.request('thread/read', { threadId: id, includeTurns: false });
      const t = result.thread;
      if (t.source && typeof t.source === 'object' && ('subAgent' in t.source || t.source.kind === 'subAgent')) continue;
      const name = String(t.name || t.preview || 'Untitled').replace(/\s+/g, ' ').slice(0, 48);
      const info = `${name} · ${basename(t.cwd || 'project').slice(0, 20)} · ${t.status?.type || 'stored'} · ${id.slice(0, 8)}`;
      rows.push([this.button(info, async updateId => { await this.watch(id, true); await this.send(`selected:${updateId}`, `${this.label(id)} Selected; notifications enabled.`); })]);
    }
    if (remaining.length || nextCursor) rows.push([this.button('More threads', id => this.threadPicker(`page:${id}`, nextCursor, remaining.length ? remaining : undefined))]);
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
      for (const turn of latest.data ?? []) {
        if (['failed', 'interrupted'].includes(turn.status)) this.store.data.deliveries[`turn:${id}:${turn.id}`] = { text: '', state: 'sent' };
        for (const item of turn.items ?? []) {
          const text = messageText(item);
          if (text) this.store.data.deliveries[this.itemKey(id, item.id, text)] = { text: '', state: 'sent' };
        }
      }
      this.store.save();
    }
    const alreadyWatched = this.store.data.watched.includes(id);
    if (!alreadyWatched) { this.store.data.watched.push(id); this.store.save(); }
    let resumed;
    try { resumed = createdThread ? { thread: createdThread } : await this.codex.request('thread/resume', { threadId: id, excludeTurns: true }); }
    catch (error) {
      if (!alreadyWatched) this.store.data.watched = this.store.data.watched.filter(value => value !== id);
      else this.recoveryFailed(id, error, true);
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
    const ids = await this.send(key, `${this.label(threadId)}\n${text}`, undefined, undefined, true);
    if (ids.length) { this.store.data.deliveries[key] = { text: '', state: 'sent' }; this.store.save(); }
  }
  private async relayOutcome(threadId: string, turn: any): Promise<void> {
    if (!['failed', 'interrupted'].includes(turn?.status)) return;
    const key = `turn:${threadId}:${turn.id}`;
    if (this.store.data.deliveries[key]?.state === 'sent') return;
    const ids = await this.send(key, `${this.label(threadId)} Turn ${turn.status}.${turn.error?.message ? '\n' + turn.error.message : ''}`);
    if (ids.length) { this.store.data.deliveries[key] = { text: '', state: 'sent' }; this.store.save(); }
  }
  private recoveryFailed(threadId: string, error: unknown, subscription = false): void {
    const failures = (this.recoveryRetries.get(threadId)?.failures ?? 0) + 1;
    this.recoveryRetries.set(threadId, { failures, subscription: subscription || !!this.recoveryRetries.get(threadId)?.subscription, after: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)) });
    this.store.data.threads[threadId].lastError = (error as Error).message; this.store.save();
  }
  async retryRecovery(now = Date.now()): Promise<void> {
    if (!this.allowed() || !this.codex.connected || this.reconnecting) return;
    for (const [id, retry] of [...this.recoveryRetries]) {
      if (!this.store.data.watched.includes(id)) { this.recoveryRetries.delete(id); continue; }
      if (retry.after > now || this.recovering.has(id)) continue;
      // Failure schedules bounded backoff and remains visible in /status.
      try { if (retry.subscription) await this.watch(id, false); else await this.reconcile(id); } catch {}
    }
  }
  async reconcile(threadId: string): Promise<void> {
    const pending = this.recovering.get(threadId);
    if (pending) { this.recoveryAgain.add(threadId); return pending; }
    const task = (async () => {
      do {
        this.recoveryAgain.delete(threadId);
        await this.reconcileHistory(threadId);
      } while (this.recoveryAgain.has(threadId) && this.store.data.watched.includes(threadId) && this.allowed());
    })();
    this.recovering.set(threadId, task);
    try { await task; this.recoveryRetries.delete(threadId); }
    catch (error) { this.recoveryFailed(threadId, error); throw error; }
    finally { this.recovering.delete(threadId); }
  }
  private async reconcileHistory(threadId: string): Promise<void> {
    const state = this.store.data.threads[threadId];
    // Snapshot before scanning: turns completed during delivery must remain recoverable.
    // backwardsCursor includes this last turn when read in ascending order.
    const checkpoint = await this.history({ threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    let cursor = state.cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.history({ threadId, limit: 50, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      for (const turn of result.data ?? []) {
        state.activeTurn = turn.status === 'inProgress' ? turn.id : undefined;
        if (turn.status !== 'inProgress') {
          for (const item of turn.items ?? []) await this.relayItem(threadId, item);
          await this.relayOutcome(threadId, turn);
        }
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      if (page === 99) throw new Error('History reconciliation limit reached; review the conversation in ChatGPT');
    }
    state.cursor = checkpoint.backwardsCursor; state.lastError = undefined; this.store.save();
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
      const waits = this.typingWaits.get(p.threadId);
      if (waits?.delete(String(p.requestId))) {
        if (!waits.size) this.typingWaits.delete(p.threadId);
        this.syncTyping();
      }
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
      const typingTurn = this.typingTurns.get(p.threadId);
      if (typingTurn && typingTurn !== p.turn?.id) {
        this.typingTurns.delete(p.threadId);
        this.syncTyping();
      }
    }
    if (message.method === 'turn/completed') {
      const turnId = p.turn?.id;
      if (turnId) this.completedTurns.set(p.threadId, turnId);
      if (this.typingTurns.get(p.threadId) === turnId) this.typingTurns.delete(p.threadId);
      const waits = this.typingWaits.get(p.threadId);
      if (waits) {
        for (const [id, waitingTurn] of waits) if (waitingTurn === turnId) waits.delete(id);
        if (!waits.size) this.typingWaits.delete(p.threadId);
      }
      this.syncTyping();
      this.store.data.threads[p.threadId].activeTurn = undefined; this.store.save();
      await this.invalidate(r => r.threadId === p.threadId && r.turnId === p.turn?.id, 'Turn ended');
      try { await this.relayOutcome(p.threadId, p.turn); }
      catch (error) { this.recoveryFailed(p.threadId, error); throw error; }
      await this.reconcile(p.threadId);
    }
  }
  async disconnected(): Promise<void> {
    this.typingTurns.clear();
    this.completedTurns.clear();
    this.typingWaits.clear();
    this.syncTyping();
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
    const waits = this.typingWaits.get(params.threadId) ?? new Map<string, string>();
    waits.set(String(request.id), params.turnId);
    this.typingWaits.set(params.threadId, waits);
    this.syncTyping();
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!supported.includes(request.method)) {
      await this.send(`unsupported:${this.codex.epoch}:${request.id}`, `${this.label(params.threadId)} A request requires ChatGPT: ${request.method}`); return;
    }
    const prompt: Prompt = { token: randomBytes(12).toString('hex'), id: request.id, threadId: params.threadId, turnId: params.turnId, epoch: this.codex.epoch, method: request.method, params, messages: [], deliveryKeys: [], active: true, sending: false, answers: {}, expires: params.autoResolutionMs ? Date.now() + params.autoResolutionMs : undefined };
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
    await this.send(`request:${prompt.token}`, text, { reply_markup: { inline_keyboard: [buttons] } }, prompt);
  }
  private async showQuestion(prompt: Prompt): Promise<void> {
    const q = prompt.params.questions[prompt.question!];
    const text = `${this.label(prompt.threadId)}\n${q.header || 'Question'}: ${q.question}\n${(q.options ?? []).map((o: any, i: number) => `${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`).join('\n')}\nReply to this message to enter your own answer.`;
    await this.send(`question:${prompt.token}:${prompt.question}`, text, {
      reply_markup: { inline_keyboard: (q.options ?? []).map((o: any, i: number) => [{ text: o.label.slice(0, 100), callback_data: `q:${prompt.token}:${prompt.question}:${i}` }]) },
    }, prompt);
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
        if ((key.startsWith(`request:${prompt.token}:`) || key.startsWith(`question:${prompt.token}:`)) && delivery.state === 'queued') delivery.state = 'cancelled';
      }
    }
    if (affected.length) this.store.save();
    for (const prompt of affected) await this.editExpired(prompt, reason);
    for (const prompt of affected) this.prompts.delete(prompt.token);
  }
}
