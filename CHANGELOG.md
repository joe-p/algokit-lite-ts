# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `maxUsage` transaction param that caps the group usage a transaction's fee may pay for once simulate sets its fee. If the transaction's share of the group fee is higher, `buildGroup`, `execute` and `simulate` throw. It cannot be combined with `staticFee` or `staticUsage`.

### Fixed

- Logic errors raised during `createMethodCall` and `bareCreate` are mapped to their ARC-56 `sourceInfo` error messages instead of surfacing the raw "assert failed pc=..." text.

## [0.1.2] - 2026-09-24

### Fixed

- `simulate` returns the failed simulation instead of throwing when the simulation run to determine fees fails.
- The extra fee used during simulation goes on a transaction whose fee can be adjusted, not on a transaction with a static fee.

## [0.1.1] - 2026-09-24

### Fixed

- Generated clients and the CLI import from the published package name, `@joe-p/algokit-lite`.

## [0.1.0] - 2026-09-24

- Initial release.
