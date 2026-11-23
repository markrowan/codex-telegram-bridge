import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { Controller } from '../dist/controller.js';
import { RpcError } from '../dist/codex-client.js';

function fixture(voice) {
  const file = join(mkdtempSync(join(tmpdir(), 'codex-tg-test-')), 'runtime.json');
  const store = new Store(file);
  Object.assign(store.data, { owner: { userId: '1', chatId: '1' }, selected: 'alpha', watched: ['alpha'], threads: { alpha: { name: 'Alpha', baseline: true } } }); store.save();
  const calls = [], responses = [], sent = [], edited = [], answers = [], inline = [];
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
    async answerInline(id, draft) { inline.push({ id, draft }); },
  };
  const controller = new Controller(store, codex, telegram, [{ name: 'Project', cwd: '/allowed/project' }], undefined, voice);
  const message = (id, text, overrides = {}) => ({ update_id: id, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text, ...overrides } });
  const callback = (id, data, overrides = {}) => ({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: 1 }, message: { chat: { id: 1, type: 'private' } }, data, ...overrides } });
  return { controller, store, codex, telegram, calls, responses, sent, edited, answers, inline, message, callback, file };
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
  assert.equal(f.sent.length, 0);
});
test('active follow-ups steer once, with expected turn id', async () => {
  const f = fixture(); f.codex.active = 'running';
  await f.controller.process(f.message(1, 'Adjust direction'));
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0);
  assert.equal(f.calls.find(c => c.method === 'turn/steer').params.expectedTurnId, 'running');
  await f.controller.process(f.message(1, 'Adjust direction'));
  assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
  assert.equal(f.sent.length, 0);
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

test('rate-limited approval cards bind their buttons when flushed later', async () => {
  const f = fixture(); const send = f.telegram.send;
  let limited = true;
  f.telegram.send = async (...args) => { if (limited) throw { error_code: 429 }; return send(...args); };
  await assert.rejects(f.controller.serverRequest(command()), /rate limited/);
  assert.equal(f.sent.length, 0);
  limited = false; await f.controller.flush();
  await f.controller.process(f.callback(1, f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data));
  assert.deepEqual(f.responses, [{ id: 77, result: { decision: 'accept' }, epoch: 1 }]);
});

test('rate-limited question cards bind option buttons and free-text replies after retry', async () => {
  for (const freeText of [false, true]) {
    const f = fixture(); const send = f.telegram.send;
    f.telegram.send = async () => { throw { error_code: 429 }; };
    await assert.rejects(f.controller.serverRequest({ id: 99, method: 'item/tool/requestUserInput', params: {
      threadId: 'alpha', turnId: 'turn', questions: [{ id: 'one', question: 'Pick?', options: [{ label: 'Yes' }] }],
    } }), /rate limited/);
    f.telegram.send = send; await f.controller.flush();
    await f.controller.process(freeText ? f.message(1, 'Custom', { reply_to_message: { message_id: 1 } })
      : f.callback(1, f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data));
    assert.deepEqual(f.responses[0]?.result, { answers: { one: { answers: [freeText ? 'Custom' : 'Yes'] } } });
  }
});

test('a question awaiting retry cannot be answered by replying to its previous card', async () => {
  const f = fixture(); await f.controller.serverRequest({ id: 99, method: 'item/tool/requestUserInput', params: {
    threadId: 'alpha', turnId: 'turn', questions: [
      { id: 'one', question: 'One?', options: [{ label: 'First' }] },
      { id: 'two', question: 'Two?', options: [{ label: 'Second' }] },
    ],
  } });
  const send = f.telegram.send;
  f.telegram.send = async () => { throw { error_code: 429 }; };
  await f.controller.process(f.callback(1, f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data));
  f.telegram.send = send;
  await f.controller.process(f.message(2, 'Stale answer', { reply_to_message: { message_id: 1 } }));
  assert.equal(f.responses.length, 0);
  const card = f.sent.find(m => m.text.includes('Two?'));
  await f.controller.process(f.callback(3, card.extra.reply_markup.inline_keyboard[0][0].callback_data));
  assert.deepEqual(f.responses[0]?.result, { answers: { one: { answers: ['First'] }, two: { answers: ['Second'] } } });
});

test('approval IDs reused after restart produce fresh cards and reject old buttons', async () => {
  const f = fixture(); await f.controller.serverRequest(command());
  const oldButton = f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  const recovered = new Store(f.file);
  const controller = new Controller(recovered, f.codex, f.telegram, []);
  await controller.serverRequest(command());
  assert.equal(f.sent.length, 2);
  const newButton = f.sent[1].extra.reply_markup.inline_keyboard[0][0].callback_data;
  assert.notEqual(newButton, oldButton);
  await controller.process(f.callback(1, oldButton)); assert.equal(f.responses.length, 0);
  await controller.process(f.callback(2, newButton)); assert.equal(f.responses.length, 1);
});

test('reused approval IDs can cancel only the fresh queued card after restart', async () => {
  const f = fixture(); await f.controller.serverRequest(command());
  const oldKey = Object.keys(f.store.data.deliveries).find(k => k.startsWith('request:'));
  const recovered = new Store(f.file);
  const controller = new Controller(recovered, f.codex, f.telegram, []);
  f.telegram.send = async () => { throw { error_code: 429 }; };
  await assert.rejects(controller.serverRequest(command()), /rate limited/);
  const freshKey = Object.keys(recovered.data.deliveries).find(k => k.startsWith('request:') && k !== oldKey);
  assert.ok(freshKey);
  await controller.notification({ method: 'serverRequest/resolved', params: { threadId: 'alpha', requestId: 77 } });
  assert.equal(recovered.data.deliveries[freshKey].state, 'cancelled');
  assert.equal(recovered.data.deliveries[oldKey].state, 'sent');
});

test('requests resolved during a rate limit never deliver queued controls', async () => {
  const f = fixture(); const send = f.telegram.send;
  f.telegram.send = async () => { throw { error_code: 429 }; };
  await assert.rejects(f.controller.serverRequest(command()), /rate limited/);
  await f.controller.notification({ method: 'serverRequest/resolved', params: { threadId: 'alpha', requestId: 77 } });
  f.telegram.send = send; await f.controller.flush();
  assert.equal(f.sent.length, 0); assert.equal(f.responses.length, 0);
});


test('a multi-part approval binds only after every chunk is delivered', async () => {
  const f = fixture(); const send = f.telegram.send;
  f.telegram.send = async (...args) => { if (f.sent.length === 1) throw { error_code: 429 }; return send(...args); };
  const request = command(); request.params.command = 'x'.repeat(8000);
  await assert.rejects(f.controller.serverRequest(request), /rate limited/);
  assert.equal(f.sent.length, 1);
  f.telegram.send = send; await f.controller.flush();
  assert.equal(f.sent.length, 3);
  await f.controller.process(f.callback(1, f.sent[2].extra.reply_markup.inline_keyboard[0][0].callback_data));
  assert.equal(f.responses.length, 1);
});

test('a card resolved during an in-flight send is expired on delivery', async () => {
  const f = fixture(); const send = f.telegram.send;
  let release, started;
  const sending = new Promise(resolve => { started = resolve; });
  f.telegram.send = async (...args) => {
    started(); await new Promise(resolve => { release = resolve; }); return send(...args);
  };
  const delivery = f.controller.serverRequest(command());
  await sending;
  await f.controller.notification({ method: 'serverRequest/resolved', params: { threadId: 'alpha', requestId: 77 } });
  release(); await delivery;
  assert.equal(f.edited.at(-1).id, 1);
  await f.controller.process(f.callback(1, f.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data));
  assert.equal(f.responses.length, 0);
});

test('the picker preserves recent and loaded threads across bounded pages', async () => {
  for (const extraPage of [false, true]) {
    const f = fixture(); const original = f.codex.request.bind(f.codex);
    const loaded = Array.from({ length: 25 }, (_, i) => `loaded-${i}`);
    const recent = Array.from({ length: 8 }, (_, i) => `recent-${i}`);
    f.codex.request = async (method, params) => {
      if (method === 'thread/loaded/list') return { data: loaded };
      if (method === 'thread/list') return params.cursor
        ? { data: [{ id: 'older' }] }
        : { data: recent.map(id => ({ id })), ...(extraPage ? { nextCursor: 'older-page' } : {}) };
      return original(method, params);
    };
    await f.controller.process(f.message(1, '/threads'));
    const seen = new Set(); let update = 2; let largestPage = 0;
    for (let page = 0; page < 10; page++) {
      const card = f.sent.at(-1);
      const buttons = card.extra.reply_markup.inline_keyboard.flat();
      const choices = buttons.filter(b => b.text !== 'More threads');
      largestPage = Math.max(largestPage, choices.length);
      for (const b of choices) seen.add(b.text.split(' · ')[0]);
      const more = buttons.find(b => b.text === 'More threads');
      if (!more) break;
      await f.controller.process(f.callback(update++, more.callback_data));
      if (page === 9) assert.fail('Picker did not finish');
    }
    assert.deepEqual([...seen].sort(), [...loaded, ...recent, ...(extraPage ? ['older'] : [])].sort());
    assert.ok(largestPage <= 8);
    assert.equal(f.store.data.selected, 'alpha');
  }
});

test('recovery never checkpoints beyond replies scanned while new turns finish', async () => {
  const f = fixture();
  const turn = id => ({ id, status: 'completed', items: [{ id: `${id}-reply`, type: 'agentMessage', text: `${id} answer` }] });
  const turns = [turn('one')]; let added = false;
  f.store.data.threads.alpha.cursor = 'from:0'; f.store.save();
  f.codex.request = async (method, params) => {
    assert.equal(method, 'thread/turns/list');
    if (params.sortDirection === 'desc') return { data: [turns.at(-1)], backwardsCursor: `from:${turns.length - 1}` };
    const start = Number((params.cursor ?? 'from:0').split(':')[1]);
    const data = turns.slice(start);
    if (!added) { turns.push(turn('middle'), turn('newest')); added = true; }
    return { data };
  };
  await f.controller.reconcile('alpha');
  await f.controller.reconcile('alpha');
  assert.deepEqual(f.sent.map(m => m.text.split('\n').at(-1)), ['one answer', 'middle answer', 'newest answer']);
  assert.equal(f.store.data.threads.alpha.cursor, 'from:2');
});

test('recovery scans every history page before committing its starting checkpoint', async () => {
  const f = fixture(); const cursors = [];
  f.store.data.threads.alpha.cursor = 'old';
  f.codex.request = async (method, params) => {
    if (params.sortDirection === 'desc') return { data: [], backwardsCursor: 'checkpoint' };
    cursors.push(params.cursor);
    const last = params.cursor === 'page-2';
    return { data: [{ id: last ? 'b' : 'a', status: 'completed', items: [{ id: last ? 'b-reply' : 'a-reply', type: 'agentMessage', text: last ? 'Second' : 'First' }] }], ...(last ? {} : { nextCursor: 'page-2' }) };
  };
  await f.controller.reconcile('alpha');
  assert.deepEqual(cursors, ['old', 'page-2']);
  assert.equal(f.sent.length, 2); assert.equal(f.store.data.threads.alpha.cursor, 'checkpoint');
});

test('failed recovery delivery keeps its previous checkpoint', async () => {
  const f = fixture(); f.store.data.threads.alpha.cursor = 'old'; f.store.save();
  f.codex.request = async (method, params) => params.sortDirection === 'desc'
    ? { data: [], backwardsCursor: 'new' }
    : { data: [{ id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Answer' }] }] };
  f.telegram.send = async () => { throw { error_code: 429 }; };
  await assert.rejects(f.controller.reconcile('alpha'));
  assert.equal(f.store.data.threads.alpha.cursor, 'old');
});


test('an in-progress checkpoint is revisited after its turn completes', async () => {
  const f = fixture(); let status = 'inProgress';
  f.codex.request = async (method, params) => {
    if (params.sortDirection === 'desc') return { data: [{ id: 'live', status }], backwardsCursor: 'before-live' };
    assert.ok(params.cursor === undefined || params.cursor === 'before-live');
    return { data: [{ id: 'live', status, items: [{ id: 'reply', type: 'agentMessage', text: 'Completed reply' }] }] };
  };
  await f.controller.reconcile('alpha'); assert.equal(f.sent.length, 0);
  status = 'completed'; await f.controller.reconcile('alpha');
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Completed reply/);
});


test('assistant Markdown is journaled with formatting and delivered only once', async () => {
  const f = fixture(); const event = { method: 'item/completed', params: { threadId: 'alpha', item: { id: 'md', type: 'agentMessage', text: '**Hello** `world`' } } };
  const send = f.telegram.send;
  f.telegram.send = async () => { throw { error_code: 429 }; };
  await assert.rejects(f.controller.notification(event), /rate limited/);
  const queued = Object.values(f.store.data.deliveries).find(d => d.state === 'queued');
  assert.equal(queued.text, '[Alpha · alpha]\nHello world');
  assert.deepEqual(queued.extra.entities.map(e => e.type), ['bold', 'code']);
  const recovered = new Store(f.file);
  const controller = new Controller(recovered, f.codex, f.telegram, []);
  f.telegram.send = send; await controller.flush(); await controller.notification(event);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].extra.entities, queued.extra.entities);
});

test('approval commands remain literal even when they contain Markdown punctuation', async () => {
  const f = fixture(); const request = command(); request.params.command = 'echo **literal** _file_ `value`';
  await f.controller.serverRequest(request);
  assert.match(f.sent[0].text, /echo \*\*literal\*\* _file_ `value`/);
  assert.equal(f.sent[0].extra.entities, undefined);
});


test('history recovers failed and interrupted notices once alongside live events', async () => {
  for (const status of ['failed', 'interrupted']) {
    for (const liveFirst of [false, true]) {
      const f = fixture();
      const turn = { id: 'offline-turn', status, items: [], ...(status === 'failed' ? { error: { message: 'Recovered failure' } } : {}) };
      f.codex.request = async () => ({ data: [turn], backwardsCursor: 'checkpoint' });
      const event = { method: 'turn/completed', params: { threadId: 'alpha', turn } };
      if (liveFirst) await f.controller.notification(event);
      await f.controller.reconcile('alpha');
      assert.equal(f.sent.length, 1);
      await f.controller.notification(event);
      assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, new RegExp(`Turn ${status}`));
      if (status === 'failed') assert.match(f.sent[0].text, /Recovered failure/);
    }
  }
});

