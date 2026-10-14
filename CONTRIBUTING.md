# Contributing

The rules for code, tests and privacy are in [AGENTS.md](AGENTS.md); read them first. In short:
small focused changes, fixes at the owning module, no speculative code, tests only for behavior
that matters, nothing private committed.

## Setup

```sh
npm ci                      # also points git at the hooks in .githooks/
npm run tunnel-client       # pinned tunnel client for this machine
npm run dev                 # electron-vite with HMR
```

On NixOS run everything inside `nix develop`.

## Pull requests

- One logical change per pull request, rebased on `main`.
- `npm run verify` passes locally; CI runs it on Linux, macOS and Windows.
- The description says what changed, why, and how you checked it. When the page driver, router,
  stream parser or an interface changed, include `npm run test:live`.

Quit the app before live tests; they use your signed-in account and configured tunnel. The
harness copies the profile into a private temporary folder and uses a fresh project. Local
settings and history stay unchanged; real ChatGPT conversations count against account usage.
Results stay in the ignored `live-results/` folder. On Linux, use `xvfb-run -a npm run test:live`
for a headless run. Pass a file to run one scenario, for example
`npm run test:live -- test/live/performance.live.ts`.

## Releases

1. Refresh the README images with `LIVE_DOCS=1 npm run test:live -- test/live/documentation.live.ts`
   when either interface changed visibly.
2. Move the `Unreleased` notes in [CHANGELOG.md](CHANGELOG.md) under a new version heading and
   set the version in `package.json`.
3. Commit, then tag and push: `git tag v<version> && git push origin v<version>`.
4. The Release workflow packages Windows, macOS and Linux (x64 and arm64), smoke-tests every
   package and publishes the GitHub release with checksums.
