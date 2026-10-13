# Coding workflows in the CLI

The CLI shares ChatGPT login, sessions and tool settings with the desktop. Build once with
`npm run build`, then run `./scripts/creatine` from your project (inside `nix develop` on NixOS).

## File context

```text
Review @src/main.ts against @test/main.test.ts
Explain @src/main.ts:10-40
Compare @"docs/design notes.md" with the current implementation
Describe @screenshot.png
```

Paths resolve from the working folder. Tab completes paths, including names containing spaces.
Text files are included as numbered excerpts; images, PDFs and binary files become attachments.
Excerpts are bounded to 16,000 characters per file and 48,000 total. Truncated excerpts say so;
the agent can read the rest with its tools. A missing path or invalid range leaves your draft
available to edit. Write `@@name` to send a literal `@name` without reading a file.

The same syntax works in `exec`, JSON mode and prompt templates:

```sh
./scripts/creatine exec -C ./project 'Review @src/main.ts:10-40'
git diff | ./scripts/creatine exec 'Review these changes'
```

## Shell results

`!npm test` runs in the working folder, displays output and keeps it for your next message.
Ask “Fix the failures above” and the agent receives the command, folder, output and exit status.
Pending shell output is shown in the footer; `/context` inspects it and `/context clear` removes
it. Context is bounded to the latest 24,000 characters and cleared after a successful send.

Use `!!npm test` for a local command whose output should stay out of the chat. Esc or Ctrl+C
interrupts a running shell command. Commands follow the same folder and tool policies as the GUI.

## Reusable prompt commands

Create `.creatine/prompts/audit.md` in your project:

```markdown
---
description: Review a code change
argument-hint: "[focus]"
---
Review the current git diff. Focus on ${1:-correctness}.
Read the relevant files, run appropriate checks and report concrete findings.
```

Run `/reload`, then `/audit` or `/audit "API compatibility"`. `/templates` lists each
command, its description and its file. Commands appear in completion. Templates also work
as the initial prompt and with `creatine exec '/audit correctness'`.

Personal templates live in the app profile's `prompts/` folder. On Linux the default is
`~/.config/Chat on Creatine/prompts/`; `--user-data` selects another profile. Project templates
override personal templates with the same name. Built-in commands and installed skill names
keep priority. Changing folders or resuming another project reloads its templates.

Arguments support quotes and backslash escapes. Substitutions are text only and never execute
shell commands:

| Placeholder | Meaning |
| --- | --- |
| `$1`, `$2` | A positional argument |
| `$@`, `$ARGUMENTS` | All arguments |
| `${1:-default}` | Argument or default when missing or empty |
| `${@:-default}` | All arguments or default |
| `${@:2}` | Arguments from position 2 |
| `${@:2:3}` | Three arguments starting at position 2 |

## Drafts and clipboard

Ctrl+G opens the current draft in `$VISUAL`, then `$EDITOR`, defaulting to `vi` on Unix or
Notepad on Windows. For a graphical editor, include its wait flag, such as `EDITOR='code --wait'`.
Saving and closing returns the edited draft to the CLI without sending it. A failed editor
keeps the original draft. `/editor` opens an empty draft if invoked as a command.

Ctrl+V, Alt+V and `/paste` read the system clipboard. Images appear as pending attachments in
the footer and can be sent alone or with text. Text enters the draft without sending it.
`/attach clear` removes pending files.

On Linux Wayland, install `wl-clipboard` for native clipboard access; the Nix development
shell includes it. This handles terminals whose Wayland clipboard differs from Electron's
XWayland clipboard. Without `wl-paste`, other platforms and X11 use Electron's clipboard.
Terminal shortcuts such as Ctrl+Shift+V may only paste text and cannot send image bytes to a CLI.

## Sessions and recovery

- `creatine -r` opens a searchable picker for the current folder; add `--all` for all folders.
- `creatine -r <id>` resumes an unambiguous session ID prefix; `-c` resumes the latest chat
  in the current folder.
- `--name <title>` names a new or resumed chat. `/name <title>` renames it while working.
- `/sessions <query>` filters chat titles and IDs; `/resume <query>` opens matching chats.
- `/search <text>` searches past user and assistant messages and lets you resume a match.
- Up/Down recalls the current chat's recorded prompts after resuming.
- Failed submissions return to the draft; pending attachments and shell context stay available.
- `/queue edit <id>` edits a queued message. `/queue retry <id>` requeues a failed message
  with its original attachments and ID. It cannot resend an already sent message.

