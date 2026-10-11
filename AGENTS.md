# Working on Chat on Creatine

Rules for everyone who changes this repository, people and coding agents alike. `npm run check`,
the pre-commit hook and CI enforce the mechanical ones; review enforces the rest.

## The standard

**Quality over quantity. Delete before adding.** A change is judged by how much simpler the code
is afterwards, not by how much was written. The best fix is usually a few lines at the right
place, and often removes more than it adds.

- **Fix the cause at its owner.** Every fact has one module that owns it (see the code map in
  the README). Correct it there. Do not add a fallback, retry, watcher, timer, flag or mirrored
  state somewhere downstream to paper over a wrong value upstream.
- **No speculative code.** No options, parameters, abstractions or extension points that nothing
  uses yet. No handling for states the types already rule out. Three similar lines are better
  than a premature helper; a helper is right once the third real caller exists.
- **No dead code.** Remove what your change makes unused: exports, CSS classes, props, branches,
  files. Never leave commented-out code or `TODO`/`FIXME` markers; open an issue instead.
- **Stay in scope.** Do not reformat, rename or "tidy" code your change does not need. A
  focused rewrite of the area you are fixing is fine; an unrelated redesign is a separate change.

## Code style

Write code that reads like the code around it: its naming, idioms and comment density.

- **TypeScript is strict.** No `any`, no `as any`, no `@ts-ignore`/`@ts-expect-error`. Model the
  real shape in `src/shared` and let the compiler prove it. `noUnusedLocals` and
  `noUnusedParameters` are on; respect them rather than prefixing names with `_`.
- **Contracts live in `src/shared`.** Renderer ↔ main calls go only through `RendererApi`
  (`src/shared/ipc.ts`); page ↔ main messages through `src/shared/page-protocol.ts`.
- **Comments say why, not what.** A one-line doc comment on an export whose purpose is not
  obvious from its name; a short comment where the code does something surprising and the reason
  is not visible. No narration of what the next line does, no change logs in comments.
- **Errors are values the user can read.** Throw `ToolError` with a sentence the model or user can
  act on; never swallow an error silently unless the code says why that is safe.
- **Logging goes through `src/main/core/log.ts`.** No `console.*` elsewhere in `src/`.
- **Small modules.** Source files stay under 500 lines; split by responsibility, not by size.
- **Dependencies are a cost.** Add one only when the platform or an existing dependency cannot do
  the job in a reasonable amount of code, and say why in the commit.

### Renderer

- Colors, spacing, radii and shadows come from `src/renderer/styles/tokens.css`. No raw colors
  in any other stylesheet: add a token (for both themes) instead.
- Reuse the shared primitives (`Popover`, `Menu`, `MenuButton`, `InlineEdit`, `ConfirmDialog`,
  `Banner`, toasts) and lucide icons before writing new ones.
- Keep the Claude-desktop look: quiet controls, one accent, prose-first timeline, no decoration
  that carries no information.
- Every action needs an accessible name; keyboard and screen-reader use must keep working.

## Tests

Tests exist to catch regressions in behavior that matters. A test that cannot fail for a real bug
is noise, and noise is not free: it slows every run and hides the tests that count.

- **Test behavior at boundaries:** parsers, protocol and stream handling, stores, tools, policies,
  the IPC and MCP surfaces. Assert what a caller can observe, not how it is computed.
- **Do not test** trivial getters, constants, type shapes, styling, framework behavior or
  third-party libraries. No snapshot dumps, no tests that restate the implementation.
- **A bug fix comes with the test that fails without it,** in the existing test file for that
  module. One focused case per behavior; table cases instead of copy-pasted blocks.
- **Use the real thing when it is cheap:** real temp directories, real git, a real MCP client
  over loopback, as the existing tests do. Mock only what is slow, remote or nondeterministic.
- **Keep fixtures minimal** and inline. Test files stay under 400 lines.
- No `.only`, `.skip` or `.todo` in committed tests.
- Changes to the page driver, router or stream parser need a check against a signed-in ChatGPT
  session as well; unit tests cannot see what chatgpt.com actually sends.

## Privacy

This repository is public. Never commit tunnel IDs, API keys, tokens, `.env` files, personal
paths or personal email addresses, and never paste real chat content into fixtures. The checks
reject the common shapes of these; if one blocks you, remove the value at its source. Do not
bypass the hooks with `--no-verify`.

## Before you push

```sh
npm run verify          # repository rules, typecheck, tests, build
npm run build:extension # when src/page changed: the extension bundle is committed and CI compares it
```

One logical change per commit, with a subject that says what the change does in the imperative
("Keep steered messages after a stopped turn"), and a body when the reason is not obvious.
