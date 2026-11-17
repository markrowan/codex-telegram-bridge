// Opt-in local proof. Creates only disposable conversations; never starts Telegram.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../dist/store.js';
import { Controller } from '../dist/controller.js';
import { CodexClient } from '../dist/codex-client.js';

const directory = mkdtempSync(join(tmpdir(), 'codex-telegram-proof-'));
const url = process.env.CODEX_APP_SERVER_URL || `ws+unix://${join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control/app-server-control.sock')}:/`;
const client = new CodexClient(url);
const observer = new CodexClient(url);
const store = new Store(join(directory, 'runtime.json'));
store.data.owner = { userId: '1', chatId: '1' }; store.save();
const sent = [], wireResponses = [], waiters = [];
let nextUpdate = 1;
const receipt = { directory, tests: {}, errors: [] };
const persist = () => writeFileSync(join(directory, 'proof.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
function emit(kind, value) {
  for (const waiter of [...waiters]) if (waiter.kind === kind && waiter.predicate(value)) { clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); }
}
function wait(kind, predicate = () => true, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const waiter = { kind, predicate, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${kind}`)); }, timeout) };
    waiters.push(waiter);
  });
}
const telegram = {
  async send(chatId, text, extra) { const message = { message_id: sent.length + 1, chatId, text, extra }; sent.push(message); return message; },
  async edit() {}, async answer() {},
};
const controller = new Controller(store, client, telegram, [{ name: 'Proof', cwd: directory }]);
const originalRespond = client.respond.bind(client);
client.respond = (id, result, epoch) => { wireResponses.push({ id, result }); originalRespond(id, result, epoch); };
client.onNotification = message => {
  void controller.notification(message).then(() => emit(message.method, message.params)).catch(error => { receipt.errors.push(error.message); persist(); });
};
client.onServerRequest = request => {
  void controller.serverRequest(request).then(() => emit('request', request)).catch(error => { receipt.errors.push(error.message); persist(); });
};
client.onClose = () => { void controller.disconnected(); };
const observerRequests = new Map();
observer.onServerRequest = request => observerRequests.set(request.id, request);
const message = text => controller.process({ update_id: nextUpdate++, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text } });
const click = data => controller.process({ update_id: nextUpdate++, callback_query: { id: 'proof-callback', from: { id: 1 }, message: { chat: { id: 1, type: 'private' } }, data } });
const commandText = 'Controlled bridge proof. Call exec_command exactly once with command /usr/bin/printf CODEX_TELEGRAM_PROOF and sandbox_permissions=require_escalated, justification="Harmless bridge proof". Do not use alternatives, write files, or access the network. After the result or denial, reply briefly.';
const latestCard = () => sent.findLast(m => m.extra?.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data?.startsWith('a:')));
const watchdog = setTimeout(() => { receipt.errors.push('Overall proof watchdog expired'); persist(); process.exit(2); }, 180000);
try {
  await client.connect();
  const models = await client.request('model/list', {});
  const model = models.data.find(m => m.id === 'gpt-6.1-sol')?.id || models.data[0]?.id;
  const started = await client.request('thread/start', { cwd: directory, model, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
  const id = started.thread.id; receipt.threadId = id; receipt.model = model; persist();
  await controller.watch(id, true, started.thread);
  let ended = wait('turn/completed', p => p.threadId === id);
  await message('Reply exactly CODEX_TELEGRAM_REPLY. Do not use tools.');
  assert.equal((await ended).turn.status, 'completed');
  assert.ok(sent.some(m => m.text.includes('CODEX_TELEGRAM_REPLY'))); receipt.tests.replyRelay = true; persist();
  const inherited = await client.request('thread/resume', { threadId: id, excludeTurns: true });
  for (const key of ['model', 'approvalPolicy', 'approvalsReviewer', 'sandbox']) if (started[key] !== undefined) assert.deepEqual(inherited[key], started[key]);
  receipt.tests.inheritedSettings = true;

  let pending = wait('request', r => r.method === 'item/commandExecution/requestApproval');
  ended = wait('turn/completed', p => p.threadId === id);
  await message(commandText);
  const approval = await pending;
  const command = approval.params.command;
  if (!/^(?:\/usr\/bin\/bash|\/bin\/bash) -lc '\/usr\/bin\/printf CODEX_TELEGRAM_PROOF'$/.test(command)) throw new Error('Proof refused to approve an unexpected command shape');
  await message('For this proof the final answer after the command must be exactly CODEX_TELEGRAM_STEERED.');
  await click(latestCard().extra.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal((await ended).turn.status, 'completed');
  assert.ok(sent.some(m => m.text.includes('CODEX_TELEGRAM_STEERED')));
  receipt.tests.steeringAndHarmlessApproval = true; persist();

  pending = wait('request', r => r.method === 'item/commandExecution/requestApproval');
  ended = wait('turn/completed', p => p.threadId === id);
  await message(commandText); await pending; await message('/stop');
  assert.equal((await ended).turn.status, 'interrupted'); receipt.tests.interrupt = true; persist();

  await observer.connect(); await observer.request('thread/resume', { threadId: id, excludeTurns: true });
  pending = wait('request', r => r.method === 'item/commandExecution/requestApproval');
  ended = wait('turn/completed', p => p.threadId === id);
  await message(commandText); const external = await pending;
  const stale = latestCard().extra.reply_markup.inline_keyboard[0][0].callback_data;
  const resolved = wait('serverRequest/resolved', p => String(p.requestId) === String(external.id));
  observer.respond(external.id, { decision: 'decline' }, observer.epoch); await resolved;
  const before = wireResponses.length; await click(stale); assert.equal(wireResponses.length, before);
  await ended; receipt.tests.crossClientResolution = true; persist();

  // A different client initiates this turn. The bridge still relays its final item.
  ended = wait('turn/completed', p => p.threadId === id);
  await observer.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Reply exactly EXTERNAL_CLIENT_REPLY. Do not use tools.' }] });
  await ended; assert.ok(sent.some(m => m.text.includes('EXTERNAL_CLIENT_REPLY')));
  receipt.tests.externalClientReply = true; persist();
  pending = wait('request', r => r.method === 'item/tool/requestUserInput');
  ended = wait('turn/completed', p => p.threadId === id);
  await client.request('turn/start', { threadId: id, collaborationMode: { mode: 'plan', settings: { model, developer_instructions: null, reasoning_effort: 'low' } }, input: [{ type: 'text', text: 'For a controlled bridge proof, use request_user_input to ask exactly one multiple-choice question with options Yes and No. Do not ask only in prose. Once answered, acknowledge the selected answer. Do not use other tools.' }] });
  await pending;
  const question = sent.findLast(m => m.extra?.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data?.startsWith('q:')));
  assert.ok(question); await click(question.extra.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal((await ended).turn.status, 'completed'); receipt.tests.structuredQuestion = true; persist();
  assert.deepEqual(receipt.errors, []);
  console.log(JSON.stringify({ tests: receipt.tests, receipt: join(directory, 'proof.json') }, null, 2));
} catch (error) {
  receipt.errors.push(error.stack); persist(); console.error(error.message); console.error(`Proof receipt: ${join(directory, 'proof.json')}`); process.exitCode = 1;
} finally {
  clearTimeout(watchdog); for (const w of waiters) clearTimeout(w.timer);
  observer.close(); client.close(); persist();
}
