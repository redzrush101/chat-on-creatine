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

Create `.creatine/prompts/review.md` in your project:

```markdown
---
description: Review a code change
argument-hint: "[focus]"
---
Review the current git diff. Focus on ${1:-correctness}.
Read the relevant files, run appropriate checks and report concrete findings.
```

Run `/reload`, then `/review` or `/review "API compatibility"`. `/templates` lists each
command, its description and its file. Commands appear in completion. Templates also work
as the initial prompt and with `creatine exec '/review correctness'`.

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

- `creatine -r` opens a searchable picker with chats from the current folder first.
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
