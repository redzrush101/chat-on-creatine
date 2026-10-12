# Chat on Creatine

[![CI](https://github.com/redzrush101/chat-on-creatine/actions/workflows/ci.yml/badge.svg)](https://github.com/redzrush101/chat-on-creatine/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/redzrush101/chat-on-creatine)](https://github.com/redzrush101/chat-on-creatine/releases/latest)

Chat on Creatine lets ChatGPT read and edit files, run commands, plan work and delegate tasks
to other chats. Use the desktop app or the terminal with your ChatGPT account. Both share your
login, projects, conversations and tools.

## Desktop

Follow the conversation, inspect file changes and manage background tasks in one workspace.

| Dark | Light |
| --- | --- |
| ![Chat with an expanded edit and the background tasks panel](docs/screenshots/chat-dark.png) | ![The finished answer, plan and agent with the Changes panel](docs/screenshots/chat-light.png) |

## Terminal

Work from your project directory with streaming replies, file diffs and command output.

![A task in the Chat on Creatine CLI](docs/screenshots/cli.gif)

## Download

Get the Windows, macOS or Linux installer from the
[latest release](https://github.com/redzrush101/chat-on-creatine/releases/latest).
[Installation notes](docs/release-install.md) cover each platform.

## Setup

1. Install a release, or build from source with Node 24 (on NixOS, run `nix develop` first):
   ```sh
   npm ci
   npm run rebuild-native
   npm run tunnel-client
   npm run build
   npm start
   ```
2. **Settings → Setup**: approve a project folder.
3. **Connection**: create a tunnel in <https://platform.openai.com/settings/organization/tunnels> and a restricted API key
   with *Tunnels: Read + Use*; enter both and press **Connect**.
4. In ChatGPT: **Plugins → Add → Create MCP App → Tunnel**, pick the tunnel, *No authentication*, name it exactly
   **Chat on Creatine Core**.
5. Sign in to ChatGPT in the app's browser, pick a model and send a task.

## Coding CLI

After building from source:

```sh
./scripts/creatine -C /path/to/project
./scripts/creatine exec -C /path/to/project "Fix the failing tests"
./scripts/creatine login
```

The CLI starts Electron in the background when needed. `login` opens the ChatGPT login page;
signing in from either interface signs you in to both.

Use `/help` for commands, `/model` to choose a model, `/gui` to open the desktop app and
`/exit` to quit. Slash commands suggest completions as you type; Tab completes the name and
`?` lists the shortcuts. Replies render Markdown with tables and highlighted code. Ctrl+O opens
the full transcript with every tool's arguments and output. Esc stops a running task.

Your current directory is the working folder; `-C` selects another one. Add `--yolo` for
unrestricted tools. That setting is shared with the desktop app; `/permissions` changes it.

## Development

```sh
npm run dev         # electron-vite with HMR
npm run verify      # repository rules, typecheck, tests, build
npm run test:live   # the real app against your signed-in ChatGPT account (test/live/README.md)
npm run dist        # installers for this platform into release/ (after npm run tunnel-client)
```

Read [AGENTS.md](AGENTS.md) before changing code, and [CONTRIBUTING.md](CONTRIBUTING.md) for
pull requests and releases.

Code map: `src/cli` terminal frontend · `src/shared` contracts · `src/main/app/api.ts` shared frontend handlers ·
`src/main/mcp` server + tools · `src/main/chatgpt` browser + router ·
`src/page` in-page driver · `src/main/sessions` history/outbox/recorder · `src/main/{agents,automation}` workers,
Goal/Loop, Compact & Resume · `src/main/tunnel` connection · `src/renderer` React UI · `test/live` live tests.

Use it within OpenAI's terms; it automates your own ChatGPT session and is not affiliated with OpenAI.
