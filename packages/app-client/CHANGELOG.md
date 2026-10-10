# 0.3.0 - October 10th, 2026

## Breaking Changes

- Require `algosdk` `^3.8.0`.

## Features

- Add `getState.box()` to get all of an app's box state, decoded with the ARC56 box keys and maps. Only boxes matching an ARC56 key or map prefix are fetched, using algod's box prefix filter and pagination.

# 0.2.0 - October 10th, 2026

## Features

- Add `getState.global()` and `getState.local(address)` to get all of an app's global or local state, decoded with the ARC56 state keys and maps.

# 0.1.0 - October 9th, 2026

## Features

- Initial release, split out of `@joe-p/algokit-lite` 0.7.0. Exports `ARC56AppClient`.