Ctrl+P cycles through the account's models. Shift+Tab cycles the selected model's reasoning
levels. Stop the active turn before changing models with these shortcuts. `/model` and `/effort`
remain available for explicit selections.

## Code review and project instructions

```sh
creatine review                            # staged, unstaged and untracked changes
creatine review --base main                # committed changes since the merge base
creatine exec review --commit HEAD         # one commit, including an initial commit
creatine review --base main 'Check migrations and error handling'
```

Interactive equivalents are `/review`, `/review --base main` and `/review --commit HEAD`.
Review validates revisions before creating a chat, asks for prioritized bugs with file and line
references, and instructs the model to leave files alone. This instruction is not an OS sandbox;
the shared tool permissions still apply. Reviews run once and stop existing Goal/Loop automation
in the selected chat. Stop an active turn before starting a review.

`/init` inspects the repository and asks the agent to create a concise `AGENTS.md` with verified
build commands and conventions. If it exists, the agent is instructed to suggest improvements
without overwriting it. Root `AGENTS.md` loading was already supported by the shared backend.
`review` and `init` are now reserved command names; rename existing templates that use those names.

In the GUI, use **Coding workflows** beside the attachment control, in either a new chat or an
existing chat. Choose **Review changes** and its scope, or **Create project instructions**.
Workflow submissions preserve the composer draft and pending attachments.

## Automation output and resume

```sh
creatine exec -o answer.md 'Explain the failing test'
git diff | creatine exec --json -o findings.md -
creatine resume                            # interactive picker for this folder
creatine resume --all                      # picker across folders
creatine resume --last                     # latest chat in this folder
creatine exec resume <id> 'Continue the fix'
creatine exec resume --last --all 'Continue the latest task'
```

`-o` / `--output-last-message` saves the successful final answer and implies noninteractive
mode. It also works with `review` and JSON mode; stdout keeps its usual final text or JSONL
records. Output paths resolve from the directory where you launched the CLI, independently of
`-C`. The parent folder must exist. An unsuccessful task leaves an existing output file intact;
a successful task replaces it. `-` reads the prompt from piped stdin.

The GUI offers **Save answer** beside every completed final reply. Its existing sidebar,
project groups and message search resume the same chats used by CLI IDs.

`/copy` copies the latest completed final answer. GUI answer and code copy controls use the
same native clipboard handler. Copying on Wayland uses `wl-copy`, with Electron as the fallback
when that optional program is unavailable.

## Additional working folders

```sh
creatine -C ./app --add-dir ../library --add-dir ../tests
```

Additional folders are approved in the shared settings and remain approved after this command
exits. They do not replace the working folder. The GUI equivalent is **Settings → Setup → Add
folder**. `-i` and `--image` are aliases for `--attach`.

## MCP servers

```sh
creatine mcp add local -- node /path/to/server.mjs
creatine mcp add remote --url https://example.com/mcp
creatine mcp list
creatine mcp get local --json
creatine mcp disable local
creatine mcp enable local
creatine mcp restart local
creatine mcp remove local
```

Inside a chat, `/mcp` accepts the same arguments. `/plugins` also accepts them. Both display
connection status and discovered tools, including disabled tools. `list --json` and `get <name>
--json` produce machine-readable inspection records. Environment variable values are omitted.
Use a server's full ID when names are ambiguous. Put global flags before the MCP command:
`creatine --user-data /path/to/profile mcp list`.

These commands update the same configuration as **GUI Settings → Plugins**. Local programs run
in the shared backend, so use absolute paths for script names and filesystem arguments.
Environment settings remain in the GUI; this CLI does not configure OAuth or secret values.

Adding a server connects Creatine to it, discovers its tools and proxies them through the
Plugins MCP surface. To let ChatGPT call those tools, configure the separate Plugins tunnel
under **Connection**, then add it once in ChatGPT as **Chat on Creatine Plugins** (with your
configured connector suffix, if any). The Core connection alone does not expose external tools.
Adding a server locally does not install an app into ChatGPT. ChatGPT may need its connector
tool catalog refreshed before newly added tools appear.