test('first watching a historical failed turn does not dump its old outcome', async () => {
  const f = fixture(); const original = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => method === 'thread/turns/list'
    ? { data: [{ id: 'old', status: 'failed', items: [], error: { message: 'Old failure' } }], backwardsCursor: 'checkpoint' }
    : original(method, params);
  await f.controller.watch('beta', false);
  assert.equal(f.sent.length, 0);
});

test('rate-limited reconnect recovery resumes while the daemon socket stays healthy', async () => {
  const f = fixture(); const original = f.codex.request.bind(f.codex); const send = f.telegram.send;
  f.store.data.threads.alpha.cursor = 'old'; f.store.save();
  f.codex.request = async (method, params) => method === 'thread/turns/list' ? {
    data: [{ id: 'offline', status: 'completed', items: [
      { id: 'first', type: 'agentMessage', text: 'First missed reply' },
      { id: 'second', type: 'agentMessage', text: 'Second missed reply' },
    ] }], backwardsCursor: 'new',
  } : original(method, params);
  f.telegram.send = async () => { throw { error_code: 429 }; };
  await assert.rejects(f.controller.reconnect(), /rate limited/);
  assert.equal(f.store.data.threads.alpha.cursor, 'old');
  f.telegram.send = send; await f.controller.flush();
  assert.equal(f.sent.length, 1);
  await f.controller.retryRecovery(Date.now() + 60000);
  assert.deepEqual(f.sent.map(m => m.text.split('\n').at(-1)), ['First missed reply', 'Second missed reply']);
  assert.equal(f.store.data.threads.alpha.cursor, 'new');
  assert.equal(f.store.data.threads.alpha.lastError, undefined);
  assert.ok(f.calls.every(c => c.method === 'thread/resume'));
});

