# AlgoKit Lite

This library is a light wrapper around algosdk to make it easier to interact with Algorand. The main features are

- Ergonomic ARC56-compatible transaction group composer
- ARC56 app client
- Typed ARC56 app client generator
- Localnet account generation and funding

## Why Not Utils?

AlgoKit Lite is intentionally much simpler than AlgoKit utils. The abstractions are smaller and the amount of "magic" happening is lower. Some AlgoKit Lite interfaces are more verbose/explicit than AlgoKit Utils, but that is intentional. This makes it easier for agents to understand the library and for humans to review the code.

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

const factory = algorand.client.getTypedAppFactory(HelloWorldAppFactory)

const { appClient } = factory.send.create.createApplication({
  args: {
    arg1: 123,
    arg2: 'foo',
  },
})
```

##### Lite

In AlgoKit Lite, there is no Factory class and creation is done via a static method

```ts
import {
  HelloWorldClient
} from "../contracts/clients/HelloWorld";

const { appClient } =
      await HelloWorldAppClient.create.createApplication({
        algod: localnet.algod,
        args: {
          arg1: 123,
          arg2: 'foo',
        },
        sender,
      });
```

#### Idempotent Deployer

AlgoKit Utils includes abstractions for idempotent deployment. This feature uses the note field and indexer to find previous deployments of a contract. AlgoKit Lite does not include a similar feature. If you'd like to track previous deployments, you must implement your own way of recording past deployments (on or off chain).

### Typed Composer

#### Utils

AlgoKit Utils' generated client includes a typed composer for composing a group with one or more typed method calls.

```ts
const result = await client
  .newGroup()
  .methodOne({ args: { arg1: 123 } })
  .methodTwo({ args: { arg1: 'foo' } })
  .execute()

// Strongly typed as the return type of methodOne
const resultOfMethodOne = result.returns[0]
// Strongly typed as the return type of methodTwo
const resultOfMethodTwo = result.returns[1]
```

#### Lite

With Lite, you can use the app client's `params` object to get the parameters to pass to a `Composer`. You can then use the generated client's `${arc56.name}ReturnTypes` type to get the ARC56 value.

```ts
import {
  HelloWorldClient,
  HelloWorldReturnTypes,
} from "../contracts/clients/HelloWorld";

const result = new Composer(...)
  .addMethodCall(client.params.methodOne({ args: { arg1: 123 } }))
  .addMethodCall(client.params.methodTwo({ args: { arg1: 'foo' } }))
  .execute()

const resultOfMethodOne = result.methodResults[0].returnValue as HelloWorldReturnTypes['methodOne']);
const resultOfMethodTwo = result.methodResults[1].returnValue as HelloWorldReturnTypes['methodTwo']);
```
