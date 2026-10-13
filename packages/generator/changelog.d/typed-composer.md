## Features

- Generate a typed composer, returned by the client's `newComposer()`, with a method for adding a call of each of the app's methods, e.g. `client.newComposer().foo({ sender, args }).execute(algod)`. Methods that collide with composer members, including inherited members, use their full ABI signature.