test('history retries back off and stop after recovery succeeds', async () => {
  const f = fixture(); let calls = 0;
  f.codex.request = async () => { calls++; throw new Error('Temporarily unavailable'); };
  const before = Date.now(); await assert.rejects(f.controller.reconcile('alpha'));
  await f.controller.retryRecovery(before); assert.equal(calls, 1);
  await f.controller.retryRecovery(before + 60000); assert.equal(calls, 2);
  await f.controller.retryRecovery(before); assert.equal(calls, 2);
  f.codex.request = async () => { calls++; return { data: [], backwardsCursor: 'checkpoint' }; };
  await f.controller.retryRecovery(before + 120000); const recoveredCalls = calls;
  await f.controller.retryRecovery(before + 180000); assert.equal(calls, recoveredCalls);
});

test('unwatched or revoked recovery work is not retried', async () => {
  const f = fixture(); let allowed = true; let calls = 0;
  const controller = new Controller(f.store, f.codex, f.telegram, [], () => allowed);
  f.codex.request = async () => { calls++; throw new Error('Unavailable'); };
  await assert.rejects(controller.reconcile('alpha'));
  allowed = false; await controller.retryRecovery(Date.now() + 60000); assert.equal(calls, 1);
  allowed = true; f.store.data.watched = []; await controller.retryRecovery(Date.now() + 120000); assert.equal(calls, 1);
});


