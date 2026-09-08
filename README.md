# AlgoKit Lite

This library is a light wrapper around algosdk to make it easier to interact with Algorand. The main features are

- Ergonomic ARC56-compatible transaction group composer
- ARC56 app client
- Typed ARC56 app client generator
- Localnet account generation and funding

> [!IMPORTANT]
> This library is a proof of concept and not recommended for production use. It is currently a testbed for features that may or may not be added to algosdk and/or algokit utils in the future.

## Why Not Utils?

AlgoKit Lite is intentionally much simpler than AlgoKit utils. The abstractions are smaller and the amount of "magic" happening is lower. Some AlgoKit Lite interfaces are more verbose/explicit than AlgoKit Utils, but that is intentional. This makes it easier for agents to understand the library and for humans to review the code.

Additionally, AlgoKit Lite uses some new features of algod to do things in a different and breaking way. For example, transactions in AlgoKit lite have a `maxUsage` field rather than a `extraFee` or `maxFee` field. This allows simulate to be used to determine transaction fees rather than relying on hardcoded values.

## Composer Migration

The general pattern of the composer for both AlgoKit Utils and Lite is more or less the same. The composer takes in transaction parameters and can optionally do some of the mundane work (like setting suggestedParams) under the hood.

> [!WARNING]
> The Lite composer currently does not do resource population, but this will definitely be added in the near future.

### extraFee and maxFee

#### Utils

In AlgoKit utils you can use extraFee to hardcode extra fee to cover other transactions. A common use case is covering inner transactions on an app call.

```ts
// Send an app call with two inner transactions
composer.addAppCallMethodCall({
  sender,
  appId,
  args,
  method,
  extraFee: microAlgo(2_000),
});
```

Alternatively, you can use the `maxFee` parameter in combination with `coverAppCallInnerTransactionFees` when sending. This will use simulate to add the required fee up to the required amount

```ts
composer.addAppCallMethodCall({
  sender,
  appId,
  args,
  method,
  maxFee: microAlgo(3_000),
});
composer.send({ coverAppCallInnerTransactionFees: true });
```

The problem with this pattern is that it generally requires some assumptions to be made about fee prices which may change under congestion or with consensus updates.

#### Lite

Lite does not have a `maxFee` or `extraFee` field. Instead, it has a `maxUsage` parameter that defines the total _usage_ of the application. The Lite composer uses simulate to determine a transaction's usage, which is then multiplied by the current minFee from algod. This avoids any assumptions needing to be made about fee prices.

```ts
import { BASE_USAGE, Composer } from "algokit-lite";

composer.addMethodCall({
  sender,
  arc56,
  appID,
  method,
  maxUsage: BASE_USAGE * 3n, // equivalent to maxFee: 3_000n under normal network conditions
});
```

> [!NOTE]
> In the future, there will also likely be some sort of maxMinFee field to limit the amount the sender is willing to pay per usage. This will be similar to how ETH wallets allow users to limit their gas price.

### Sender and Signer

#### Utils

In AlgoKit Utils, the sender must be a `string | Address`. If the address is known by the AlgorandClient, then the `TransactionSigner` is implicit

```ts
const sender = algorand.account.random();
const composer = algorand.newGroup();
composer.addPayment({ sender, receiver, amount });
```

For accounts AlgorandClient does not know about, the `signer` must be explicitly attached

```ts
const { activeAddress, transactionSigner } = useWallet();
composer.addPayment({
  sender: activeAddress,
  signer: transactionSigner,
  receiver,
  amount,
});
```

#### Lite

In AlgoKit Lite, the sender must always be a `ComposerSender`, which is defined as `AddressWithTransactionSigner & { emptyTxnSigner?: TransactionSigner }`

```ts
const { activeAddress, transactionSigner } = useWallet();
composer.addPayment({
  sender: { address: activeAddress, signer: transactionSigner },
  receiver,
  amount,
});
```

This interface is implemented by the return value of the `addressWithSignersFromRaw...` functions in `algosdk`. For example, to sign with a falcon account:

