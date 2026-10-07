import { describe, it, expect, beforeAll } from "vitest";
import algosdk from "algosdk";
import { Localnet } from "../src/localnet";
import { ARC56AppClient } from "../src/arc56_client";
import type { ARC56Contract, Method } from "../src/types/arc56";
import arc56Json from "./fixtures/ARC56Test.arc56.json";

const RETURN_PREFIX = new Uint8Array([0x15, 0x1f, 0x7c, 0x75]);

function arc56Method(
  name: string,
  args: string[],
  returns: string = "void",
): Method {
  return {
    name,
    args: args.map((type, i) => ({ type, name: `arg${i}` })),
    returns: { type: returns },
    actions: { create: [], call: ["NoOp"] },
    readonly: false,
    events: [],
  } as unknown as Method;
}

const uint64Args = (length: number) => Array.from({ length }, () => "uint64");

const syntheticArc56 = {
  ...(arc56Json as unknown as ARC56Contract),
  methods: [
    arc56Method("refs", ["account", "account", "application", "asset"]),
    arc56Method("withTxn", ["pay", "uint64"], "uint64"),
    arc56Method("fifteen", uint64Args(15)),
    arc56Method("many", uint64Args(17)),
  ],
};

const appId = 1234n;
const sender = algosdk.generateAccount().addr;
const other = algosdk.generateAccount().addr;

const suggestedParams: algosdk.SuggestedParams = {
  fee: 1000n,
  minFee: 1000n,
  firstValid: 1n,
  lastValid: 1000n,
  genesisHash: new Uint8Array(32),
  genesisID: "test",
};

/** Encode a method call with algosdk and wrap it as a block transaction */
function txnInBlock(
  methodName: string,
  methodArgs: algosdk.ABIArgument[],
  opts: { appID?: bigint; logs?: Uint8Array[] } = {},
): algosdk.SignedTxnInBlock {
  const def = syntheticArc56.methods.find((m) => m.name === methodName);
  if (!def) throw Error(`Unknown method ${methodName}`);

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: opts.appID ?? appId,
    method: new algosdk.ABIMethod(def),
    methodArgs,
    sender,
    suggestedParams,
    signer: algosdk.makeEmptyTransactionSigner(),
  });
  const txn = atc.buildGroup().at(-1)?.txn;
  if (!txn) throw Error("No transaction built");

  return new algosdk.SignedTxnInBlock({
    signedTxn: new algosdk.SignedTxnWithAD({
      signedTxn: new algosdk.SignedTransaction({ txn }),
      applyData: new algosdk.ApplyData({
        evalDelta: new algosdk.EvalDelta({ logs: opts.logs ?? [] }),
      }),
    }),
    hasGenesisID: false,
    hasGenesisHash: false,
  });
}

describe("ARC56AppClient.parseTransaction", () => {
  const client = new ARC56AppClient({
    arc56: syntheticArc56,
    appId,
    algod: new algosdk.Algodv2("", "http://localhost", 4001),
  });

  it("resolves reference args to addresses and IDs", () => {
    const parsed = client.parseTransaction(
      txnInBlock("refs", [sender, other, 5678n, 42n]),
    );

    expect(parsed?.method.name).toBe("refs");
    expect(parsed?.args.map(String)).toEqual([
      sender.toString(),
      other.toString(),
      "5678",
      "42",
    ]);
  });

  it("leaves transaction args undefined and decodes the return value", () => {
    const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender,
      receiver: other,
      amount: 1,
      suggestedParams,
    });
    const parsed = client.parseTransaction(
      txnInBlock(
        "withTxn",
        [{ txn: pay, signer: algosdk.makeEmptyTransactionSigner() }, 7n],
        {
          logs: [
            new Uint8Array([1, 2, 3]),
            new Uint8Array([...RETURN_PREFIX, ...algosdk.encodeUint64(99n)]),
          ],
        },
      ),
    );

    expect(parsed?.args).toEqual([undefined, 7n]);
    expect(parsed?.returnValue).toBe(99n);
  });

  it("decodes exactly 15 args, which are not packed in a tuple", () => {
    const values = Array.from({ length: 15 }, (_, i) => BigInt(i));
    const parsed = client.parseTransaction(txnInBlock("fifteen", values));

    expect(parsed?.args).toEqual(values);
  });

  it("decodes args packed in a tuple past the 15th app arg", () => {
    const values = Array.from({ length: 17 }, (_, i) => BigInt(i));
    const parsed = client.parseTransaction(txnInBlock("many", values));

    expect(parsed?.args).toEqual(values);
  });

  it("parses inner transactions, which have no block wrapper", () => {
    const inner = txnInBlock("refs", [sender, other, 5678n, 42n]).signedTxn;
    const parsed = client.parseTransaction(inner);

    expect(parsed?.method.name).toBe("refs");
    expect(parsed?.args.map(String)).toEqual([
      sender.toString(),
      other.toString(),
      "5678",
      "42",
    ]);
  });

  it("returns undefined for another app", () => {
    expect(
      client.parseTransaction(
        txnInBlock("refs", [sender, other, 1n, 2n], {
          appID: appId + 1n,
        }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an unknown selector", () => {
    const otherClient = new ARC56AppClient({
      arc56: { ...syntheticArc56, methods: [arc56Method("refs", [])] },
      appId,
      algod: new algosdk.Algodv2("", "http://localhost", 4001),
    });

    expect(
      otherClient.parseTransaction(txnInBlock("refs", [sender, other, 1n, 2n])),
    ).toBeUndefined();
  });
});

describe("ARC56AppClient.parseTransaction on localnet", () => {
  const localnet = new Localnet();
  const arc56 = arc56Json as unknown as ARC56Contract;
  let sender: algosdk.AddressWithTransactionSigner;

  beforeAll(async () => {
    sender = await localnet.dispenser();
  });

  it("parses the create and method calls from their blocks", async () => {
    const created = await ARC56AppClient.createMethodCall({
      arc56,
      algod: localnet.algod,
      method: "createApplication",
      sender,
      templateVariables: { someNumber: 1337n },
    });
    const { appClient } = created;

    const inputs = { add: { a: 1n, b: 2n }, subtract: { a: 10n, b: 5n } };
    const { result } = await appClient.methodCall({
      method: "foo",
      sender,
      methodArgs: [inputs],
    });

    const blockTxns = async (round: bigint) =>
      (await localnet.algod.block(round).do()).block.payset;

    const parsedCreate = (await blockTxns(created.result.confirmedRound))
      .map((t) => appClient.parseTransaction(t))
      .filter((p) => p !== undefined);
    expect(parsedCreate.map((p) => p.method.name)).toEqual([
      "createApplication",
    ]);

    const parsedFoo = (await blockTxns(result.confirmedRound))
      .map((t) => appClient.parseTransaction(t))
      .filter((p) => p !== undefined);
    expect(parsedFoo).toHaveLength(1);
    expect(parsedFoo[0]?.method.name).toBe("foo");
    expect(parsedFoo[0]?.args).toEqual([inputs]);
    expect(parsedFoo[0]?.returnValue).toEqual({ sum: 3n, difference: 5n });
  });
});
