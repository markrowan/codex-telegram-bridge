# Security Policy

Codex Telegram Bridge gives Telegram users access to a local Codex session that
can run commands and edit files. Treat a paired Telegram account as remote
control of the configured project directory.

## Supported Versions

Security fixes are applied to the latest version on the default branch.

## Reporting a Vulnerability

Please open a private advisory or contact the maintainer privately before
publishing details. Include:

- affected version or commit
- steps to reproduce
- expected impact
- suggested mitigation, if known

## Hardening Checklist

- Use the existing private Unix control socket; this fork refuses TCP endpoints.
- Use `codex-tg policy allowlist` after pairing your Telegram account.
- Keep `~/.codex/telegram-bridge/.env` private.
- Keep the runtime journal private and intact; uncertain operations must not be replayed blindly.
- Pair one private account locally. Revocation or disabled policy blocks dispatch and outbound delivery.
- Use a dedicated Telegram bot token for this bridge.
- Review `/file` and `/diff` output before forwarding it elsewhere.
