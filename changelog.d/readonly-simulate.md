## Breaking Changes

- Generated clients simulate methods marked `readonly: true` in `call` rather than sending them, so the `result` of those calls is now a `MethodSimulationResult` (`simulateResponse` and `methodResults`) instead of a `MethodExecutionResult`.

## Features

- `ARC56AppClient.simulateMethodCall` simulates a NoOp method call with `skipSignatures` and returns its decoded return value. The sender's signer is never called. A failing call throws, with the ARC56 error message when the source info has one.
- Generated clients' `call` entries for readonly methods use `simulateMethodCall`. Their `params` entries are unchanged.
- `parseLogicError` maps a logic error message from execute or simulate to the contract's ARC56 error message.