test('a turn completing during an existing scan triggers a follow-up scan', async () => {
  const f = fixture(); let release, started;
  const scanning = new Promise(resolve => { started = resolve; });
  let scans = 0;
  f.codex.request = async (method, params) => {
    if (params.sortDirection === 'desc') return { data: [], backwardsCursor: 'checkpoint' };
    scans++;
    if (scans === 1) { started(); await new Promise(resolve => { release = resolve; }); return { data: [{ id: 'turn', status: 'inProgress', items: [] }] }; }
    return { data: [{ id: 'turn', status: 'completed', items: [{ id: 'final', type: 'agentMessage', text: 'Finished during scan' }] }] };
  };
  const first = f.controller.reconcile('alpha'); await scanning;
  const next = f.controller.reconcile('alpha'); release(); await Promise.all([first, next]);
  assert.equal(scans, 2); assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Finished during scan/);
});


test('a failed watched subscription retries on a healthy socket with inherited settings', async () => {
  const f = fixture(); const original = f.codex.request.bind(f.codex); let resumes = 0;
  f.codex.request = async (method, params) => {
    if (method === 'thread/resume') {
      resumes++;
      assert.deepEqual(params, { threadId: 'alpha', excludeTurns: true });
      if (resumes === 1) throw new Error('Transient subscription failure');
    }
    return original(method, params);
  };
  await f.controller.reconnect();
  assert.equal(resumes, 1); assert.match(f.store.data.threads.alpha.lastError, /subscription failure/);
  await f.controller.retryRecovery(Date.now() + 60000);
  assert.equal(resumes, 2); assert.equal(f.store.data.threads.alpha.lastError, undefined);
  await f.controller.notification({ method: 'item/completed', params: { threadId: 'alpha', item: { id: 'restored', type: 'agentMessage', text: 'Restored activity' } } });
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Restored activity/);
  await f.controller.retryRecovery(Date.now() + 120000); assert.equal(resumes, 2);
});

