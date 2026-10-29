import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { Controller } from '../dist/controller.js';
import { RpcError } from '../dist/codex-client.js';

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'codex-tg-test-')), 'runtime.json');
  const store = new Store(file);
  Object.assign(store.data, { owner: { userId: '1', chatId: '1' }, selected: 'alpha', watched: ['alpha'], threads: { alpha: { name: 'Alpha', baseline: true } } }); store.save();
  const calls = [], responses = [], sent = [], edited = [], answers = [];
  const codex = {
    connected: true, epoch: 1, active: undefined,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/turns/list') return { data: this.active ? [{ id: this.active, status: 'inProgress', items: [] }] : [] };
      if (method === 'thread/resume') return { thread: { id: params.threadId, name: 'Existing', cwd: '/original' } };
      if (method === 'thread/loaded/list') return { data: ['alpha', 'beta'] };
      if (method === 'thread/list') return { data: [{ id: 'alpha' }, { id: 'beta' }], nextCursor: 'next' };
      if (method === 'thread/read') return { thread: { id: params.threadId, name: params.threadId, cwd: '/original', status: { type: 'idle' } } };
      if (method === 'thread/start') return { thread: { id: 'new-thread', name: 'New', cwd: params.cwd } };
      return { turn: { id: 'started', status: 'inProgress' } };
    },
    respond(id, result, epoch) { responses.push({ id, result, epoch }); },
  };
  const telegram = {
    async send(chatId, text, extra) { sent.push({ chatId, text, extra }); return { message_id: sent.length }; },
    async edit(chatId, id, text) { edited.push({ chatId, id, text }); },
    async answer(id, text) { answers.push({ id, text }); },
  };
  const controller = new Controller(store, codex, telegram, [{ name: 'Project', cwd: '/allowed/project' }]);
  const message = (id, text, overrides = {}) => ({ update_id: id, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text, ...overrides } });
  const callback = (id, data, overrides = {}) => ({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: 1 }, message: { chat: { id: 1, type: 'private' } }, data, ...overrides } });
  return { controller, store, codex, telegram, calls, responses, sent, edited, answers, message, callback, file };
}
const command = (id = 77, threadId = 'alpha') => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', itemId: 'command', command: '/usr/bin/printf harmless', cwd: '/original' } });

test('unrelated notifications never change selected target and do not relay', async () => {
  const f = fixture();
  await f.controller.notification({ method: 'turn/started', params: { threadId: 'beta', turn: { id: 'other' } } });
  await f.controller.notification({ method: 'item/completed', params: { threadId: 'beta', item: { id: 'other', type: 'agentMessage', text: 'Other answer' } } });
  assert.equal(f.store.data.selected, 'alpha'); assert.equal(f.sent.length, 0);
});
test('watch resumes without model, cwd, policy or sandbox overrides', async () => {
  const f = fixture(); await f.controller.watch('beta', true);
  assert.deepEqual(f.calls.find(c => c.method === 'thread/resume').params, { threadId: 'beta', excludeTurns: true });
  assert.equal(f.store.data.selected, 'beta'); assert.equal(f.store.data.threads.beta.cwd, '/original');
});
test('a normal message starts an idle turn with inherited settings', async () => {
  const f = fixture(); await f.controller.process(f.message(1, 'Hello'));
  assert.deepEqual(f.calls.find(c => c.method === 'turn/start').params, { threadId: 'alpha', input: [{ type: 'text', text: 'Hello', text_elements: [] }] });
  assert.equal(f.store.data.updates['1'].state, 'accepted');
});
test('active follow-ups steer once, with expected turn id', async () => {
  const f = fixture(); f.codex.active = 'running';
  await f.controller.process(f.message(1, 'Adjust direction'));
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0);
  assert.equal(f.calls.find(c => c.method === 'turn/steer').params.expectedTurnId, 'running');
  await f.controller.process(f.message(1, 'Adjust direction'));
  assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
});
test('a raced steering rejection never falls back to a new turn', async () => {
  const f = fixture(); f.codex.active = 'running';
  const original = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => { if (method === 'turn/steer') throw new RpcError('no active turn', -32600); return original(method, params); };
  await f.controller.process(f.message(1, 'Hello'));
  assert.equal(f.store.data.updates['1'].state, 'rejected'); assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});
