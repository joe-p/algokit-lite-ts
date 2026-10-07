## Fixes

- Generated clients now type `axfer`, `afrz`, `keyreg`, `appl`, `acfg`, and `txn` arguments as `algosdk.TransactionWithSigner`, matching what the composer accepts. Payment arguments continue to accept either `PaymentParams` or `algosdk.TransactionWithSigner`.
