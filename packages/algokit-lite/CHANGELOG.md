# 0.7.0 - October 7th, 2026

## Breaking Changes

- `ARC56AppClient.optInMethodCall`, `updateMethodCall`, `deleteMethodCall`, `closeOutMethodCall`, and `clearStateMethodCall` are removed. Pass `onComplete` to `methodCall` instead, e.g. `methodCall({ method: "optInToApplication", sender, onComplete: algosdk.OnApplicationComplete.OptInOC })`. `onComplete` defaults to NoOp, and the call throws if the method does not support it.
- `simulateMethodCall` uses `onComplete` from its params, which defaults to NoOp, instead of always simulating a NoOp call.

# 0.6.3 - October 7th, 2026

## Fixes

- Type ABI `byte` as `number` and consistently decode `byte[]` and `byte[N]` as `Uint8Array`, including nested tuples, structs, and state values.

# 0.6.2 - October 7th, 2026

## Fixes

- Generated local-state key and map getters now accept strings and `algosdk.Address` values as well as `AddressWithTransactionSigner`, so reads do not require a signer.

# 0.6.1 - October 7th, 2026

## Fixes

- Generated clients now type `axfer`, `afrz`, `keyreg`, `appl`, `acfg`, and `txn` arguments as `algosdk.TransactionWithSigner`, matching what the composer accepts. Payment arguments continue to accept either `PaymentParams` or `algosdk.TransactionWithSigner`.

# 0.6.0 - October 7th, 2026

## Features

- `getConstantBlockOffset` is exported. It returns the pc of the first op after the constant blocks at the start of a program.
- `parseLogicError` takes an optional `approvalProgram`, the deployed approval program, which it uses to map errors when the source info's `pcOffsetMethod` is `"cblocks"`.

## Fixes

- Logic errors of contracts whose source info uses the `"cblocks"` `pcOffsetMethod` (puya and TEALScript contracts with template variables set at deploy time) now map to the right `errorMessage`. Previously they showed the raw algod error or the message of a different op.
  - The pc offset is computed from the deployed approval program, not from the ARC-56 `byteCode`, which is a placeholder when the contract has template variables. The client keeps the program it compiled while creating an app, and otherwise fetches it from algod when a call fails.
  - Constant counts and `bytecblock` lengths are read as uvarints, so constants of 128 bytes or more, or blocks of 128 values or more, no longer give a wrong offset.
  - pcs count from the first op after the constant blocks, as puya emits them, or from the last constant block byte for TEALScript programs, which are recognised by the routing prelude TEALScript starts every approval program with.
  - When the deployed program isn't available, the raw error is thrown, rather than mapping to a possibly wrong message.

# 0.5.2 - October 7th, 2026

## Fixes

- Correct CLI help usage to show `algokit-lite <arc56.json> [options]`, matching the supported command.

# 0.5.1 - October 6th, 2026

## Fixes

- The package now ships compiled JavaScript and type declarations instead of raw TypeScript source. It imports in plain Node.js and type-checks in projects using `"moduleResolution": "NodeNext"`, `"noUnusedLocals"`, or no Node.js types (such as new Vite apps).
- Removed the use of the Node.js `Buffer` global, so the library works in browsers without a polyfill.
- `prettier` is now a dependency, so `ARC56Generator` output is always formatted.

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
