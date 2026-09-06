import { describe, it, expect, beforeAll } from "bun:test";
import algosdk from "algosdk";
import { Localnet } from "../src/localnet";
import { ARC56AppClient } from "../src/arc56_client";
import type { MethodResult } from "../src/composer";
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

  it("should support appId as alias for appID", async () => {
    const composer = localnet.composer();
    const inputs = { add: { a: 100n, b: 200n }, subtract: { a: 50n, b: 20n } };

    composer.addMethodCall({
      arc56,
      appId, // using appId alias
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
        .buildGroup(),
    ).rejects.toThrow(
      "ARC56 definition is required when method is specified as a string",
    );
  });

  it("should throw error if appID/appId is missing", () => {
    const composer = localnet.composer();

    expect(
      composer
        // @ts-expect-error missing appID / appId
        .addMethodCall({
          arc56,
          method: "foo",
          sender,
        })
        .buildGroup(),
    ).rejects.toThrow("appID (or appId) is required for method call");
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

    const txns = await composer.buildGroup();
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
      .buildGroup();

    expect(getTxn(txns, 0).txn.fee).toBe(0n);
    expect(getTxn(txns, 1).txn.fee).toBe(5_000n);
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
});
