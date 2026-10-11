# Changelog

## [0.2.1] - 2026-10-11

- Opening a message search result scrolls the chat to that message and marks it, instead of
  opening the chat at the bottom.
- The Changes panel stays current while the model works (like the repository bar), shows
  diffs with line numbers like the edit cards in the chat, and, for a chat folder inside a
  larger repository, lists only that folder's changes; opening one of them no longer fails.
- Windows: file paths in the Files panel are shown relative to the chat folder, and the
  in-app tunnel-client install no longer picks up Git Bash's tar. Linux: a missing `unzip`
  is named instead of failing with "spawn unzip ENOENT".
- Settings and the work panel show IPC failures without Electron's "Error invoking remote
  method" prefix, and the worker reasoning list uses ChatGPT's own effort names.

## [0.2.0] - 2026-10-11

- Faster turns: a new chat or worker starts in a preloaded ChatGPT tab (about 3 s saved),
  the model picker is only reopened when the selection changes (about 0.3 s per message),
  and a turn ends at ChatGPT's final answer instead of seconds later when its stream closes.
  The code mode tool lists every tool's arguments, so the model no longer spends its first
  call of a turn discovering them.
- A prime chat's message to a working worker now arrives within seconds as a real message
  (the worker's turn is stopped) instead of waiting for its next tool result. Worker reports
  are labelled as agent messages, are no longer re-sent as if you had written them, and
  several waiting reports reach the prime in one message. Workers can report from code mode.
- The context meter counts what the model actually received: full tool results, the opening
  context and ChatGPT's own transcript, only since the last Compact & Resume, updating
  during the turn.
- apply_patch rewrites files in place like your shell does, fixing "permission denied" for
  writable files in folders you cannot create files in (seen on macOS).
- YOLO mode (Settings → Workspace): every capability on, any path, no command policy.
- The terminal starts your account's login shell even when the app was launched from a dev
  shell, and the work panel floats over the chat in tiled or half-screen windows instead of
  not opening.

## [0.1.1] - 2026-10-11

- Match the model picker and thinking levels to the choices available in your signed-in
  ChatGPT account, hiding internal backend variants and unavailable presets.
- Apply and confirm the selected model and thinking level before every message, including
  changes within an existing chat. Report a readable error if selection fails.
- Wait for ChatGPT's model control and thinking-level pane to mount on fresh chats.
- Show ChatGPT's web sources and citations as readable links instead of raw markers.

## [0.1.0] - 2026-10-11

First release.

- ChatGPT drives your computer through local MCP tools: files, patches, a real shell, plans,
  worker chats, Goal and Loop modes, and Compact & Resume for long chats.
- Desktop UI in the style of the Claude desktop app: grouped tool steps ("Ran 4 commands, edited
  report.md +1 −1") with line-numbered diffs, a repository bar with change totals, model and
  effort pickers, a context ring, a background tasks panel, back/forward navigation and a warm
  light theme.
- Packages for Windows, macOS and Linux (x64 and arm64).
