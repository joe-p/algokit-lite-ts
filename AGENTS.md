# AGENTS.md

## Changelog fragments

Every user-facing change (anything that affects the published package or the `algokit-lite` CLI, which includes all changes under `src/`) must include a [semfrag](https://github.com/joe-p/semfrag) fragment in `changelog.d/`. CI fails PRs that touch `src/` without one.

- Create a new Markdown file in `changelog.d/`, named after the issue/PR number and/or a short slug (e.g. `changelog.d/23-abi-bytes.md`, `changelog.d/readonly-simulate.md`).
- Use one of the section headings defined in `semfrag.json`; the heading determines the semver bump:
  - `## Breaking Changes` (minor bump while pre-1.0)
  - `## Features` (minor bump)
  - `## Fixes` (patch bump)
  - `## Chores` (no bump)
- Write one concise bullet per change, describing it from the user's perspective.

```md
## Fixes

- Type ABI `byte` as `number` and consistently decode `byte[]` and `byte[N]` as `Uint8Array`.
```

If a fragment already exists for the current branch, update it so it accurately reflects all changes on the branch rather than adding a duplicate.
