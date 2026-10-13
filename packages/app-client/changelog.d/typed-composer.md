## Features

- Make `ARC56AppClient.newComposer()` public, returning a composer that uses the client's suggested params and maps errors from its app.

## Fixes

- Map errors from apps whose clients were created after a client's composer, e.g. when adding another app's calls to a typed composer.
