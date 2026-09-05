import { describe, it, expect, beforeAll } from "bun:test";
import algosdk from "algosdk";
import { Localnet } from "../src/localnet";
import { ARC56AppClient } from "../src/arc56_client";
import type { ARC56Contract } from "../src/types/arc56";
import arc56Json from "./fixtures/ARC56Test.arc56.json";

describe("ARC56AppClient", () => {
  const localnet = new Localnet();
  const arc56 = arc56Json as unknown as ARC56Contract;
  let dispenser: algosdk.AddressWithTransactionSigner;

  beforeAll(async () => {
    dispenser = await localnet.dispenser();
  });

  it("should create an application using createMethodCall", async () => {
    const appClient = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    expect(appClient.appId).toBe(0n);

    const { appId, appAddress, result } = await appClient.createMethodCall(
      "createApplication",
      {
        templateVariables: { someNumber: 1337n },
      },
    );

    expect(appId).toBeGreaterThan(0n);
    expect(appClient.appId).toBe(appId);
    expect(appAddress.toString()).toBe(
      algosdk.getApplicationAddress(appId).toString(),
    );
    expect(result.confirmedRound).toBeGreaterThan(0n);

    // Calling create again should throw
    expect(
      appClient.createMethodCall("createApplication", {
        templateVariables: { someNumber: 1337n },
      }),
    ).rejects.toThrow("already been created");
  });

  it("should call a method with struct inputs and return decoded struct outputs", async () => {
    const appClient = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    await appClient.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    const inputs = { add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } };

    const { returnValue } = await appClient.methodCall("foo", {
      methodArgs: [inputs],
    });

    expect(returnValue).toEqual({ sum: 3n, difference: 5n });
  });

  it("should support calling with a different sender and custom suggestedParams", async () => {
    const appClient = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    await appClient.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    const bob = await localnet.generateAccount({ fund: 10_000_000n });
    const inputs = { add: { a: 20n, b: 30n }, subtract: { a: 50n, b: 15n } };

    const sp = await localnet.algod.getTransactionParams().do();
    sp.lastValid = sp.firstValid + 50n;

    const { returnValue } = await appClient.methodCall("foo", {
      sender: bob,
      suggestedParams: sp,
      note: new TextEncoder().encode("Hello from test"),
      methodArgs: [inputs],
    });

    expect(returnValue).toEqual({ sum: 50n, difference: 35n });
  });

  it("should compose multiple app clients together using Composer and getParams", async () => {
    const appClient1 = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });
    await appClient1.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    const appClient2 = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });
    await appClient2.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    const inputs = { add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } };

    const sp1 = await localnet.algod.getTransactionParams().do();
    sp1.fee = 2000n;
    sp1.flatFee = true;
    const sp2 = await localnet.algod.getTransactionParams().do();
    sp2.fee = 0n;
    sp2.flatFee = true;

    const composer = localnet.composer();
    composer
      .addMethodCall(
        appClient1.getParams("foo", {
          suggestedParams: sp1,
          methodArgs: [inputs],
        }),
      )
      .addMethodCall(
        appClient2.getParams("foo", {
          suggestedParams: sp2,
          methodArgs: [inputs],
        }),
      );

    const result = await composer.execute(localnet.algod);
    expect(result.methodResults.length).toBe(2);

    const res1 = appClient1.decodeMethodReturnValue(
      "foo",
      result.methodResults[0]!.rawReturnValue,
    );
    const res2 = appClient2.decodeMethodReturnValue(
      "foo",
      result.methodResults[1]!.rawReturnValue,
    );

    expect(res1).toEqual({ sum: 3n, difference: 5n });
    expect(res2).toEqual({ sum: 3n, difference: 5n });
  });

  it("should parse runtime errors using sourceInfo and provide human-readable messages", async () => {
    const appClient = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    await appClient.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    // subtract.a < subtract.b should trigger contract assertion
    expect(
      appClient.methodCall("foo", {
        methodArgs: [{ add: { a: 1n, b: 2n }, subtract: { a: 1n, b: 100n } }],
      }),
    ).rejects.toThrow("subtract.a must be greater than subtract.b");
  });

  it("should read global state keys and maps", async () => {
    const appClient = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    await appClient.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    // Calling foo sets globalKey and globalMap("foo")
    await appClient.methodCall("foo", {
      methodArgs: [{ add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } }],
    });

    const globalKey = await appClient.getState.key("globalKey");
    expect(globalKey).toBe(1337n);

    const globalMapFoo = await appClient.getState.map.value("globalMap", "foo");
    expect(globalMapFoo).toEqual({ foo: 13n, bar: 37n });
  });

  it("should support opt-in, boxes, and reading local state & box state", async () => {
    const appClient = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    await appClient.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    // Fund app account for box MBR
    await localnet
      .composer()
      .addPayment({
        sender: dispenser,
        receiver: appClient.appAddress,
        amount: 1_000_000n,
      })
      .execute(localnet.algod);

    const box1 = new TextEncoder().encode("boxKey");
    const box2 = Uint8Array.from(
      Buffer.from(
        "700000000000000001000000000000000200000000000000040000000000000003",
        "hex",
      ),
    );

    await appClient.optInMethodCall("optInToApplication", {
      boxes: [
        { appIndex: 0, name: box1 },
        { appIndex: 0, name: box2 },
      ],
    });

    // Verify local state
    const localKey = await appClient.getState.key("localKey", dispenser);
    expect(localKey).toBe(1337n);

    const localMapFoo = await appClient.getState.map.value(
      "localMap",
      "foo",
      dispenser,
    );
    expect(localMapFoo).toBe("bar");

    // Verify box state
    const boxKeyVal = await appClient.getState.key("boxKey");
    expect(boxKeyVal).toBe("baz");

    const boxMapVal = await appClient.getState.map.value("boxMap", {
      add: { a: 1n, b: 2n },
      subtract: { a: 4n, b: 3n },
    });
    expect(boxMapVal).toEqual({ sum: 3n, difference: 1n });
  });

  it("should validate method names, sender requirements, and template variables", async () => {
    const appClientNoSender = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
    });

    // Missing sender
    expect(() => appClientNoSender.getParams("foo")).toThrow(
      "No sender provided",
    );

    const appClient = new ARC56AppClient({
      arc56,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    // Non-existent method
    expect(() => appClient.getParams("nonExistent")).toThrow(
      "Method nonExistent not found",
    );

    // Mismatched template variables count
    expect(
      appClient.createMethodCall("createApplication", {
        templateVariables: {},
      }),
    ).rejects.toThrow("expected 1 template variables but got 0");

    // Unsupported action (foo only supports NoOp for call, so OptIn throws)
    expect(appClient.optInMethodCall("foo")).rejects.toThrow(
      "OptIn is not supported for foo",
    );
  });

  it("should support latest ARC-56 StructField[] format", async () => {
    // Convert struct definitions from object format to latest ARC-56 StructField[] format
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

    const appClient = new ARC56AppClient({
      arc56: arc56LatestStructs,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    await appClient.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    const inputs = { add: { a: 15n, b: 25n }, subtract: { a: 100n, b: 40n } };
    const { returnValue } = await appClient.methodCall("foo", {
      methodArgs: [inputs],
    });

    expect(returnValue).toEqual({ sum: 40n, difference: 60n });
  });

  it("should support latest ARC-56 approval.sourceInfo format with pcOffsetMethod", async () => {
    const rawSourceInfo = (arc56.sourceInfo as any[]) ?? [];
    const arc56LatestSourceInfo: ARC56Contract = {
      ...arc56,
      sourceInfo: {
        approval: {
          pcOffsetMethod: "none",
          sourceInfo: rawSourceInfo,
        },
        clear: {
          pcOffsetMethod: "none",
          sourceInfo: [],
        },
      },
    };

    const appClient = new ARC56AppClient({
      arc56: arc56LatestSourceInfo,
      algod: localnet.algod,
      defaultSender: dispenser,
    });

    await appClient.createMethodCall("createApplication", {
      templateVariables: { someNumber: 1337n },
    });

    expect(
      appClient.methodCall("foo", {
        methodArgs: [{ add: { a: 1n, b: 2n }, subtract: { a: 1n, b: 100n } }],
      }),
    ).rejects.toThrow("subtract.a must be greater than subtract.b");
  });
});
