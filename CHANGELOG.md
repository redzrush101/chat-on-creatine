# Changelog

## Unreleased

## [0.6.0] - 2026-10-14

- Share prompt templates, file context, model changes, activity and streamed event history
  between the CLI and GUI; add the GUI prompt picker and model/reasoning shortcuts.
- Consolidate 45 built-in slash commands into 27 entry points. Move session search to
  `/resume`, template controls to `/context`, worker inspection to `/tasks`, and diagnostics
  to `/status`; use Ctrl+L to clear the terminal.
- Introduce the shared Current palette for both themes, terminal output and code highlighting.
- Preserve native ChatGPT fetch responses while observing their streams, confirm preloaded
  composer and model readiness, release the observer when ChatGPT cancels its stream, and
  reduce the latency of streamed frontend updates.
- Coalesce recording writes, cache executable discovery, preserve Unicode output and stream
  updates during history loading, and cancel queued messages consistently when stopping.
- Guard default command directories, block prototype-mutating stream pointers, write private
  state with owner-only permissions and check newly added files against repository rules.
- Refresh desktop and CLI screenshots and dark recordings from a real shared coding workflow.
- Keep contributor documentation in the existing guides and prohibit standalone test/audit reports.
- Add shared code review and project-instruction workflows, final-answer file output, resume
  commands, additional working folders and CLI management of external MCP servers.

- Include `@file` excerpts and line ranges, attach inline images/PDFs, and complete quoted paths.
- Load reusable Markdown prompt commands from personal and project prompt directories, with
  arguments, defaults, completion and `/context reload`.
- Include `!command` output with the next message; keep `!!command` local and inspect pending
  shell output with `/context`.
- Edit drafts in an external editor with Ctrl+G, cycle models and reasoning with shortcuts,
  search and name sessions, and recall recorded prompts after resuming.
- Keep failed drafts, edit queued messages and retry failed inputs without duplicating them.
- Read native Wayland clipboard images through `wl-paste`; add Alt+V, show attachment
  names, and include `wl-clipboard` in the Nix shell.
- Keep narrow-terminal footer and activity rows within the available width so redraws do not
  leave growing blank gaps between the transcript and prompt.

## [0.5.1] - 2026-10-13

- Paste clipboard images into the GUI composer or the CLI with Ctrl+V. Keep pasted images
  and text in order when pressing Enter immediately after paste.
- Attach local image paths in the CLI, including quoted paths, file URLs and filenames with
  spaces. Absolute paths no longer trigger an "Unknown command" error.

## [0.5.0] - 2026-10-13

- Align local command, image and plan tools with Codex's descriptions and structured outputs.
  Add the shell `login` option while keeping existing command batches and file permissions.
- Add Codex-style code-mode cells: yield early, call `wait` for new output or completion,
  stop a running cell, and keep JSON values across fresh scripts with `store` and `load`.
  Cells and stored values stay isolated by chat; scripts keep their CPU, memory and output limits.
- Queue history appends and compaction without blocking the main process. Resolve approved
  folders, shell and tunnel executables, and terminal directories asynchronously.
- Stop rescanning partial stream lines, rebuilding event indexes and rerendering completed
  work groups during streaming. Remove redundant parsing, unused exports and flag-only tests.
- Let the MCP SDK parse and bound requests, validate browser Origins, advertise output schemas,
  and preserve scalar structured outputs for older protocol clients.

## [0.4.1] - 2026-10-12

- Show agents in the CLI the way Claude Code does: a compact start row, message rows, a finish
  line with the run time, and a list of working agents under the footer with their current step.
  Hide the main chat's agent polling so its own steps are no longer mistaken for the agent's.
- Put prompts on a shaded band and say when the CLI is only waiting for background agents.
- Redraw the prompt right after `/clear` instead of leaving the screen empty.

## [0.4.0] - 2026-10-12

- Redesign the CLI after Claude Code: tool calls read as `Bash(npm test)` or `Update(app.ts)`
  with a short result, plans as todo lists, and turns end with how long they took. A spinner line
  shows what is running, and the prompt sits between rules with model, context and folder below.
- Render full Markdown in the terminal: headings, emphasis, nested and task lists, quotes, tables
  with aligned columns and syntax-highlighted code. Long lines wrap at word boundaries.
- Open the whole transcript with Ctrl+O on a separate screen that scrolls without touching the
  conversation, and list shortcuts with `?`.
- Show web citations as their source sites, and stop printing a reply twice when ChatGPT updates
  its citations after the text.
- Stop recording ChatGPT's copy of our own tool calls as extra `api_tool.call_tool` steps in the
  GUI and CLI, and label such steps in older chats by the tool they called.
- Add `npm run test:live`: GUI and CLI scenarios against the real app and a signed-in account,
  with a throwaway profile copy, screenshots, GIFs and logs for every run.

## [0.3.2] - 2026-10-12

- Keep streamed response lines in terminal history instead of showing only the last few lines.
- Hide startup instructions when ChatGPT echoes escaped or incomplete context tags.
- Show the full tool transcript with Ctrl+O. Scroll through every tool with PgUp/PgDn without
  losing your position when new results arrive.

## [0.3.1] - 2026-10-12

- Fix Windows release checks for CLI path handling and command working directories.

## [0.3.0] - 2026-10-12

- Add a coding CLI that shares the desktop app's ChatGPT login, conversations, models,
  projects and local tools. Sign in from either interface and open the desktop app with `/gui`.
- Stream replies, command output and file diffs in the terminal. Suggest slash commands as
  you type, choose models interactively and inspect tool details with Ctrl+O.
- Run scripted tasks with `exec`, piped input, attachments and JSON output. Resume chats,
  steer tasks, use workers and Goal/Loop modes, and enable unrestricted tools with `--yolo`.
  Tools use your current directory or the folder selected with `-C`.
- Run the shared Electron backend in the background for CLI sessions. Keep terminal work
  running when the desktop window closes, and persist login changes from both interfaces.
- Simplify the README with desktop and terminal screenshots, setup and basic usage.

## [0.2.2] - 2026-10-12

- Load the account's models automatically when ChatGPT signs in, including initial setup.
  Share that catalog across tabs, removing a model-list request from every fresh chat and
  Compact & Resume successor. Concurrent authentication requests share one fetch.
- Wait for the native model picker's full selection confirmation, avoiding a fresh-chat
  confirmation race when its slider becomes ready before the selected effort is published.
- Share the final-answer completion rule between the router and page driver, letting queued
  messages proceed while metadata is still arriving. Native send controls still gate delivery.
- Clear the streaming dot when a response ends or the app restarts, and prevent a delayed
  conversation snapshot from marking a completed answer as streaming again.
- Use only the built-in browser. Remove the companion Chrome extension, bridge, host switch,
  extension settings and extension release artifacts; keep tab state in one browser owner.
- Share the model pickers' menu controls and model-selection contract. Focus menus when they
  become visible and return focus to the trigger on dismissal.
- Interrupt piped command trees on Windows as well as macOS and Linux. Close a loading tab's
  pending commands immediately, and keep the tray with its window so closing cannot hide the
  app when a tray could not be created.
- Share UTF-8 file decoding and size formatting between tools and the file viewer. Treat
  invalid bytes as binary while allowing a valid character to cross a read limit. Remove
  unused page commands, usage placeholders and account-email plumbing.

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
