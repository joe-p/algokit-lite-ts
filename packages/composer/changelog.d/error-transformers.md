## Features

- Add error transformers, which map errors thrown by `buildGroup`, `execute` and `simulate`. Register one for every composer with `Composer.registerErrorTransformer`, or give a composer its own with the `errorTransformers` constructor option.
- Add `Composer.unregisterErrorTransformer` to remove a transformer added with `Composer.registerErrorTransformer`.
