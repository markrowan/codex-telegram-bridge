import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { paths, readAccess } from './common.js';

async function secret(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Run setup in a local interactive terminal');
  process.stdout.write(question); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', input); process.stdout.write('\n'); };
    const input = (chunk: Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === '\u0003') { done(); reject(new Error('Setup cancelled')); return; }
        if (ch === '\r' || ch === '\n') { done(); resolve(value); return; }
        if (ch === '\u007f') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    process.stdin.on('data', input);
  });
}
export async function setup(): Promise<void> {
  console.log('Create a dedicated Telegram bot with @BotFather. Enter its token here; input is hidden.');
  const token = await secret('Bot token: ');
  if (!/^\d+:[\w-]+$/.test(token)) throw new Error('The token format is invalid');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let project;
  try { project = await readline.question(`Project directory [${join(homedir(), 'Nullsignal')}]: `); }
  finally { readline.close(); }
  const cwd = realpathSync(project.trim() || join(homedir(), 'Nullsignal'));
  if (!statSync(cwd).isDirectory()) throw new Error('Project must be a directory');
  mkdirSync(paths().stateDir, { recursive: true, mode: 0o700 });
  const file = paths().envFile;
  const old = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(line => !/^(TELEGRAM_BOT_TOKEN|CODEX_TELEGRAM_PROJECTS)=/.test(line)) : [];
  const body = [...old.filter(Boolean), `TELEGRAM_BOT_TOKEN=${token}`, `CODEX_TELEGRAM_PROJECTS=${JSON.stringify([{ name: cwd.split('/').pop(), cwd }])}`, ''].join('\n');
  writeFileSync(file, body, { mode: 0o600 }); chmodSync(file, 0o600);
  console.log('Saved private local configuration. Install the user service, start it for acceptance, message the bot, then approve its pairing code locally.');
}
function systemdValue(value: string): string { return '"' + value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '') + '"'; }
export function userUnit(root: string, node: string, state: string): string {
  if (![root, node, state].every(value => value.startsWith('/') && !/[\r\n]/.test(value))) throw new Error('Service paths must be absolute and contain no line breaks');
  return `[Unit]\nDescription=Telegram control for the existing Codex daemon\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=${systemdValue('CODEX_TELEGRAM_STATE_DIR=' + state)}\nExecStart=/usr/bin/flock --nonblock ${systemdValue(join(state, 'bridge.lock'))} ${systemdValue(node)} ${systemdValue(join(root, 'dist', 'bridge.js'))}\nWorkingDirectory=${root.replace(/%/g, '%%')}\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n`;
}
export function service(command: string): void {
  if (process.platform !== 'linux') throw new Error('User-service installation currently supports Linux only');
  const directory = join(homedir(), '.config', 'systemd', 'user');
  const file = join(directory, 'codex-telegram-bridge.service');
  const systemctl = (args: string[]) => execFileSync('/usr/bin/systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (command === 'install') {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(paths().stateDir, { recursive: true, mode: 0o700 });
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const body = userUnit(root, process.execPath, paths().stateDir);
    if (existsSync(file) && readFileSync(file, 'utf8') !== body) throw new Error('An existing service differs; inspect it before replacing it');
    writeFileSync(file, body, { mode: 0o600 }); systemctl(['daemon-reload']);
    console.log('Installed inactive service. Use service start for acceptance; enable only after acceptance passes.');
  } else if (command === 'uninstall') {
    systemctl(['disable', '--now', 'codex-telegram-bridge.service']);
    if (existsSync(file)) unlinkSync(file);
    systemctl(['daemon-reload']); console.log('Removed user service. Configuration, journal and releases were preserved.');
  } else if (['start', 'stop', 'restart', 'status', 'enable'].includes(command)) {
    if (['start', 'restart', 'enable'].includes(command) && !existsSync(paths().envFile)) throw new Error('Run local setup before starting the bot');
    systemctl([command, 'codex-telegram-bridge.service']);
  } else throw new Error('Usage: codex-tg service install|start|stop|restart|status|enable|uninstall');
}
export function doctor(): void {
  const socket = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
  console.log(`Node: ${process.version}\nDaemon socket exists: ${existsSync(socket)}\nLocal token file exists: ${existsSync(paths().envFile)}\nPaired owners: ${readAccess().allowFrom.length}`);
  const runtime = join(paths().stateDir, 'runtime.json');
  if (existsSync(runtime)) {
    const state = JSON.parse(readFileSync(runtime, 'utf8'));
    console.log(`Watched threads: ${state.watched?.length ?? 0}; uncertain dispatches: ${Object.values(state.updates ?? {}).filter((r: any) => r.state === 'uncertain').length}; uncertain deliveries: ${Object.values(state.deliveries ?? {}).filter((r: any) => r.state === 'uncertain').length}`);
  }
}