test('a newly selected thread whose subscription fails is rolled back without background retries', async () => {
  const f = fixture(); const original = f.codex.request.bind(f.codex); let resumes = 0;
  f.codex.request = async (method, params) => {
    if (method === 'thread/resume') { resumes++; throw new Error('Unavailable'); }
    return original(method, params);
  };
  await assert.rejects(f.controller.watch('beta', true));
  assert.equal(f.store.data.watched.includes('beta'), false);
  await f.controller.retryRecovery(Date.now() + 60000);
  assert.equal(resumes, 1); assert.equal(f.store.data.selected, 'alpha');
});


test('voice preview pins the conversation and leaves controls available during transcription', async () => {
  const transcript = Promise.withResolvers();
  const f = fixture({ signal: new AbortController().signal, transcribe: () => transcript.promise, botId: 55 });
  await f.controller.process(f.message(1, undefined, { message_id: 100, voice: { file_id: 'file', duration: 3 } }));
  const work = f.controller.serviceVoice();
  f.codex.active = 'running';
  await f.controller.process(f.message(2, '/stop'));
  assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), true);
  f.store.data.selected = 'beta';
  transcript.resolve('A transcript');
  await work;
  const preview = f.sent.find(message => message.text.includes('A transcript'));
  assert.match(preview.text, /Alpha/);
  assert.equal(preview.extra.reply_parameters.message_id, 100);
  const query = preview.extra.reply_markup.inline_keyboard[0][0].switch_inline_query_current_chat;
  await f.controller.inlineVoiceQuery({ id: 'outside', from: { id: 2 }, chat_type: 'private', query });
  await f.controller.inlineVoiceQuery({ id: 'group', from: { id: 1 }, chat_type: 'group', query });
  await f.controller.inlineVoiceQuery({ id: 'owner', from: { id: 1 }, chat_type: 'sender', query });
  assert.deepEqual(f.inline, [{ id: 'outside', draft: undefined }, { id: 'group', draft: undefined },
    { id: 'owner', draft: { id: query.slice(6), label: '[Alpha · alpha]', text: 'A transcript' } }]);
  assert.equal(f.calls.some(call => ['turn/start', 'turn/steer'].includes(call.method)), false);
});

test('ready voice drafts survive restart and expire without retaining transcript text', async () => {
  const voice = { signal: new AbortController().signal, transcribe: async () => 'A transcript', botId: 55 };
  const f = fixture(voice);
  await f.controller.process(f.message(1, undefined, { message_id: 100, voice: { file_id: 'file', duration: 3 } }));
  await f.controller.serviceVoice();
  const store = new Store(f.file);
  const restarted = new Controller(store, f.codex, f.telegram, [], undefined, voice);
  const draft = store.data.updates['1'].voice;
  const query = { id: 'owner', from: { id: 1 }, chat_type: 'private', query: `voice:${draft.id}` };
  await restarted.inlineVoiceQuery(query);
  assert.equal(f.inline.at(-1).draft.text, 'A transcript');
  draft.expiresAt = 0;
  await restarted.inlineVoiceQuery(query);
  assert.equal(f.inline.at(-1).draft, undefined);
  await restarted.serviceVoice();
  assert.equal(store.data.updates['1'].state, 'done');
  assert.equal(readFileSync(f.file, 'utf8').includes('A transcript'), false);
  assert.match(f.sent.at(-1).text, /expired/);
});


