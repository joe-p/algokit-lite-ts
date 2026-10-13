## Breaking Changes

- The `Composer`'s `errorTransformers` option no longer replaces the global error transformers. They are called first, followed by the global ones registered by the time an error is thrown. Set the new `disableGlobalErrorTransformers` option to `true` to only use the given transformers.

## Features

- Generated clients have a `newComposer()` that returns a typed composer with a method for adding a call of each of the app's methods, e.g. `client.newComposer().foo({ sender, args }).execute(algod)`.
