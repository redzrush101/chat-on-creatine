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
- The description says what changed, why, and how you checked it (including a live ChatGPT
  session when the page driver, router or stream parser changed).

## Releases

1. Move the `Unreleased` notes in [CHANGELOG.md](CHANGELOG.md) under a new version heading and
   set the same version in `package.json` and `extension/manifest.json`.
2. Commit, then tag and push: `git tag v<version> && git push origin v<version>`.
3. The Release workflow packages Windows, macOS and Linux (x64 and arm64), smoke-tests every
   package and publishes the GitHub release with checksums.