async function voiceFixture(text = 'A transcript') {
  const voice = { signal: new AbortController().signal, transcribe: async () => text, botId: 55 };
  const f = fixture(voice);
  await f.controller.process(f.message(1, undefined, { message_id: 100, voice: { file_id: 'file', duration: 3 } }));
  await f.controller.serviceVoice();
  const draft = f.store.data.updates['1'].voice;
  const marker = `voice-status:${draft.id}`;
  const posted = (id, overrides = {}) => f.message(id, text, {
    via_bot: { id: voice.botId }, reply_markup: { inline_keyboard: [[{ text: 'Codex delivery status', callback_data: marker }]] }, ...overrides,
  });
  const outcomes = () => f.calls.filter(call => /^turn\/(start|steer)$/.test(call.method));
  return { ...f, voice, draft, marker, posted, outcomes };
}

test('only the posted inline result starts a turn in the pinned conversation', async () => {
  const f = await voiceFixture();
  f.store.data.selected = 'beta';
  assert.equal(f.outcomes().length, 0);
  const fresh = new Store(f.file);
  const restarted = new Controller(fresh, f.codex, f.telegram, [], undefined, f.voice);
  await restarted.process(f.posted(2));
  await restarted.process(f.posted(2));
  await restarted.process(f.posted(3));
  assert.deepEqual(f.outcomes(), [{ method: 'turn/start', params: { threadId: 'alpha', input: [{ type: 'text', text: 'A transcript', text_elements: [] }] } }]);
  assert.equal(fresh.data.updates['1'].state, 'accepted');
  assert.equal(readFileSync(f.file, 'utf8').includes('A transcript'), false);
  await restarted.voiceDeliveryStatus({ id: 'outside', from: { id: 2 }, data: f.marker });
  await restarted.voiceDeliveryStatus({ id: 'owner', from: { id: 1 }, data: f.marker });
  assert.deepEqual(f.answers, [{ id: 'owner', text: 'Codex accepted the transcript.' }]);
});

test('a valid inline transcript steers and bypasses Telegram command and question handling', async () => {
  const f = await voiceFixture('/stop');
  f.codex.active = 'running';
  await f.controller.process(f.posted(2, { reply_to_message: { message_id: 123 } }));
  assert.deepEqual(f.outcomes(), [{ method: 'turn/steer', params: { threadId: 'alpha', expectedTurnId: 'running', input: [{ type: 'text', text: '/stop', text_elements: [] }] } }]);
  assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), false);
});

test('wrong owners, chats, bot identities, draft IDs, text and expired results leave Codex untouched', async () => {
  const f = await voiceFixture();
  await f.controller.process(f.posted(2, { from: { id: 2 } }));
  await f.controller.process(f.posted(3, { chat: { id: 2, type: 'private' } }));
  await f.controller.process(f.posted(4, { via_bot: { id: 56 } }));
  await f.controller.process(f.posted(5, { reply_markup: undefined }));
  await f.controller.process(f.posted(6, { text: 'Other text' }));
  f.draft.expiresAt = 0;
  await f.controller.process(f.posted(7));
  assert.equal(f.outcomes().length, 0);
  assert.equal(f.draft.confirmationId, undefined);
});

test('a voice dispatch with an uncertain outcome never repeats and redacts the draft', async () => {
  const f = await voiceFixture();
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => {
    if (method === 'turn/start') { f.calls.push({ method, params }); throw new Error('Connection lost'); }
    return request(method, params);
  };
  await f.controller.process(f.posted(2));
  const fresh = new Store(f.file);
  const restarted = new Controller(fresh, f.codex, f.telegram, [], undefined, f.voice);
  await restarted.process(f.posted(2));
  await restarted.process(f.posted(3));
  assert.equal(f.outcomes().length, 1);
  assert.equal(fresh.data.updates['1'].state, 'uncertain');
  assert.equal(readFileSync(f.file, 'utf8').includes('A transcript'), false);
  await restarted.voiceDeliveryStatus({ id: 'owner', from: { id: 1 }, data: f.marker });
  assert.match(f.answers.at(-1).text, /uncertain/);
});

