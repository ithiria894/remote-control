# Claude-Like Web UI Spec

## Goal

Build `remote-control` as a Claude Code style remote workbench:

- web-first now
- app shell later
- Codex-native transport underneath
- no session-folder scanning
- lightweight enough to stay responsive on Nicole's machine

## Product Posture

This is not a dashboard.

This is a session workbench with four persistent surfaces:

1. Session drawer
2. Session header
3. Transcript feed
4. Composer dock

Everything else is secondary.

## Layout

### 1. Session Drawer

Left rail behaves like Claude Code's session drawer.

- compact brand row
- `New session` primary action near the top
- sessions grouped by `Today`, `Yesterday`, `Older`
- each row is mostly title + short preview
- active row is highlighted, but not with loud product styling

Drawer should answer:

- which remote sessions exist
- which one is active
- which one is live / errored

Drawer should not look like:

- admin panel
- analytics dashboard
- feature launcher

## 2. Session Header

Top header is compact and contextual.

- session title
- cwd / provider / status as secondary metadata
- minimal actions only

Actions should stay compact:

- share
- session options
- collapse sidebar later

No wide control strips in the header.

## 3. Transcript Feed

Transcript is the main surface.

- user and assistant messages remain the dominant visual units
- reasoning is visible, but lighter and collapsible later
- command output and tools should feel subordinate to the conversation
- transcript should scroll cleanly and not compete with side panels

Design rule:

- user / assistant = primary
- reasoning = secondary
- tools / commands = tertiary

## 4. Composer Dock

Composer stays pinned to the bottom like a workbench dock.

- large text entry
- submit
- compact provider selector
- cwd control
- stop
- small live event strip

Advanced controls should eventually collapse behind a disclosure.

## State Model

The web UI should render app-managed sessions, not provider-global history.

- sidebar shows sessions owned by `remote-control`
- active transcript only reads the selected provider thread
- session list remains cheap even if Codex history is huge

## Mobile/App Direction

The same UI model should later map into an app shell.

Web stays the source of truth.

Native shell later should reuse these primitives:

- `SessionDrawer`
- `SessionHeader`
- `TranscriptFeed`
- `ComposerDock`

Mobile adaptations:

- drawer becomes slide-over panel
- composer stays thumb reachable
- transcript remains single-column
- live details collapse by default

## Near-Term Tasks

1. Keep tightening the current web shell toward Claude density and spacing.
2. Reduce visual weight of tool / command output in transcript.
3. Move status rail details into the composer dock over time.
4. Add collapsible live inspector only if needed, not by default.
5. Keep app-server integration native and lightweight.
