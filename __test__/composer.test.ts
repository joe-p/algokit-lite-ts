import { describe, it, expect, beforeAll } from "bun:test";
import algosdk, { type Falcon1024SigningKey } from "algosdk";
import { Localnet } from "../src/localnet";
import { ARC56AppClient } from "../src/arc56_client";
import { BASE_USAGE, Composer, type MethodResult } from "../src/composer";
import type { ARC56Contract } from "../src/types/arc56";
import arc56Json from "./fixtures/ARC56Test.arc56.json";

function getResult(
  res: { methodResults: MethodResult[] },
  index: number,
): MethodResult {
  const mr = res.methodResults[index];
  if (!mr) throw new Error(`Expected method result at index ${index}`);
  return mr;
}

function getTxn(
  txns: algosdk.TransactionWithSigner[],
  index: number,
): algosdk.TransactionWithSigner {
  const t = txns[index];
  if (!t) throw new Error(`Expected transaction at index ${index}`);
  return t;
}

describe("Composer ARC56", () => {
  const localnet = new Localnet();
  const arc56 = arc56Json as unknown as ARC56Contract;
  let sender: algosdk.AddressWithTransactionSigner;
  let appId: bigint;

  beforeAll(async () => {
    sender = await localnet.dispenser();
    const created = await ARC56AppClient.createMethodCall({
      arc56,
      algod: localnet.algod,
      method: "createApplication",
      sender,
      templateVariables: { someNumber: 1337n },
    });
    appId = created.appId;
    await localnet
      .composer()
      .addPayment({
        sender,
        receiver: created.appAddress,
        amount: 1_000_000n,
      })
      .execute(localnet.algod);
  });

  it("should execute method call with attached ARC56 contract and decode return struct", async () => {
    const composer = localnet.composer();
    const inputs = { add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } };

    composer.addMethodCall({
      arc56,
      appID: appId,
      method: "foo",
      sender,
      methodArgs: [inputs],
    });

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(1);
    const r = getResult(result, 0);
    expect(r.returnValue).toEqual({
      sum: 3n,
      difference: 5n,
    });
    expect(r.rawReturnValue.length).toBeGreaterThan(0);
    expect(r.decodeError).toBeUndefined();
  });

  it("should require appID for method call", async () => {
    const composer = localnet.composer();
    const inputs = { add: { a: 100n, b: 200n }, subtract: { a: 50n, b: 20n } };

    composer.addMethodCall({
      arc56,
      appID: appId,
      method: "foo",
      sender,
      methodArgs: [inputs],
    });

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(1);
    const r = getResult(result, 0);
    expect(r.returnValue).toEqual({
      sum: 300n,
      difference: 30n,
    });
  });

  it("should support ABIMethod instance with attached ARC56 contract", async () => {
    const composer = localnet.composer();
    const contract = new algosdk.ABIContract({
      name: arc56.name,
      methods: arc56.methods,
    });
    const abiMethod = contract.getMethodByName("foo");
    const inputs = { add: { a: 7n, b: 3n }, subtract: { a: 9n, b: 4n } };

    composer.addMethodCall({
      arc56,
      appID: appId,
      method: abiMethod,
      sender,
      methodArgs: [inputs],
    });

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(1);
    const r = getResult(result, 0);
    expect(r.returnValue).toEqual({
      sum: 10n,
      difference: 5n,
    });
  });

  it("should decode multiple ARC56 method calls in a single atomic transaction group", async () => {
    const composer = localnet.composer();
    const inputs1 = { add: { a: 10n, b: 20n }, subtract: { a: 30n, b: 15n } };
    const inputs2 = { add: { a: 50n, b: 50n }, subtract: { a: 80n, b: 20n } };

    composer
      .addMethodCall({
        arc56,
        appID: appId,
        method: "foo",
        sender,
        methodArgs: [inputs1],
      })
      .addMethodCall({
        arc56,
        appID: appId,
        method: "foo",
        sender,
        methodArgs: [inputs2],
      });

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(2);
    const r1 = getResult(result, 0);
    const r2 = getResult(result, 1);
    expect(r1.returnValue).toEqual({
      sum: 30n,
      difference: 15n,
    });
    expect(r2.returnValue).toEqual({
      sum: 100n,
      difference: 60n,
    });
  });

  it("should support composing payment transaction and ARC56 method call together", async () => {
    const receiver = await localnet.generateAccount({});
    const composer = localnet.composer();
    const inputs = { add: { a: 4n, b: 6n }, subtract: { a: 12n, b: 2n } };

    composer
      .addPayment({
        sender,
        receiver: receiver.address,
        amount: 200_000n,
      })
      .addMethodCall({
        arc56,
        appID: appId,
        method: "foo",
        sender,
        methodArgs: [inputs],
      });

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(1);
    const r = getResult(result, 0);
    expect(r.returnValue).toEqual({
      sum: 10n,
      difference: 10n,
    });
  });

  it("should build a payment transaction from PaymentParams passed as a pay method argument", async () => {
    const arc56WithPay: ARC56Contract = {
      ...arc56,
      methods: [
        ...arc56.methods,
        {
          name: "deposit",
          args: [{ name: "payment", type: "pay" }],
          returns: { type: "void" },
          actions: { create: [], call: ["NoOp"] },
        },
      ],
    };

    const composer = localnet.composer();
    composer.addMethodCall({
      arc56: arc56WithPay,
      appID: appId,
      method: "deposit",
      sender,
      methodArgs: [{ sender, receiver: sender.address, amount: 1_000_000n }],
    });

    const txns = await composer.buildGroupOffline();
    expect(txns.length).toBe(2);

    // The payment txn is added before the application call txn
    const payTxn = getTxn(txns, 0);
    if (!payTxn.txn.payment) throw new Error("Expected payment transaction");
    expect(payTxn.txn.payment.amount).toBe(1_000_000n);
    expect(payTxn.txn.payment.receiver.toString()).toBe(
      sender.address.toString(),
    );
    expect(payTxn.signer).toBe(sender.txnSigner);

    const appTxn = getTxn(txns, 1);
    if (!appTxn.txn.applicationCall)
      throw new Error("Expected application call transaction");
  });

  it("should handle void return type method calls with ARC56", async () => {
    const user = await localnet.generateAccount({ fund: 10_000_000n });
    const composer = localnet.composer();

    const box1 = new TextEncoder().encode("boxKey");
    const box2 = Uint8Array.from(
      Buffer.from(
        "700000000000000001000000000000000200000000000000040000000000000003",
        "hex",
      ),
    );

    composer.addMethodCall({
      arc56,
      appID: appId,
      method: "optInToApplication",
      sender: user,
      boxes: [
        { appIndex: 0, name: box1 },
        { appIndex: 0, name: box2 },
      ],
      onComplete: algosdk.OnApplicationComplete.OptInOC,
    });

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(1);
    const r = getResult(result, 0);
    expect(r.returnValue).toBeUndefined();
  });

  it("should decode return value when simulating transaction group with simulate()", async () => {
    const composer = localnet.composer();
    const inputs = { add: { a: 11n, b: 22n }, subtract: { a: 33n, b: 11n } };

    composer.addMethodCall({
      arc56,
      appID: appId,
      method: "foo",
      sender,
      methodArgs: [inputs],
    });

    const simResult = await composer.simulate(localnet.algod);
    expect(simResult.methodResults.length).toBe(1);
    const r = getResult(simResult, 0);
    expect(r.returnValue).toEqual({
      sum: 33n,
      difference: 22n,
    });
  });

  it("should support latest ARC56 StructField[] format in Composer", async () => {
    const arc56LatestStructs: ARC56Contract = {
      ...arc56,
      structs: {
        "{ foo: uint16; bar: uint16 }": [
          { name: "foo", type: "uint16" },
          { name: "bar", type: "uint16" },
        ],
        Outputs: [
          { name: "sum", type: "uint64" },
          { name: "difference", type: "uint64" },
        ],
        Inputs: [
          {
            name: "add",
            type: [
              { name: "a", type: "uint64" },
              { name: "b", type: "uint64" },
            ],
          },
          {
            name: "subtract",
            type: [
              { name: "a", type: "uint64" },
              { name: "b", type: "uint64" },
            ],
          },
        ],
      },
    };

    const composer = localnet.composer();
    const inputs = { add: { a: 25n, b: 75n }, subtract: { a: 50n, b: 10n } };

    composer.addMethodCall({
      arc56: arc56LatestStructs,
      appID: appId,
      method: "foo",
      sender,
      methodArgs: [inputs],
    });

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(1);
    const r = getResult(result, 0);
    expect(r.returnValue).toEqual({
      sum: 100n,
      difference: 40n,
    });
  });

  it("should automatically decode return value when getParams from ARC56AppClient is passed to Composer", async () => {
    const appClient = new ARC56AppClient({
      arc56,
      appId,
      algod: localnet.algod,
    });

    const inputs = { add: { a: 5n, b: 5n }, subtract: { a: 20n, b: 8n } };
    const composer = localnet.composer();

    composer.addMethodCall(
      appClient.getParams({
        method: "foo",
        sender,
        methodArgs: [inputs],
      }),
    );

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(1);
    const r = getResult(result, 0);
    expect(r.returnValue).toEqual({
      sum: 10n,
      difference: 12n,
    });
  });

  it("should throw error if method is a string without arc56 attached", () => {
    const composer = localnet.composer();

    expect(
      composer
        // @ts-expect-error method as string without arc56 should be invalid at type and runtime level
        .addMethodCall({
          appID: appId,
          method: "foo",
          sender,
        })
        .buildGroupOffline(),
    ).rejects.toThrow(
      "ARC56 definition is required when method is specified as a string",
    );
  });

  it("should auto-populate recommendations (boxes, accounts, apps, assets) if omitted", async () => {
    const boxKeyB64 = Buffer.from("myBoxKey").toString("base64");
    const baseMethod = arc56.methods[0];
    if (!baseMethod) throw new Error("Expected at least one method");

    const arc56WithRecommendations: ARC56Contract = {
      ...arc56,
      methods: [
        {
          ...baseMethod,
          name: "methodWithRecs",
          recommendations: {
            boxes: [{ key: boxKeyB64, app: 0 }],
            accounts: [sender.address.toString()],
            apps: [1001, 1002],
            assets: [2001, 2002],
          },
        },
      ],
    };

    const composer = localnet.composer();
    composer.addMethodCall({
      arc56: arc56WithRecommendations,
      appID: appId,
      method: "methodWithRecs",
      sender,
      methodArgs: [{ add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } }],
    });

    const txns = await composer.buildGroupOffline();
    const appTxn = getTxn(txns, 0).txn;

    if (!appTxn.applicationCall) {
      throw new Error("Expected applicationCall transaction");
    }

    expect(appTxn.applicationCall.boxes.length).toBe(1);
    const box = appTxn.applicationCall.boxes[0];
    if (!box) throw new Error("Expected box reference");
    expect(box.name).toEqual(new TextEncoder().encode("myBoxKey"));
    expect(appTxn.applicationCall.accounts.map((a) => a.toString())).toEqual([
      sender.address.toString(),
    ]);
    expect(appTxn.applicationCall.foreignApps).toEqual([1001n, 1002n]);
    expect(appTxn.applicationCall.foreignAssets).toEqual([2001n, 2002n]);
  });

  it("should set an exact fee with staticFee", async () => {
    const receiver = await localnet.generateAccount({});

    const txns = await localnet
      .composer()
      .addPayment({
        sender,
        receiver: receiver.address,
        amount: 0n,
        staticFee: 0n,
      })
      .addMethodCall({
        arc56,
        appID: appId,
        method: "foo",
        sender,
        staticFee: 5_000n,
        methodArgs: [{ add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } }],
      })
      .buildGroupOffline();

    expect(getTxn(txns, 0).txn.fee).toBe(0n);
    expect(getTxn(txns, 1).txn.fee).toBe(5_000n);
  });

  it("should cover a zero-fee transaction with a capped maxUsage", async () => {
    const composer = new Composer({
      getSuggestedParams: () => localnet.algod.getTransactionParams().do(),
    });

    const txns = await composer
      .addPayment({
        sender,
        receiver: sender.address,
        amount: 0n,
        staticFee: 0n,
      })
      .addMethodCall({
        arc56,
        appID: appId,
        method: "foo",
        sender,
        maxUsage: 3_000_000n,
        methodArgs: [{ add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } }],
      })
      .buildGroup(localnet.algod);

    expect(getTxn(txns, 0).txn.fee).toBe(0n);
    const fee = getTxn(txns, 1).txn.fee;
    expect(fee).toBe(2_000n);

    const result = await composer.execute(localnet.algod);
    expect(result.confirmedRound).toBeGreaterThan(0n);
    expect(getResult(result, 0).returnValue).toEqual({
      sum: 3n,
      difference: 5n,
    });
  });

  it("should cover a large transaction with a capped maxUsage", async () => {
    const composer = new Composer({
      getSuggestedParams: () => localnet.algod.getTransactionParams().do(),
    });

    const txns = await composer
      .addPayment({
        sender,
        receiver: sender.address,
        amount: 0n,
        note: new Uint8Array(4096),
        maxUsage: BASE_USAGE + 308_000n,
      })
      .buildGroup(localnet.algod);

    expect(getTxn(txns, 0).txn.fee).toBe(1_308n);
  });

  it("should cover a pqsig transaction with a capped maxUsage", async () => {
    const emptyFalcon: Falcon1024SigningKey = {
      falcon1024PublicKey: new Uint8Array(),
      // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
      falcon1024Signer: async (_: Uint8Array) => {
        return new Uint8Array();
      },
    };

    const pqSender =
      algosdk.addressWithSignersFromRawFalcon1024Signer(emptyFalcon);
    const composer = new Composer({
      getSuggestedParams: () => localnet.algod.getTransactionParams().do(),
    });
    await localnet.fundAccount(pqSender.address, 1_000_000n);

    const txns = await composer
      .addPayment({
        sender: pqSender,
        receiver: sender.address,
        amount: 0n,
        maxUsage: BASE_USAGE * 3n,
      })
      .buildGroup(localnet.algod);

    expect(getTxn(txns, 0).txn.fee).toBe(3_000n);
  });

  it("should throw error on not enough maxUsage", () => {
    const composer = new Composer({
      getSuggestedParams: () => localnet.algod.getTransactionParams().do(),
    });

    expect(
      composer
        .addPayment({
          sender,
          receiver: sender.address,
          amount: 0n,
          note: new Uint8Array(4096),
          maxUsage: BASE_USAGE + 1_000n,
        })
        .buildGroup(localnet.algod),
    ).rejects.toThrow(
      "You need to increase maxUsage on one or more transactions",
    );
  });

  it("should let a zero-fee transaction be covered by another transaction's staticFee", async () => {
    const payer = await localnet.generateAccount({ fund: 10_000_000n });

    const result = await localnet
      .composer()
      .addPayment({
        sender: payer,
        receiver: payer.address,
        amount: 0n,
        staticFee: 0n,
      })
      .addPayment({
        sender: payer,
        receiver: payer.address,
        amount: 0n,
        // Its own fee plus the fee the transaction above did not pay
        staticFee: 2_000n,
      })
      .execute(localnet.algod);

    expect(result.confirmedRound).toBeGreaterThan(0n);
  });

  it("should accept a pre-built transaction", async () => {
    const suggestedParams = await localnet.algod.getTransactionParams().do();

    const prebuilt = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: sender.address,
      receiver: sender.address,
      amount: 0n,
      suggestedParams,
    });

    const result = await localnet
      .composer()
      .addTransaction(prebuilt, sender.txnSigner)
      .addMethodCall({
        arc56,
        appID: appId,
        method: "foo",
        sender,
        methodArgs: [{ add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } }],
      })
      .execute(localnet.algod);

    expect(result.txIDs.length).toBe(2);
    expect(getResult(result, 0).returnValue).toEqual({
      sum: 3n,
      difference: 5n,
    });
  });

  it("should accept a pre-built TransactionWithSigner", async () => {
    const suggestedParams = await localnet.algod.getTransactionParams().do();

    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: sender.address,
      receiver: sender.address,
      amount: 0n,
      suggestedParams,
    });

    const result = await localnet
      .composer()
      .addTransaction({ txn, signer: sender.txnSigner })
      .execute(localnet.algod);

    expect(result.txIDs.length).toBe(1);
  });

  it("should reject a pre-built transaction with no signer", async () => {
    const suggestedParams = await localnet.algod.getTransactionParams().do();

    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: sender.address,
      receiver: sender.address,
      amount: 1n,
      suggestedParams,
    });

    expect(() => localnet.composer().addTransaction(txn as never)).toThrow(
      "A TransactionSigner is required",
    );
  });

  it("should build a key registration transaction", async () => {
    const voteKey = new Uint8Array(32);
    const selectionKey = new Uint8Array(32);
    const stateProofKey = new Uint8Array(64);

    const txns = await localnet
      .composer()
      .addKeyReg({
        sender,
        voteKey,
        selectionKey,
        stateProofKey,
        voteFirst: 10n,
        voteLast: 20n,
        voteKeyDilution: 10000n,
      })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.keyreg) throw new Error("Expected keyreg transaction");
    expect(txn.keyreg.voteKey).toEqual(voteKey);
    expect(txn.keyreg.selectionKey).toEqual(selectionKey);
    expect(txn.keyreg.stateProofKey).toEqual(stateProofKey);
    expect(txn.keyreg.voteFirst).toBe(10n);
    expect(txn.keyreg.voteLast).toBe(20n);
    expect(txn.keyreg.voteKeyDilution).toBe(10000n);
  });

  it("should build an asset create transaction", async () => {
    const txns = await localnet
      .composer()
      .addAssetCreate({
        sender,
        total: 1000n,
        decimals: 2,
        unitName: "UNIT",
        assetName: "Unit Token",
        defaultFrozen: false,
      })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.assetConfig) throw new Error("Expected asset config transaction");
    expect(txn.assetConfig.total).toBe(1000n);
    expect(txn.assetConfig.decimals).toBe(2);
    expect(txn.assetConfig.unitName).toBe("UNIT");
    expect(txn.assetConfig.assetName).toBe("Unit Token");
    expect(txn.assetConfig.defaultFrozen).toBe(false);
  });

  it("should build an asset transfer (opt-in) transaction", async () => {
    const txns = await localnet
      .composer()
      .addAssetTransfer({
        sender,
        receiver: sender.address,
        assetIndex: 1001n,
        amount: 0n,
      })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.assetTransfer)
      throw new Error("Expected asset transfer transaction");
    expect(txn.assetTransfer.assetIndex).toBe(1001n);
    expect(txn.assetTransfer.amount).toBe(0n);
    expect(txn.assetTransfer.receiver.toString()).toBe(
      sender.address.toString(),
    );
  });

  it("should build an asset config (modify roles) transaction", async () => {
    const manager = sender.address;
    const txns = await localnet
      .composer()
      .addAssetConfig({
        sender,
        assetIndex: 1001n,
        manager,
        strictEmptyAddressChecking: false,
      })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.assetConfig) throw new Error("Expected asset config transaction");
    expect(txn.assetConfig.assetIndex).toBe(1001n);
    if (!txn.assetConfig.manager)
      throw new Error("Expected asset config manager");
    expect(txn.assetConfig.manager.toString()).toBe(manager.toString());
  });

  it("should build an asset destroy transaction", async () => {
    const txns = await localnet
      .composer()
      .addAssetDestroy({ sender, assetIndex: 1001n })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.assetConfig) throw new Error("Expected asset config transaction");
    expect(txn.assetConfig.assetIndex).toBe(1001n);
  });

  it("should build an asset freeze transaction", async () => {
    const txns = await localnet
      .composer()
      .addAssetFreeze({
        sender,
        assetIndex: 1001n,
        freezeTarget: sender.address,
        frozen: true,
      })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.assetFreeze) throw new Error("Expected asset freeze transaction");
    expect(txn.assetFreeze.assetIndex).toBe(1001n);
    expect(txn.assetFreeze.freezeAccount.toString()).toBe(
      sender.address.toString(),
    );
    expect(txn.assetFreeze.frozen).toBe(true);
  });

  it("should build an application opt-in call with the correct onComplete and appIndex", async () => {
    const txns = await localnet
      .composer()
      .addAppOptIn({ sender, appID: appId })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.applicationCall)
      throw new Error("Expected application call transaction");
    expect(txn.applicationCall.onComplete).toBe(
      algosdk.OnApplicationComplete.OptInOC,
    );
    expect(txn.applicationCall.appIndex).toBe(appId);
  });

  it("should build an application call with appID normalized to appIndex", async () => {
    const txns = await localnet
      .composer()
      .addAppCall({
        sender,
        appID: appId,
        onComplete: algosdk.OnApplicationComplete.NoOpOC,
        appArgs: [new TextEncoder().encode("hello")],
      })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.applicationCall)
      throw new Error("Expected application call transaction");
    expect(txn.applicationCall.appIndex).toBe(appId);
    expect(txn.applicationCall.onComplete).toBe(
      algosdk.OnApplicationComplete.NoOpOC,
    );
    expect(txn.applicationCall.appArgs.length).toBe(1);
  });

  it("should build each app call variant with its own onComplete", async () => {
    const cases: Array<[string, (c: Composer) => void, number]> = [
      ["addAppUpdate", (c) => c.addAppUpdate({ sender, appID: appId }), 4],
      ["addAppDelete", (c) => c.addAppDelete({ sender, appID: appId }), 5],
      ["addAppCloseOut", (c) => c.addAppCloseOut({ sender, appID: appId }), 2],
      [
        "addAppClearState",
        (c) => c.addAppClearState({ sender, appID: appId }),
        3,
      ],
      ["addAppNoOp", (c) => c.addAppNoOp({ sender, appID: appId }), 0],
    ];

    for (const [name, build, onComplete] of cases) {
      const composer = localnet.composer();
      build(composer);
      const txns = await composer.buildGroupOffline();
      const txn = getTxn(txns, 0).txn;
      if (!txn.applicationCall)
        throw new Error(`Expected application call transaction for ${name}`);
      expect(txn.applicationCall.onComplete).toBe(onComplete);
    }
  });

  it("should build a bare application create with addAppCreate", async () => {
    const txns = await localnet
      .composer()
      .addAppCreate({
        sender,
        approvalProgram: new Uint8Array([0x01]),
        clearProgram: new Uint8Array([0x01]),
      })
      .buildGroupOffline();

    const txn = getTxn(txns, 0).txn;
    if (!txn.applicationCall)
      throw new Error("Expected application call transaction");
    expect(txn.applicationCall.appIndex).toBe(0n);
    expect(txn.applicationCall.onComplete).toBe(
      algosdk.OnApplicationComplete.NoOpOC,
    );
  });
});
