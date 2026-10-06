# 0.5.0 - October 6th, 2026

## Features

- The `algokit-lite` CLI runs on Node.js (via `tsx`) and no longer requires Bun.

# 0.4.0 - October 6th, 2026

## Breaking Changes

- Generated clients simulate methods marked `readonly: true` in `call` rather than sending them, so the `result` of those calls is now a `MethodSimulationResult` (`simulateResponse` and `methodResults`) instead of a `MethodExecutionResult`.
- `Composer.simulate` throws when the group fails, with the `SimulateResponse` as the error's `cause`. Pass `throwOnFailure: false` to get the response back instead, as before.

## Features

- `ARC56AppClient.simulateMethodCall` simulates a NoOp method call with `skipSignatures` and returns its decoded return value. The sender's signer is never called. A failing call throws, with the ARC56 error message when the source info has one.
- Generated clients' `call` entries for readonly methods use `simulateMethodCall`. Their `params` entries are unchanged.
- `parseLogicError` maps a logic error message from execute or simulate to the contract's ARC56 error message.
- `Composer.simulate` takes a `skipSignatures` option that simulates the group without calling the senders' signers. Each transaction is signed with its sender's `emptyTxnSigner`, or with an empty signature if the sender has none, and `allowEmptySignatures` and `fixSigners` default to `true`. Setting either of them to `false` alongside `skipSignatures` throws.

# 0.3.0 - October 6th, 2026

## Features

- The composer now populates app call resources while simulating for fees. Accounts, apps, assets, boxes, app locals and asset holdings that app calls access without referencing are added to the group's reference arrays. Pass `populateAppCallResources: false` to the `Composer` constructor to disable it.

# 0.2.1 - October 4th, 2026

## Fixes

- Composer retries after failed fee simulations or build errors recompute fees and include each transaction only once, rather than reusing unadjusted fees or duplicating transactions.

# 0.2.0 - October 4th, 2026

## Features

- `maxUsage` transaction param that caps the group usage a transaction's fee may pay for once simulate sets its fee. If the transaction's share of the group fee is higher, `buildGroup`, `execute` and `simulate` throw. It cannot be combined with `staticFee` or `staticUsage`.

## Fixes

- Pre-built transactions added with `addTransaction()` retain their fixed fees without shifting fee metadata onto the wrong sender in mixed groups.
- ABI method calls and return decoding resolve full signatures (including `ABIMethod` instances) exactly and reject ambiguous bare names with a list of signatures. Generated clients use full-signature keys for overloaded methods, retaining bare-name keys for unique methods.
- `AVMUint64` state values decode as `bigint` across the full uint64 range, matching generated client types.
- `Localnet` uses the AlgoKit LocalNet indexer port `8980` by default instead of the algod port `4001`.
- Logic errors raised during `createMethodCall` and `bareCreate` are mapped to their ARC-56 `sourceInfo` error messages instead of surfacing the raw "assert failed pc=..." text.
- `getState.map.value()` (and the generated `state.maps.*` getters) base64-decode the ARC-56 map `prefix`, as the spec requires, instead of UTF-8 encoding the prefix string. ARC-56 files that store the prefix as plain text (such as those from TEALScript before 0.106.3) must be updated to use base64.

## Chores

- Added [semfrag](https://github.com/joe-p/semfrag) for releases
- Formatting

# 0.1.2 - September 24th, 2026

## Fixes

- `simulate` returns the failed simulation instead of throwing when the simulation run to determine fees fails.
- The extra fee used during simulation goes on a transaction whose fee can be adjusted, not on a transaction with a static fee.

# 0.1.1 - September 24th, 2026

## Fixes

- Generated clients and the CLI import from the published package name, `@joe-p/algokit-lite`.

# 0.1.0 - September 24th, 2026

## Features

- Initial release.
