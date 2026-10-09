## Breaking Changes

- algokit lite is split into `@joe-p/algokit-lite-composer`, `@joe-p/algokit-lite-app-client`, `@joe-p/algokit-lite-localnet` and `@joe-p/algokit-lite-generator`. This package re-exports all of them, so imports from `@joe-p/algokit-lite` are unchanged.
- The `algokit-lite` CLI moves to `@joe-p/algokit-lite-generator`. Run it with `npx @joe-p/algokit-lite-generator` or install that package.
- Generated clients import from `@joe-p/algokit-lite-app-client` and `@joe-p/algokit-lite-composer` instead of `@joe-p/algokit-lite`. Regenerate clients and add both packages as dependencies.
  - `ARC56GeneratorOptions.clientImportPath` is replaced by `appClientImportPath` and `composerImportPath`.
  - The CLI's `--import-path` option is replaced by `--app-client-import-path` and `--composer-import-path`.
