## Features

- `ARC56AppClient.parseTransaction` decodes a confirmed `algosdk.SignedTxnInBlock`, or an inner transaction's `algosdk.SignedTxnWithAD`, as a call of one of the app's ABI methods, returning the `method`, the decoded `args`, and the decoded `returnValue`. It returns `undefined` if the transaction is not a call of the app, is a ClearState call (which ARC-4 excludes from method invocation), or its selector does not match any of the app's methods.
  - Struct args and return values are decoded to objects, and reference args are resolved to the address or ID they reference. Transaction args are `undefined`, since they are other transactions in the group.
  - App creation calls are matched by the created app ID in the transaction's apply data.