test('restart can resume a claimed voice confirmation before any Codex mutation', async () => {
  const f = await voiceFixture();
  const post = f.posted(2);
  f.store.receive([post]);
  f.store.update(1, { voice: { ...f.draft, confirmationId: 2 } });
  const fresh = new Store(f.file);
  const restarted = new Controller(fresh, f.codex, f.telegram, [], undefined, f.voice);
  await restarted.process(f.posted(3));
  assert.equal(f.outcomes().length, 0);
  await restarted.process(post);
  assert.equal(f.outcomes().length, 1);
  assert.equal(fresh.data.updates['1'].state, 'accepted');
});

test('disabling voice on restart clears drafts and queued transcript previews', async () => {
  const f = await voiceFixture();
  f.store.data.deliveries[`voice-preview:${f.draft.id}:0`] = { text: 'A transcript', state: 'queued' };
  f.store.save();
  const fresh = new Store(f.file);
  const restarted = new Controller(fresh, f.codex, f.telegram, []);
  await restarted.serviceVoice();
  await restarted.process(f.posted(2));
  assert.equal(f.outcomes().length, 0);
  assert.equal(fresh.data.updates['1'].state, 'done');
  assert.equal(readFileSync(f.file, 'utf8').includes('A transcript'), false);
});


test('typing replaces acceptance messages and refreshes until the tracked turn completes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  const typing = [];
  f.telegram.typing = async chatId => { typing.push(chatId); };
  await f.controller.process(f.message(1, 'Hello'));
  assert.deepEqual(typing, ['1']);
  f.codex.active = 'started';
  await f.controller.process(f.message(2, 'Follow-up'));
  assert.deepEqual(typing, ['1']);
  assert.equal(f.sent.length, 0);
  t.mock.timers.tick(4000);
  assert.deepEqual(typing, ['1', '1']);
  f.codex.active = undefined;
  await f.controller.notification({ method: 'turn/completed', params: { threadId: 'alpha', turn: { id: 'started', status: 'completed' } } });
  t.mock.timers.tick(8000);
  assert.deepEqual(typing, ['1', '1']);
});

test('typing pauses on approval, resumes on resolution, and clears on disconnect', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  let calls = 0;
  f.telegram.typing = async () => { calls++; };
  await f.controller.process(f.message(1, 'Start'));
  const request = command();
  request.params.turnId = 'started';
  await f.controller.serverRequest(request);
  assert.match(f.sent.at(-1).text, /Requested details/);
  t.mock.timers.tick(8000);
  assert.equal(calls, 1);
  await f.controller.notification({ method: 'serverRequest/resolved', params: { threadId: 'alpha', requestId: String(request.id) } });
  assert.equal(calls, 2);
  f.codex.connected = false;
  await f.controller.disconnected();
  t.mock.timers.tick(8000);
  assert.equal(calls, 2);
});

test('a completion before the start response does not leave a typing indicator running', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  let calls = 0;
  f.telegram.typing = async () => { calls++; };
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => {
    if (method === 'turn/start') {
      await f.controller.notification({ method: 'turn/completed', params: { threadId: 'alpha', turn: { id: 'started', status: 'completed' } } });
    }
    return request(method, params);
  };
  await f.controller.process(f.message(1, 'Quick answer'));
  t.mock.timers.tick(8000);
  assert.equal(calls, 0);
  assert.equal(f.store.data.updates['1'].state, 'accepted');
});

test('a confirmed voice transcript uses typing and Telegram action failures do not affect delivery', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await voiceFixture();
  let calls = 0;
  f.telegram.typing = async () => { calls++; throw new Error('Telegram action unavailable'); };
  const messages = f.sent.length;
  await f.controller.process(f.posted(2));
  assert.equal(calls, 1);
  assert.equal(f.sent.length, messages);
  assert.equal(f.store.data.updates['1'].state, 'accepted');
  t.mock.timers.tick(4000);
  assert.equal(calls, 2);
});


test('a Telegram quote routes to its recorded Codex conversation after restart', async () => {
  const f = fixture();
  await f.controller.notification({ method: 'item/completed', params: { threadId: 'alpha', item: { id: 'answer', type: 'agentMessage', text: 'First part. Mentioned clause.' } } });
  const fresh = new Store(f.file);
  fresh.data.selected = 'beta';
  const controller = new Controller(fresh, f.codex, f.telegram, []);
  const reactions = [];
  f.telegram.react = async (chatId, messageId) => { reactions.push([chatId, messageId]); };
  await controller.process(f.message(1, 'Explain this', { message_id: 41, reply_to_message: { message_id: 1, text: f.sent[0].text }, quote: { text: 'Mentioned clause.' } }));
  const start = f.calls.find(call => call.method === 'turn/start');
  assert.equal(start.params.threadId, 'alpha');
  assert.match(start.params.input[0].text, /^Explain this\n[\s\S]*Mentioned clause\.$/);
  assert.doesNotMatch(start.params.input[0].text, /First part/);
  assert.equal(fresh.data.selected, 'beta');
  assert.deepEqual(reactions, [['1', 41]]);
  await controller.process(f.message(2, 'Unknown reply', { message_id: 42, reply_to_message: { message_id: 999, text: 'Other' } }));
  assert.match(f.sent.at(-1).text, /could not be matched/);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.deepEqual(reactions, [['1', 41]]);
});

