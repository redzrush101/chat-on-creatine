# Live tests

`npm run test:live` drives the real app, the GUI and the CLI, against your signed-in ChatGPT
account. These tests check what unit tests cannot see: what chatgpt.com actually sends, the
tunnel, and how both interfaces render a real turn.

```sh
npm run test:live                                  # every scenario, windows on your display
xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:live                      # Linux without windows on your desktop
npm run test:live -- test/live/interface.live.ts   # one file
npm run test:live -- test/live/cli-agent.live.ts   # CLI workflows and native Wayland image paste
npm run test:live -- test/live/coding-workflows.live.ts # review/init, output, resume and MCP in CLI + GUI
LIVE_DOCS=1 npm run test:live -- test/live/interface.live.ts   # also refresh docs/screenshots
```

On NixOS, run these inside `nix develop`. Quit the desktop app first. A run uses the same login
and tunnel, and it stops if the app is open.

## What a run does

- **Profile:** it copies only the login state from your profile (ChatGPT cookies, the
  keyring-encrypted `secrets.json`, the tunnel settings and MCP tokens) into a private temp
  folder. That copy is deleted when the run ends, and any copy a crashed run left behind is
  deleted when the next one starts. Your settings and history are never changed.
  `CREATINE_LIVE_PROFILE=<dir>` runs against a dedicated test profile instead.
- **Workspace:** the only approved folder is a fresh `workspace/` inside the run folder, so
  each test starts from known files.
- **Driving:** the harness starts the built app with only the main process's Node inspector and
  drives the window through Electron's own APIs; no DevTools port is opened. Tests send messages through the same API the GUI and CLI
  use, type into the real composer, and run `creatine` in the app's terminal panel.
- **Results:** everything lands in `live-results/<time>-<file>/` (ignored by git):
  - `run.log`: what the test did
  - `app.log`: the app's stdout and stderr
  - `main.log`: the app's own log
  - `<chat>.timeline.txt`: `kind | surface | name | status | text | outcome` for each chat
  - screenshots and GIFs
  - `failed-<test>.png` and `.txt` when a test fails

A run starts real ChatGPT turns and counts against your usage limits.

## Writing a scenario

```ts
const live = await Live.launch('name', { automation: { maxSteps: 2 } }); // config for this run only
await live.ready();
const id = await live.send('Read hello.txt with the local tools.');
const events = await live.until('the turn', live.idle(id), id);
expect(events.filter((event) => event.kind === 'tool').map((event) => event.name)).toContain('read');
await live.record('demo', () => live.until('the next turn', live.idle(id, 2), id)); // GIF
await live.close();
```

Assert on what a user can observe: events, files in `live.workspace` and screen text. Live
replies vary, so ask for exact output ("reply with just the number") and check that output.

## Known ChatGPT behavior (keep tests for these)

- ChatGPT speaks MCP protocol 2026-07-28, so the server must stay on `@modelcontextprotocol/server` v2.
- Stream deltas: an explicit `o` without `p` targets the root, and a bare `{"v":{"message":…}}` always starts a new message.
- ChatGPT repeats user messages (delta plus `input_message`) and renames re-uploaded files (`name(1).txt`).
- `api_tool.call_tool` arguments stream in. The connector path decides whose call it is.
- Citation source names can change after the cited text has streamed.
- Models ignore instructions inside tool results, so steered messages are re-sent after the turn.
- Logged-out chatgpt.com is a different app (`/unauth-mweb`); test signed in.
- ChatGPT refuses an account (HTTP 403 on `/backend-api/models`, then a Cloudflare check) while
  the browser runs with a DevTools port (`--remote-debugging-port`, as Playwright uses). Never
  open one for live runs.
- Under Xvfb, CDP screenshots stall; the harness captures through Electron instead.
