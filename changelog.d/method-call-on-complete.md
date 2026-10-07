## Breaking Changes

- `ARC56AppClient.optInMethodCall`, `updateMethodCall`, `deleteMethodCall`, `closeOutMethodCall`, and `clearStateMethodCall` are removed. Pass `onComplete` to `methodCall` instead, e.g. `methodCall({ method: "optInToApplication", sender, onComplete: algosdk.OnApplicationComplete.OptInOC })`. `onComplete` defaults to NoOp, and the call throws if the method does not support it.
- `simulateMethodCall` uses `onComplete` from its params, which defaults to NoOp, instead of always simulating a NoOp call.