test('editing a voice preview stages text, and only the current inline result steers and gets a reaction', async () => {
  const f = await voiceFixture();
  f.store.data.selected = 'beta';
  f.codex.active = 'running';
  const reactions = [];
  f.telegram.react = async (chat, id) => { reactions.push([chat, id]); throw new Error('Emoji unavailable'); };
  await f.controller.process(f.message(2, 'Edited words', { message_id: 501, reply_to_message: { message_id: 1 } }));
  assert.equal(f.outcomes().length, 0);
  await f.controller.process(f.posted(3, { message_id: 502 }));
  assert.match(f.sent.at(-1).text, /expired or changed/);
  assert.equal(f.outcomes().length, 0);
  await f.controller.process(f.posted(4, { message_id: 503, text: 'Edited words' }));
  await f.controller.process(f.posted(5, { message_id: 504, text: 'Edited words' }));
  assert.deepEqual(f.outcomes(), [{ method: 'turn/steer', params: { threadId: 'alpha', expectedTurnId: 'running', input: [{ type: 'text', text: 'Edited words', text_elements: [] }] } }]);
  assert.equal(f.store.data.updates['1'].state, 'accepted');
  assert.deepEqual(reactions, [['1', 503]]);
  assert.match(f.sent.at(-1).text, /already submitted/);
});

test('an expired voice preview reply and a rejected steer receive no acceptance reaction', async () => {
  const f = await voiceFixture();
  const reactions = [];
  f.telegram.react = async (_, id) => { reactions.push(id); };
  f.draft.expiresAt = 0;
  await f.controller.process(f.message(2, 'Edited too late', { message_id: 501, reply_to_message: { message_id: 1 } }));
  assert.equal(f.outcomes().length, 0);
  f.codex.active = 'running';
  const request = f.codex.request.bind(f.codex);
  f.codex.request = (method, params) => method === 'turn/steer' ? Promise.reject(new RpcError('steer rejected', -32600)) : request(method, params);
  await f.controller.process(f.message(3, 'Steer', { message_id: 502 }));
  assert.deepEqual(reactions, []);
  assert.equal(f.store.data.updates['3'].state, 'rejected');
});

test('a slow voice progress message becomes the actionable preview without another post', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = Promise.withResolvers();
  const f = fixture({ signal: new AbortController().signal, transcribe: () => pending.promise, botId: 55 });
  await f.controller.process(f.message(1, undefined, { message_id: 100, voice: { file_id: 'file', duration: 120 } }));
  const work = f.controller.serviceVoice();
  t.mock.timers.tick(3000);
  assert.match(f.sent[0].text, /Transcribing/);
  pending.resolve('Transcript ending marker');
  await work;
  assert.equal(f.sent.length, 1);
  assert.match(f.edited[0].text, /Transcript ending marker/);
  await f.controller.process(f.message(2, 'Edited transcript', { message_id: 101, reply_to_message: { message_id: f.edited[0].id } }));
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  assert.match(f.edited.at(-1).text, /Edited transcript/);
});


test('a phrase correction edits the draft and never submits by itself', async () => {
  const f = await voiceFixture('Meet on Mon day at noon.');
  await f.controller.process(f.message(2, 'Mon day → Monday', { message_id: 501, reply_to_message: { message_id: 1 } }));
  assert.equal(f.outcomes().length, 0);
  assert.match(f.edited.at(-1).text, /Meet on Monday at noon/);
  await f.controller.process(f.message(3, 'Unknown phrase → Tuesday', { reply_to_message: { message_id: 1 } }));
  assert.match(f.sent.at(-1).text, /exactly once/);
  const fresh = new Store(f.file);
  const controller = new Controller(fresh, f.codex, f.telegram, [], undefined, f.voice);
  await controller.inlineVoiceQuery({ id: 'owner', from: { id: 1 }, chat_type: 'sender', query: `voice:${f.draft.id}` });
  assert.equal(f.inline.at(-1).draft.text, 'Meet on Monday at noon.');
  await controller.process(f.posted(4, { text: 'Meet on Monday at noon.' }));
  assert.equal(f.outcomes().length, 1);
});
