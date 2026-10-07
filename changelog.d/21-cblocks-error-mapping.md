## Features

- `getConstantBlockOffset` is exported. It returns the pc of the first op after the constant blocks at the start of a program.
- `parseLogicError` takes an optional `approvalProgram`, the deployed approval program, which it uses to map errors when the source info's `pcOffsetMethod` is `"cblocks"`.

## Fixes

- Logic errors of contracts whose source info uses the `"cblocks"` `pcOffsetMethod` (puya and TEALScript contracts with template variables set at deploy time) now map to the right `errorMessage`. Previously they showed the raw algod error or the message of a different op.
  - The pc offset is computed from the deployed approval program, not from the ARC-56 `byteCode`, which is a placeholder when the contract has template variables. The client keeps the program it compiled while creating an app, and otherwise fetches it from algod when a call fails.
  - Constant counts and `bytecblock` lengths are read as uvarints, so constants of 128 bytes or more, or blocks of 128 values or more, no longer give a wrong offset.
  - pcs count from the first op after the constant blocks, as puya emits them, or from the last constant block byte for TEALScript programs, which are recognised by the routing prelude TEALScript starts every approval program with.
  - When the deployed program isn't available, the raw error is thrown, rather than mapping to a possibly wrong message.
