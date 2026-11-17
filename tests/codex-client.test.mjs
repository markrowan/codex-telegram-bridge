import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { CodexClient, RpcError } from '../dist/codex-client.js';

test('Unix transport initializes, rejects RPC errors, bounds requests and expires old epochs', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'codex-tg-socket-')), 'control.sock');
  const server = createServer(); const sockets = new WebSocketServer({ server });
  const received = [];
  sockets.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(String(data)); received.push(message);
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }));
      else if (message.method === 'reject') socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'Rejected by fixture' } }));
      else if (message.method === 'echo') socket.send(JSON.stringify({ id: message.id, result: message.params }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
  const client = new CodexClient(`ws+unix://${file}:/`, 200);
  try {
    await client.connect(); assert.equal(client.connected, true);
    assert.deepEqual(await client.request('echo', { threadId: 'fixture' }), { threadId: 'fixture' });
    await assert.rejects(client.request('reject', {}), error => error instanceof RpcError && error.code === -32600);
    await assert.rejects(client.request('timeout', {}), /uncertain/);
    assert.equal(received.filter(r => r.method === 'timeout').length, 1);
    const epoch = client.epoch;
    client.close(); await new Promise(resolve => setTimeout(resolve, 20));
    await client.connect(); assert.ok(client.epoch > epoch);
    assert.throws(() => client.respond(77, { decision: 'accept' }, epoch), /disconnected/);
    assert.equal(received.some(r => ['thread/start', 'turn/start'].includes(r.method)), false);
  } finally {
    client.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});
test('the shared-daemon fork refuses TCP endpoints', () => {
  assert.throws(() => new CodexClient('ws://127.0.0.1:17345'), /local/);
});
