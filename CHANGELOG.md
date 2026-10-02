# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `maxUsage` transaction param that caps the group usage a transaction's fee may pay for once simulate sets its fee. If the transaction's share of the group fee is higher, `buildGroup`, `execute` and `simulate` throw. It cannot be combined with `staticFee` or `staticUsage`.

### Fixed

- `AVMUint64` state values decode as `bigint` across the full uint64 range, matching generated client types.
- `Localnet` uses the AlgoKit LocalNet indexer port `8980` by default instead of the algod port `4001`.
- Logic errors raised during `createMethodCall` and `bareCreate` are mapped to their ARC-56 `sourceInfo` error messages instead of surfacing the raw "assert failed pc=..." text.
- `getState.map.value()` (and the generated `state.maps.*` getters) base64-decode the ARC-56 map `prefix`, as the spec requires, instead of UTF-8 encoding the prefix string. ARC-56 files that store the prefix as plain text (such as those from TEALScript before 0.106.3) must be updated to use base64.

## [0.1.2] - 2026-09-24

### Fixed

- `simulate` returns the failed simulation instead of throwing when the simulation run to determine fees fails.
- The extra fee used during simulation goes on a transaction whose fee can be adjusted, not on a transaction with a static fee.

## [0.1.1] - 2026-09-24

### Fixed

- Generated clients and the CLI import from the published package name, `@joe-p/algokit-lite`.

## [0.1.0] - 2026-09-24

- Initial release.
