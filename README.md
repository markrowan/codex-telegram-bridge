# Codex Telegram Bridge — shared daemon fork

A private Telegram interface to existing Codex conversations on your machine, including conversations controlled from ChatGPT. This fork extends [codenoah/codex-telegram-bridge](https://github.com/codenoah/codex-telegram-bridge), preserving its MIT license and attribution.

The bot connects to the existing Codex app-server's Unix control socket. It never launches, restarts, or reconfigures Codex. Attaching and sending messages inherit the conversation's model, working directory, sandbox and approval policy.

## Requirements

- Linux with a running Codex daemon and accessible control socket.
- Node 24 LTS and npm.
- A dedicated bot created with Telegram's **@BotFather**.
- One locally paired Telegram account, using a private bot chat.

## Build and local setup

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
# Make bin/codex-tg available on PATH, with Node on PATH.
codex-tg setup
codex-tg service install
codex-tg service start
```

`setup` prompts for the token with hidden input and asks for a project directory. Configuration and runtime state are private local files under `~/.codex/telegram-bridge`, or `CODEX_TELEGRAM_STATE_DIR`. Do not paste tokens into prompts, commit them, or pass them in process arguments.

Message the bot. It will give you a pairing code. In your local terminal, inspect and approve it:

```sh
codex-tg status
codex-tg pair <code>
```

Pairing locks the bot to that account. Additional accounts are refused. Keep the service in manual-start mode while completing acceptance tests; enable startup only after those tests pass:

```sh
codex-tg service enable
```

## Conversation controls

| Command | Behavior |
| --- | --- |
| `/threads` | Pick a loaded or recent conversation, with pagination. Selection also watches it. |
| `/watch` / `/unwatch` | Enable or stop notifications for the selected conversation. |
| `/new` | Pick a configured project and create a conversation. Repository instructions still apply. |
| `/stop` | Interrupt the selected active turn. |
| `/status` | Show selection, watched threads, connection and uncertain delivery counts. |
| `/help` | Show the controls. |

Ordinary text starts a turn when idle or steers an active turn immediately. A race is reported without silently starting or queueing another turn. Observed activity never changes your selected message target.

Watched conversations relay completed user-facing progress, plans, final replies and failures, even when work starts in ChatGPT. Messages include the thread label; raw tool output is excluded. Newly watched threads do not dump old history. Reconnection uses the stored history cursor to recover missed replies.

## Approvals and questions

Command and file requests offer one-action decisions. Explicit permission grants apply to the displayed requested permissions for the current turn only. There is no session-grant or policy-amendment control. Read the displayed request before approving it.

Structured questions offer option buttons and free-text answers bound to the current question card. Reply to that card to enter text. Resolved, completed, expired and disconnected requests cannot be answered again. Requests outside watched threads, secret questions, unknown request types, and requests whose complete details cannot be displayed remain in ChatGPT.

## Configuration and operations

`CODEX_APP_SERVER_URL` accepts only a local `ws+unix://` URL. The default resolves `$CODEX_HOME/app-server-control/app-server-control.sock`, falling back to `~/.codex`. This runtime has no TCP listener.

`CODEX_TELEGRAM_PROJECTS` is a JSON array of `{ "name": "Project", "cwd": "/absolute/project/path" }`. Setup initially suggests `~/Nullsignal` if present. It is a project selection list, not an execution sandbox; Codex's own permissions and repository instructions govern execution.

```sh
codex-tg doctor
codex-tg service status
journalctl --user -u codex-telegram-bridge.service
codex-tg service stop
codex-tg service uninstall
```

The service uses `flock` to prevent two managed instances sharing the journal. Uninstall preserves local configuration, state and releases. No skill is installed automatically. This fork removes the upstream launcher that started a separate Codex server.

## Delivery semantics

Incoming updates are journaled before Telegram's polling offset advances. Codex mutations are marked before sending; uncertain dispatches are never automatically repeated. A response is confirmed by Codex's resolved-request event. Sent messages are deduplicated by item identity/content, including during history recovery.

If a connection is lost after Telegram or Codex may have accepted an operation, `/status` reports uncertainty. Check the conversation before deciding what to resend. Exactly-once delivery across external services is not claimed. Do not delete or reset the runtime journal to clear uncertainty: doing so discards the evidence used to avoid replay.

## Validation before normal operation

Complete a real paired Telegram round trip, multi-thread selection, watched ChatGPT replies, `/new`, steering, stop, questions, approvals answered in both clients, long replies, unauthorized access rejection and restart recovery. Automated tests use mocks and isolated local WebSocket fixtures; they do not require Telegram credentials.

Attachments, voice, remote configuration changes and model changes are outside this fork's first version.
