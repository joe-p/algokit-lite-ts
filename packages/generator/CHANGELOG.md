# 0.1.0 - October 9th, 2026

## Features

- Initial release, split out of `@joe-p/algokit-lite` 0.7.0. Exports `ARC56Generator` and provides the `algokit-lite` CLI.
- Generated clients import the app client from `@joe-p/algokit-lite-app-client` and the composer and ARC-56 types from `@joe-p/algokit-lite-composer`, so projects using them need both packages, not `@joe-p/algokit-lite`.
  - `ARC56GeneratorOptions.clientImportPath` is replaced by `appClientImportPath` and `composerImportPath`.
  - The CLI's `--import-path` option is replaced by `--app-client-import-path` and `--composer-import-path`.
