## Breaking Changes

- Require `algosdk` `^3.8.0`.

## Features

- Add `getState.box()` to get all of an app's box state, decoded with the ARC56 box keys and maps. Only boxes matching an ARC56 key or map prefix are fetched, using algod's box prefix filter and pagination.