test('uncertain dispatch survives restart and is not repeated', async () => {
  const f = fixture(); const original = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => { if (method === 'turn/start') { f.calls.push({ method, params }); throw new Error('Connection lost after acceptance'); } return original(method, params); };
  await f.controller.process(f.message(1, 'Hello'));
  assert.equal(f.store.data.updates['1'].state, 'uncertain');
  const restarted = new Controller(new Store(f.file), f.codex, f.telegram, []);
  await restarted.process(f.message(1, 'Hello'));
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('a crash while dispatching or sending becomes uncertain', () => {
  const f = fixture();
  f.store.receive([f.message(1, 'Hello')]); f.store.update(1, { state: 'dispatching' });
  f.store.data.deliveries.x = { text: 'answer', state: 'sending' }; f.store.save();
  const recovered = new Store(f.file);
  assert.equal(recovered.data.updates['1'].state, 'uncertain'); assert.equal(recovered.data.deliveries.x.state, 'uncertain');
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
});
test('watched replies initiated by ChatGPT relay once with a thread label', async () => {
  const f = fixture(); const event = { method: 'item/completed', params: { threadId: 'alpha', item: { id: 'external', type: 'agentMessage', phase: 'final_answer', text: 'External answer' } } };
  await f.controller.notification(event); await f.controller.notification(event);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Alpha.*alpha/); assert.match(f.sent[0].text, /External answer/);
});
test('tool logs are never relayed', async () => {
  const f = fixture(); await f.controller.notification({ method: 'item/completed', params: { threadId: 'alpha', item: { id: 'tool', type: 'commandExecution', aggregatedOutput: 'SECRET TOOL LOG' } } });
  assert.equal(f.sent.length, 0);
});
test('history reconciliation catches missed replies without duplicate delivery', async () => {
  const f = fixture(); const original = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => method === 'thread/turns/list' ? { backwardsCursor: 'latest', data: [{ id: 'history-turn', status: 'completed', items: [{ id: 'missed', type: 'agentMessage', text: 'Missed answer' }] }] } : original(method, params);
  await f.controller.reconcile('alpha'); await f.controller.reconcile('alpha');
  assert.equal(f.sent.length, 1); assert.equal(f.store.data.threads.alpha.cursor, 'latest');
});
test('resolved approval buttons cannot send a stale decision', async () => {
  const f = fixture(); await f.controller.serverRequest(command());
  const data = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  await f.controller.notification({ method: 'serverRequest/resolved', params: { threadId: 'alpha', requestId: 77 } });
  await f.controller.process(f.callback(1, data));
  assert.equal(f.responses.length, 0); assert.match(f.answers.at(-1).text, /expired|resolved/);
});
test('disconnect invalidates cards and does not decline on another client behalf', async () => {
  const f = fixture(); await f.controller.serverRequest(command());
  const data = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  f.codex.connected = false; await f.controller.disconnected(); f.codex.connected = true; f.codex.epoch++;
  await f.controller.process(f.callback(1, data)); assert.equal(f.responses.length, 0);
});
test('unwatched requests remain in ChatGPT', async () => {
  const f = fixture(); await f.controller.serverRequest(command(77, 'beta'));
  assert.equal(f.sent.length, 0); assert.equal(f.responses.length, 0);
});
test('explicit permission approval grants exactly the requested subset for this turn', async () => {
  const f = fixture(); const permissions = { network: { enabled: true }, fileSystem: { read: ['/one/path'] } };
  await f.controller.serverRequest({ id: 88, method: 'item/permissions/requestApproval', params: { threadId: 'alpha', turnId: 'turn', permissions } });
  const data = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  await f.controller.process(f.callback(1, data));
  assert.deepEqual(f.responses[0].result, { permissions, scope: 'turn' });
  assert.equal(f.store.data.updates['1'].state, 'dispatching');
  await f.controller.notification({ method: 'serverRequest/resolved', params: { threadId: 'alpha', requestId: 88 } });
  assert.equal(f.store.data.updates['1'].state, 'accepted');
});
test('structured questions collect options and bound free-text replies', async () => {
  const f = fixture(); await f.controller.serverRequest({ id: 99, method: 'item/tool/requestUserInput', params: { threadId: 'alpha', turnId: 'turn', questions: [
    { id: 'one', header: 'First', question: 'Pick?', options: [{ label: 'Yes', description: 'Proceed' }] },
    { id: 'two', header: 'Second', question: 'Details?' },
  ] } });
  const data = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  await f.controller.process(f.callback(1, data));
  await f.controller.process(f.message(2, 'My details', { reply_to_message: { message_id: 2 } }));
  assert.deepEqual(f.responses[0].result, { answers: { one: { answers: ['Yes'] }, two: { answers: ['My details'] } } });
});
test('callbacks from another owner or chat cannot approve', async () => {
  const f = fixture(); await f.controller.serverRequest(command());
  const data = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  await f.controller.process(f.callback(1, data, { from: { id: 2 } }));
  await f.controller.process(f.callback(2, data, { message: { chat: { id: 2, type: 'private' } } }));
  assert.equal(f.responses.length, 0);
});
test('/new creates only the selected configured project without authority overrides', async () => {
  const f = fixture(); await f.controller.process(f.message(1, '/new'));
  const data = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  await f.controller.process(f.callback(2, data));
  assert.deepEqual(f.calls.find(c => c.method === 'thread/start').params, { cwd: '/allowed/project' });
  assert.equal(f.store.data.selected, 'new-thread');
});
test('a new unmaterialized thread accepts its first real message without a dummy turn', async () => {
  const f = fixture(); const original = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => {
    if (method === 'thread/turns/list') throw new RpcError('thread is not materialized yet; history is unavailable', -32600);
    return original(method, params);
  };
  await f.controller.process(f.message(1, '/new'));
  await f.controller.process(f.callback(2, f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data));
  assert.equal(f.calls.some(c => c.method === 'thread/resume'), false);
  await f.controller.process(f.message(3, 'My first real message'));
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('uncertain Telegram sends are not retried and long replies stay within limits', async () => {
  const f = fixture(); let attempts = 0;
  f.telegram.send = async () => { attempts++; throw new Error('Lost after Telegram acceptance'); };
  const event = { method: 'item/completed', params: { threadId: 'alpha', item: { id: 'reply', type: 'agentMessage', text: 'Answer' } } };
  await assert.rejects(f.controller.notification(event));
  await f.controller.flush(); assert.equal(attempts, 1);
  const other = fixture(); await other.controller.notification({ ...event, params: { ...event.params, item: { ...event.params.item, text: 'a'.repeat(10000) } } });
  assert.equal(other.sent.length, 3); assert.ok(other.sent.every(m => m.text.length <= 3800));
  assert.ok(other.sent.every(m => m.text.startsWith('[Alpha')));
});

test('local revocation disables dispatch, approvals and outbound delivery', async () => {
  const f = fixture(); let enabled = true;
  const controller = new Controller(f.store, f.codex, f.telegram, [], () => enabled);
  await controller.serverRequest(command());
  const data = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  enabled = false;
  await controller.process(f.callback(1, data));
  await controller.process(f.message(2, 'Do work'));
  await controller.notification({ method: 'item/completed', params: { threadId: 'alpha', item: { id: 'later', type: 'agentMessage', text: 'No delivery' } } });
  assert.equal(f.responses.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 1);
});
test('a previous question button cannot answer the following question', async () => {
  const f = fixture(); await f.controller.serverRequest({ id: 99, method: 'item/tool/requestUserInput', params: { threadId: 'alpha', turnId: 'turn', questions: [
    { id: 'one', question: 'One?', options: [{ label: 'First' }] },
    { id: 'two', question: 'Two?', options: [{ label: 'Second' }] },
  ] } });
  const old = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  await f.controller.process(f.callback(1, old)); await f.controller.process(f.callback(2, old));
  assert.equal(f.responses.length, 0);
});
test('confirmed inputs and sent message bodies do not remain in the journal', async () => {
  const f = fixture(); await f.controller.process(f.message(1, 'Private input'));
  assert.deepEqual(f.store.data.updates['1'].update, { update_id: 1 });
  assert.ok(Object.values(f.store.data.deliveries).every(d => d.state !== 'sent' || d.text === ''));
});
test('queued approval cards from an old process are cancelled on restart', () => {
  const f = fixture(); f.store.enqueue('request:1:77:0', 'Old card', { reply_markup: {} });
  const recovered = new Store(f.file); assert.equal(recovered.data.deliveries['request:1:77:0'].state, 'cancelled');
});
test('confirmed old update ids cannot be replayed after journal compaction', async () => {
  const f = fixture(); f.store.data.offset = 10000; f.store.save();
  await f.controller.process(f.message(1, 'Old prompt'));
  assert.equal(f.calls.length, 0); assert.equal(f.store.data.updates['1'], undefined);
});
test('a journaled message rejected during revocation is not deferred until reauthorization', async () => {
  const f = fixture(); let enabled = false;
  const controller = new Controller(f.store, f.codex, f.telegram, [], () => enabled);
  const update = f.message(1, 'Do not defer this'); f.store.receive([update]);
  await controller.process(update); enabled = true; await controller.process(update);
  assert.equal(f.calls.length, 0); assert.equal(f.store.data.updates['1'].state, 'done');
});
