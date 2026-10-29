#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDotEnv, paths, readAccess, writeAccess, pruneExpired } from './common.js';
import { setup, service, doctor } from './setup.js';

loadDotEnv();
const [command = 'status', argument] = process.argv.slice(2);
switch (command) {
  case 'setup': await setup(); break;
  case 'service': service(argument ?? 'status'); break;
  case 'doctor': doctor(); break;
  case 'status': {
    const access = readAccess();
    if (pruneExpired(access)) writeAccess(access);
    const file = join(paths().stateDir, 'runtime.json');
    const runtime = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    console.log(`state: ${paths().stateDir}\nselected: ${runtime.selected ?? 'none'}\nwatched: ${runtime.watched?.length ?? 0}\npolicy: ${access.dmPolicy}\npaired owners: ${access.allowFrom.join(', ') || 'none'}`);
    for (const [code, pending] of Object.entries(access.pending)) console.log(`pending code=${code} user=${pending.senderId} private-chat=${pending.chatId}`);
    break;
  }
  case 'pair': {
    const access = readAccess();
    if (pruneExpired(access)) writeAccess(access);
    const pending = argument ? access.pending[argument] : undefined;
    if (!pending) throw new Error('Pairing code is missing or expired. Inspect codex-tg status locally.');
    if (access.allowFrom.some(id => id !== pending.senderId)) throw new Error('One owner only. Remove the existing account locally before pairing another.');
    if (!access.allowFrom.includes(pending.senderId)) access.allowFrom.push(pending.senderId);
    access.dmPolicy = 'allowlist'; delete access.pending[argument!]; writeAccess(access);
    console.log(`Paired user ${pending.senderId}. Send /threads to the bot.`); break;
  }
  case 'deny': {
    if (!argument) throw new Error('Usage: codex-tg deny <code>');
    const access = readAccess(); delete access.pending[argument]; writeAccess(access); console.log('Pairing request denied.'); break;
  }
  case 'allow': {
    if (!argument || !/^\d+$/.test(argument)) throw new Error('Usage: codex-tg allow <numeric-user-id>');
    const access = readAccess();
    if (access.allowFrom.some(id => id !== argument)) throw new Error('One owner only; another account is already paired.');
    access.allowFrom = [argument]; access.dmPolicy = 'allowlist'; writeAccess(access); console.log('Owner allowlist saved.'); break;
  }
  case 'remove': {
    if (!argument) throw new Error('Usage: codex-tg remove <numeric-user-id>');
    const access = readAccess(); access.allowFrom = access.allowFrom.filter(id => id !== argument); writeAccess(access);
    console.log('Account revoked. Existing conversation state remains bound to its original owner.'); break;
  }
  case 'policy': {
    if (!['pairing', 'allowlist', 'disabled'].includes(argument)) throw new Error('Usage: codex-tg policy pairing|allowlist|disabled');
    const access = readAccess(); access.dmPolicy = argument as 'pairing' | 'allowlist' | 'disabled'; writeAccess(access); console.log(`Policy: ${argument}`); break;
  }
  default: throw new Error('Use codex-tg setup|status|pair|deny|allow|remove|policy|doctor|service. Thread controls are in Telegram.');
}
