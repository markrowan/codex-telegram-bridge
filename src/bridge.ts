#!/usr/bin/env node
import { Bot } from 'grammy';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { loadDotEnv, paths, readAccess, gatePrivateMessage } from './common.js';
import { Store } from './store.js';
import { CodexClient } from './codex-client.js';
import { Controller, type Project, type TelegramPort } from './controller.js';

loadDotEnv();
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Configure the bot locally with codex-tg setup; never put its token in a prompt.');
const access = readAccess();
if (access.allowFrom.length > 1) throw new Error('This fork supports exactly one paired owner. Remove extra accounts locally.');
const bot = new Bot(token);
const safeError = (error: unknown) => String((error as Error)?.message ?? error).split(token).join('<redacted>');
const log = (error: unknown) => console.error(`[bridge] ${safeError(error)}`);
const store = new Store(join(paths().stateDir, 'runtime.json'));
const socket = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
const codex = new CodexClient(process.env.CODEX_APP_SERVER_URL || `ws+unix://${socket}:/`);
const configured = process.env.CODEX_TELEGRAM_PROJECTS;
const defaultProject = join(homedir(), 'Nullsignal');
const projects: Project[] = configured ? JSON.parse(configured) : existsSync(defaultProject) ? [{ name: 'Nullsignal', cwd: defaultProject }] : [];
for (const project of projects) {
  if (typeof project.name !== 'string' || !statSync(project.cwd).isDirectory()) throw new Error('Invalid project configuration');
  project.cwd = realpathSync(project.cwd);
}
if (!projects.length) throw new Error('Configure at least one project with local setup.');
const telegram: TelegramPort = {
  send: (chatId, text, extra) => bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true }, ...extra }),
  edit: async (chatId, messageId, text) => { await bot.api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } }); },
  answer: async (id, text) => { await bot.api.answerCallbackQuery(id, { text }); },
};
const allowed = () => {
  const current = readAccess();
  return current.dmPolicy !== 'disabled' && current.allowFrom.length === 1 && !!store.data.owner && current.allowFrom[0] === store.data.owner.userId;
};
const controller = new Controller(store, codex, telegram, projects, allowed);
let stopping = false;
const abort = new AbortController();
// grammy still declares the legacy abort-controller signal type; its fetch path accepts native signals.
const telegramAbort = abort.signal as unknown as NonNullable<Parameters<typeof bot.api.getUpdates>[1]>;
const delay = (ms: number) => new Promise<void>(resolve => {
  if (abort.signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); abort.signal.addEventListener('abort', done, { once: true });
});
codex.onNotification = message => { void controller.notification(message).catch(log); };
codex.onServerRequest = message => { void controller.serverRequest(message).catch(log); };
codex.onClose = () => { void controller.disconnected().catch(log); };

async function connectLoop(): Promise<void> {
  let backoff = 1000;
  while (!stopping) {
    if (!codex.connected) {
      try { await codex.connect(); await controller.reconnect(); backoff = 1000; }
      catch (error) { log(error); await delay(backoff); backoff = Math.min(backoff * 2, 30000); }
    } else await delay(1000);
  }
}

async function processUpdate(update: any): Promise<void> {
  const message = update.message ?? update.callback_query?.message;
  const from = String(update.message?.from?.id ?? update.callback_query?.from?.id ?? '');
  const chatId = String(message?.chat?.id ?? '');
  const currentAccess = readAccess();
  if (currentAccess.allowFrom.length > 1) throw new Error('Multiple owners configured; polling stopped');
  if (currentAccess.dmPolicy === 'disabled') { store.update(update.update_id, { state: 'done' }); return; }
  if (message?.chat?.type !== 'private' || from !== chatId || !from) {
    store.update(update.update_id, { state: 'done' }); return;
  }
  if (!currentAccess.allowFrom.includes(from)) {
    if (update.message) {
      const gate = gatePrivateMessage(from, chatId);
      if (gate.action === 'pair') {
        await bot.api.sendMessage(chatId, `Pair this private account locally: codex-tg pair ${gate.code}\nThe machine owner must approve the code in their terminal.`);
      }
    }
    store.update(update.update_id, { state: 'done' }); return;
  }
  if (store.data.owner && (store.data.owner.userId !== from || store.data.owner.chatId !== chatId)) {
    store.update(update.update_id, { state: 'done' }); return;
  }
  if (!store.data.owner) { store.data.owner = { userId: from, chatId }; store.save(); }
  await controller.process(update);
}

async function pollLoop(): Promise<void> {
  // Persist the batch before acknowledging any update to Telegram.
  while (!stopping) {
    try {
      for (const record of Object.values(store.data.updates).sort((a, b) => a.update.update_id - b.update.update_id)) {
        if (record.state === 'received') await processUpdate(record.update);
      }
      const updates = await bot.api.getUpdates({ offset: store.data.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, telegramAbort);
      store.receive(updates);
      for (const update of updates) {
        if (store.data.updates[String(update.update_id)]?.state === 'received') await processUpdate(update);
        store.data.offset = Math.max(store.data.offset, update.update_id + 1); store.save();
      }
      await controller.flush();
    } catch (error: any) {
      if (stopping) return;
      if (error?.error_code === 409) throw new Error('Another poller or webhook owns this bot. Stop it before running this service.');
      log(error); await delay(Math.min(60000, Math.max(1000, Number(error?.parameters?.retry_after || 2) * 1000)));
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; abort.abort(); codex.close(); });
try {
  const webhook = await bot.api.getWebhookInfo();
  if (webhook.url) throw new Error('This bot has a webhook. Use a dedicated bot or remove its webhook explicitly.');
  console.error('[bridge] Direct daemon mode; private pairing required; no daemon lifecycle control.');
  await Promise.all([connectLoop(), pollLoop()]);
} catch (error) {
  log(error); stopping = true; abort.abort(); codex.close(); process.exitCode = 1;
}