```ts
const { generateKey, signCompressed, verifyCompressed } = falcon1024;

const { publicKey, privateKey } = falcon1024.generateKey();
const falconSigningKey = {
  falcon1024PublicKey: publicKey,
  falcon1024Signer: async (bytesToSign) =>
    falcon1024.signCompressed(privateKey, bytesToSign),
};

const sender =
  algosdk.addressWithSignersFromRawFalcon1024Signer(falconSigningKey);

composer.addPayment({
  sender,
  receiver,
  amount,
  maxUsage: BASE_USAGE * 3n, // AlgoKit Lite will use the sender.emptyTxnSigner during simulate to get the fees required for the pqsig
});
```

## Typed Client Migration

One of the main reasons projects use AlgoKit Utils is because of the typed client generator. AlgoKit Lite also offers a typed client generator that covers most of the features developers want (namely typed method calls) but there are some abstractions in the Utils version that are not implemented in the Lite version.

### App Creation, Factory & Deployer

#### Creation

In Utils, to create a new application you must use the app factory.

##### Utils

```ts
import {
  HelloWorldClient,
  HelloWorldFactory,
} from "../contracts/clients/HelloWorld";

const factory = algorand.client.getTypedAppFactory(HelloWorldAppFactory);

const { appClient } = factory.send.create.createApplication({
  args: {
    arg1: 123,
    arg2: "foo",
  },
});
```

##### Lite

In AlgoKit Lite, there is no Factory class and creation is done via a static method

```ts
import { HelloWorldClient } from "../contracts/clients/HelloWorld";

const { appClient } = await HelloWorldAppClient.create.createApplication({
  algod: localnet.algod,
  args: {
    arg1: 123,
    arg2: "foo",
  },
  sender,
});
```

If the contract's `bareActions.create` is non-empty, the generated client also gets a `create.bare` that creates the app without an ABI call.

```ts
const { appClient, appId } = await HelloWorldClient.create.bare({
  algod: localnet.algod,
  sender,
  templateVariables: { SOME_VALUE: 123n },
});
```

The state schema comes from the ARC56 contract, and the number of extra program pages is derived from the compiled program sizes. Pass `numGlobalInts`, `extraPages` and friends to override either.

#### Idempotent Deployer

AlgoKit Utils includes abstractions for idempotent deployment. This feature uses the note field and indexer to find previous deployments of a contract. AlgoKit Lite does not include a similar feature. If you'd like to track previous deployments, you must implement your own way of recording past deployments (on or off chain).

### Typed Composer

#### Utils

AlgoKit Utils' generated client includes a typed composer for composing a group with one or more typed method calls.

```ts
const result = await client
  .newGroup()
  .methodOne({ args: { arg1: 123 } })
  .methodTwo({ args: { arg1: "foo" } })
  .execute();

// Strongly typed as the return type of methodOne
const resultOfMethodOne = result.returns[0];
// Strongly typed as the return type of methodTwo
const resultOfMethodTwo = result.returns[1];
```

#### Lite

With Lite, you can use the app client's `params` object to get the parameters to pass to a `Composer`. When calls are chained, the composer tracks each generated method's return type.

```ts
const composer = await new Composer(...)
  .addMethodCall(client.params.methodOne({ args: { arg1: 123 } }))
  .addMethodCall(client.params.methodTwo({ args: { arg1: 'foo' } }))
  .execute(algod)

// Inferred as the return type of methodOne
const resultOfMethodOne = result.methodResults[0].returnValue
// Inferred as the return type of methodTwo
const resultOfMethodTwo = result.methodResults[1].returnValue
```

If for some reason you cannot chain the `addMethodCalls` calls with the execute, you can use the exported `${arc56.name}ReturnTypes` from the generated client

```ts
import { HelloWorldClient, HelloWorldReturnTypes } from "../contracts/clients/HelloWorld";

const composer = await new Composer(...);
composer.addMethodCall(client.params.methodOne({ args: { arg1: 123 } }));
composer.addMethodCall(client.params.methodTwo({ args: { arg1: 'foo' } }));
const result = composer.execute(algod);

// methodResults will be unknown, so we must explicitly use `as`
const resultOfMethodOne = result.methodResults[0].returnValue as HelloWorldReturnTypes['methodOne']
const resultOfMethodTwo = result.methodResults[1].returnValue as HelloWorldReturnTypes['methodTwo']
```
