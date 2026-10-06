## Breaking Changes

- `Composer.simulate` throws when the group fails, with the `SimulateResponse` as the error's `cause`. Pass `throwOnFailure: false` to get the response back instead, as before.
