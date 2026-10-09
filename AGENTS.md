# AGENTS.md

## Packages

This is a pnpm workspace. Each package under `packages/` is versioned and released independently, and has its own `CHANGELOG.md` and `changelog.d/`.

| Directory               | Package                          | Depends on                    |
| ----------------------- | -------------------------------- | ----------------------------- |
| `packages/composer`     | `@joe-p/algokit-lite-composer`   |                               |
| `packages/app-client`   | `@joe-p/algokit-lite-app-client` | composer                      |
| `packages/localnet`     | `@joe-p/algokit-lite-localnet`   | composer                      |
| `packages/generator`    | `@joe-p/algokit-lite-generator`  | composer                      |
| `packages/algokit-lite` | `@joe-p/algokit-lite`            | all of the above (re-exports) |

- Import other packages by name (e.g. `@joe-p/algokit-lite-composer`), never by a relative path into another package. The root `tsconfig.json` paths resolve them to their sources, so tests and type checks don't need a build.
- Tests live in each package's `__test__/` and may import any package. Shared fixtures are in the root `fixtures/`.
- Run every package's tests with `pnpm test`, or one package's with `pnpm test --project <directory>`.

## Changelog fragments

Every user-facing change (anything that affects a published package or the `algokit-lite` CLI, which includes all changes under `packages/*/src/`) must include a [semfrag](https://github.com/joe-p/semfrag) fragment in the `changelog.d/` of each package it affects. CI fails PRs that touch a package's `src/` without a fragment for that package.

- Create a new Markdown file in the package's `changelog.d/`, named after the issue/PR number and/or a short slug (e.g. `packages/composer/changelog.d/23-abi-bytes.md`).
- A change that affects what `@joe-p/algokit-lite` users see (e.g. a breaking change in a re-exported package) also needs a fragment in `packages/algokit-lite/changelog.d/`.
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
