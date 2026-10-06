## Features

- `Composer.simulate` takes a `skipSignatures` option that simulates the group without calling the senders' signers. Each transaction is signed with its sender's `emptyTxnSigner`, or with an empty signature if the sender has none, and `allowEmptySignatures` and `fixSigners` default to `true`. Setting either of them to `false` alongside `skipSignatures` throws. 
