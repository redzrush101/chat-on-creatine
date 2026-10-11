# Changelog

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
