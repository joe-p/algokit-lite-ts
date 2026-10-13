## Breaking Changes

- The `errorTransformers` composer option no longer replaces the global error transformers. They are called first, followed by the global ones registered by the time an error is thrown. Set the new `disableGlobalErrorTransformers` option to `true` to only use the given transformers.
