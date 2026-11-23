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

Ordinary text starts a turn when idle or steers an active turn immediately. Reply to a relayed Codex message to target its original conversation and include the quoted text. A 👀 reaction marks the exact message Codex accepted. After Codex accepts a message or transcript, Telegram shows the bot typing while the turn runs and pauses the indicator when action is needed. A race is reported without silently starting or queueing another turn. Observed activity never changes your selected message target.

Watched conversations relay completed user-facing progress, plans, final replies and failures, even when work starts in ChatGPT. Messages include the thread label; raw tool output is excluded. Newly watched threads do not dump old history. Reconnection uses the stored history cursor to recover missed replies.

Assistant replies render Markdown as native Telegram entities: bold, italic, strikethrough, links, inline code and fenced code blocks. Headings use bold text; lists keep their hierarchy, quotes use a visible prefix, and tables use readable text rows. Raw HTML stays literal. Formatting survives long-message splitting, including code whitespace and emoji. Approval action details remain literal so their commands and paths are displayed exactly.

## Voice notes

Voice notes are off by default. To enable them:

1. Install `ffmpeg`, build or install [`whisper-cli`](https://github.com/ggml-org/whisper.cpp), and download a multilingual GGML model such as `ggml-base.bin`.
2. In **@BotFather**, send `/setinline`, select the bridge bot, and set a placeholder such as `Send a transcript`. The bridge checks that inline mode is enabled when voice support starts.
3. In the bridge's local `.env`, set `CODEX_TELEGRAM_WHISPER_MODEL` to the absolute model path. If the executables are outside the service's `PATH`, set `CODEX_TELEGRAM_WHISPER_CLI` and `CODEX_TELEGRAM_FFMPEG` to their absolute paths. Restart the bridge service to load the settings.

Select a conversation and send a voice note in the bot's private chat. The bridge runs transcription locally and replies with a preview and the destination conversation. To make a small correction, reply to the preview with `wrong words -> corrected words`. To replace the full draft, reply with the revised text. Review the updated preview and tap **Send transcript**, then select the result in Telegram's picker. Telegram posts it under your name with a “via bot” label. That post starts or steers a turn in the conversation selected when you sent the note. The preview alone leaves Codex untouched.

Notes are limited to two minutes and 10 MiB. Whisper has a three-minute transcription deadline, and drafts expire after 30 minutes. Audio is processed in a private temporary directory and removed after processing. A Telegram personal login and a transcription API key are unnecessary. To disable voice handling, remove `CODEX_TELEGRAM_WHISPER_MODEL` and restart the bridge service.

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

General attachments, remote configuration changes and model changes are outside this fork's scope.
