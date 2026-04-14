# remote-control

`remote-control` is a lightweight native-style remote workbench for coding agents.

The first target is now:

- `Web` as the primary remote surface
- `Codex app-server` as the native runtime bridge
- a future app shell on top of the same web/runtime core

The design goal is explicit:

- no session-folder polling
- no multi-provider supervisor scanning everything on disk
- no heavyweight gateway product
- keep a provider abstraction so `Gemini` or other backends can be added later

## Why this exists

Existing options split into two bad extremes:

- very large multi-channel gateways that do much more than remote coding
- thin demos that talk to a CLI SDK but do not use Codex's native app-server protocol

This project aims for the middle:

- thin transport
- native Codex slots
- robust enough to stream turns, read threads, resume work, and interrupt active turns

## Current scope

Working first cut:

- local `codex app-server` process manager
- WebSocket JSON-RPC client with native `initialize` / `initialized` handshake
- `thread/start`, `thread/list`, `thread/read`
- `turn/start`, `turn/interrupt`
- file-backed remote session store
- web session drawer that shows app-managed sessions instead of provider-global history
- Claude-like web shell: sidebar, header, transcript, composer dock
- PWA/app-shell-friendly manifest and mobile metadata
- Telegram transport kept as an optional side transport, not the product center
- provider abstraction with a Gemini placeholder
- optional native `codex app-server -c key=value` overrides during spawn

Future scope:

- Gemini provider
- installable mobile shell on top of the same core runtime
- approval UI when a provider needs it
- tighter Claude-like UI density and transcript treatment

## Local development

```bash
cp .env.example .env
npm install
npm run typecheck
npm run dev
```

Useful env vars:

- `REMOTE_CONTROL_WEB_HOST` and `REMOTE_CONTROL_WEB_PORT` control the local web workbench
- `REMOTE_CONTROL_CODEX_AUTO_SPAWN=true` lets the app spawn its own `codex app-server`
- `REMOTE_CONTROL_CODEX_APP_SERVER_URL` points at an already-running app-server
- `REMOTE_CONTROL_CODEX_CONFIG_OVERRIDES` passes one `-c key=value` override per line when auto-spawning
- `TELEGRAM_ALLOWED_CHAT_IDS` limits which chats can control the optional Telegram bot

Open the web workbench:

```bash
npm run dev
# then open http://127.0.0.1:4310
```

Design references:

- [Claude-like web UI spec](docs/claude-like-web-ui-spec.md)

## Notes

This repo intentionally starts small. The architecture is split into:

- `providers/` for Codex, Gemini, and future backends
- `runtime/` for chat/session orchestration
- `transports/` for web, Telegram, and future app entry points
- `storage/` for persisted remote session mapping
- `public/` for the current web workbench shell
