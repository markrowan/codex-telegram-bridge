import test from 'node:test';
import assert from 'node:assert/strict';
import { userUnit } from '../dist/setup.js';

test('systemd WorkingDirectory is an absolute path value, not a quoted command argument', () => {
  const unit = userUnit('/home/example/bridge release', '/home/example/node/bin/node', '/home/example/private state');
  const directory = unit.split('\n').find(line => line.startsWith('WorkingDirectory=')).slice('WorkingDirectory='.length);
  assert.equal(directory, '/home/example/bridge release');
  assert.ok(directory.startsWith('/'));
  assert.match(unit, /ExecStart=\/usr\/bin\/flock --nonblock "/);
  assert.throws(() => userUnit('/home/example\nExecStart=/bad', '/node', '/state'), /line breaks/);
});
