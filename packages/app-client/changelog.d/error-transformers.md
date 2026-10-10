## Features

- Every `ARC56AppClient` with an app id registers an error transformer, so logic errors from its app are mapped to their ARC56 error messages in any `Composer`, not only in the client's own calls.
- Add `ARC56AppClient.unregisterErrorTransformer` to stop mapping the app's errors in other composers, so a client that is no longer used can be garbage collected.
