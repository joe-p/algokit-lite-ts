import { describe, it, expect, beforeAll } from "vitest";
import algosdk from "algosdk";
import { Localnet } from "../src/localnet";
import { Composer } from "../src/composer";
import { populateAppCallResources } from "../src/resource_population";

// Accesses whichever resource the first app arg names, without it being in
// any reference array
const APPROVAL = `#pragma version 10
txn ApplicationID
bz ok
txna ApplicationArgs 0
dup
pushbytes "acct"
==
bnz acct
dup
pushbytes "app"
==
bnz app
dup
pushbytes "asset"
==
bnz asset
dup
pushbytes "box"
==
bnz box
dup
pushbytes "holding"
==
bnz holding
dup
pushbytes "local"
==
bnz local
err
acct:
txna ApplicationArgs 1
balance
pop
b ok
app:
txna ApplicationArgs 1
btoi
pushbytes "x"
app_global_get_ex
pop
pop
b ok
asset:
txna ApplicationArgs 1
btoi
asset_params_get AssetTotal
pop
pop
b ok
box:
txna ApplicationArgs 1
pushbytes "v"
box_put
b ok
holding:
txna ApplicationArgs 1
txna ApplicationArgs 2
btoi
asset_holding_get AssetBalance
pop
pop
b ok
local:
txna ApplicationArgs 1
txna ApplicationArgs 2
btoi
app_opted_in
pop
b ok
ok:
pushint 1
return
`;

const CLEAR = `#pragma version 10
pushint 1
`;

const enc = (s: string) => new TextEncoder().encode(s);
const u64 = (n: bigint) => algosdk.encodeUint64(n);

describe("App call resource population", () => {
  const localnet = new Localnet();
  let sender: algosdk.AddressWithTransactionSigner;
  let appId: bigint;
  let otherAppId: bigint;
  let assetId: bigint;
  const otherAccount = algosdk.generateAccount().addr;

  async function compile(teal: string) {
    const { result } = await localnet.algod.compile(teal).do();
    return new Uint8Array(Buffer.from(result, "base64"));
  }

  async function createApp() {
    const result = await localnet
      .composer()
      .addAppCreate({
        sender,
        approvalProgram: await compile(APPROVAL),
        clearProgram: await compile(CLEAR),
      })
      .execute(localnet.algod);
    const info = await localnet.algod
      .pendingTransactionInformation(result.txIDs[0] ?? "")
      .do();
    if (info.applicationIndex === undefined) throw Error("App not created");
    return info.applicationIndex;
  }

  beforeAll(async () => {
    sender = await localnet.dispenser();
    appId = await createApp();
    otherAppId = await createApp();

    const created = await localnet
      .composer()
      .addAssetCreate({ sender, total: 1n, decimals: 0 })
      .execute(localnet.algod);
    const info = await localnet.algod
      .pendingTransactionInformation(created.txIDs[0] ?? "")
      .do();
    if (info.assetIndex === undefined) throw Error("Asset not created");
    assetId = info.assetIndex;

    // Box MBR
    await localnet.fundAccount(
      algosdk.getApplicationAddress(appId),
      1_000_000n,
    );
  });

  const cases: Array<[string, () => Uint8Array[]]> = [
    ["account", () => [enc("acct"), otherAccount.publicKey]],
    ["app", () => [enc("app"), u64(otherAppId)]],
    ["asset", () => [enc("asset"), u64(assetId)]],
    ["box", () => [enc("box"), enc("someBox")]],
    [
      "asset holding",
      () => [enc("holding"), otherAccount.publicKey, u64(assetId)],
    ],
    [
      "app local",
      () => [enc("local"), otherAccount.publicKey, u64(otherAppId)],
    ],
  ];

  for (const [name, appArgs] of cases) {
    it(`populates an unreferenced ${name}`, async () => {
      const result = await localnet
        .composer()
        .addAppNoOp({ sender, appID: appId, appArgs: appArgs() })
        .execute(localnet.algod);
      expect(result.txIDs.length).toBe(1);
    });

    it(`fails on an unreferenced ${name} when population is disabled`, async () => {
      const composer = new Composer({
        getSuggestedParams: () => localnet.algod.getTransactionParams().do(),
        populateAppCallResources: false,
      });
      composer.addAppNoOp({ sender, appID: appId, appArgs: appArgs() });
      const error = await composer.execute(localnet.algod).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /unavailable|invalid Box reference/,
      );
    });
  }

  it("places resources across the group's app calls", async () => {
    const txns = await localnet
      .composer()
      .addAppNoOp({ sender, appID: appId, appArgs: [enc("box"), enc("a")] })
      .addAppNoOp({
        sender,
        appID: appId,
        appArgs: [enc("holding"), otherAccount.publicKey, u64(assetId)],
      })
      .buildGroup(localnet.algod);

    const refs = txns.map((t) => t.txn.applicationCall);
    const boxes = refs.flatMap((r) => r?.boxes ?? []);
    expect(boxes.map((b) => new TextDecoder().decode(b.name))).toEqual(["a"]);
    const accounts = refs.flatMap((r) => r?.accounts ?? []);
    expect(accounts.map((a) => a.toString())).toEqual([
      otherAccount.toString(),
    ]);
    const assets = refs.flatMap((r) => r?.foreignAssets ?? []);
    expect(assets).toEqual([assetId]);
    // The holding's account and asset must share a transaction
    const holdingTxn = refs.find((r) => r?.foreignAssets.includes(assetId));
    expect(holdingTxn?.accounts.map((a) => a.toString())).toEqual([
      otherAccount.toString(),
    ]);
  });

  it("returns populated resources via simulate", async () => {
    const { simulateResponse } = await localnet
      .composer()
      .addAppNoOp({
        sender,
        appID: appId,
        appArgs: [enc("app"), u64(otherAppId)],
      })
      .simulate(localnet.algod);
    const group = simulateResponse.txnGroups[0];
    expect(group?.failureMessage).toBeUndefined();
    expect(group?.unnamedResourcesAccessed).toBeUndefined();
  });
});

describe("populateAppCallResources", () => {
  const sender = algosdk.generateAccount().addr;
  const suggestedParams: algosdk.SuggestedParams = {
    fee: 0n,
    minFee: 1_000n,
    firstValid: 1n,
    lastValid: 1_000n,
    genesisHash: new Uint8Array(32),
    flatFee: true,
  };
  const appCall = (opts?: Partial<{ accounts: algosdk.Address[] }>) =>
    algosdk.makeApplicationNoOpTxnFromObject({
      sender,
      appIndex: 1n,
      suggestedParams,
      accounts: opts?.accounts,
    });
  const groupResult = (
    unnamedResourcesAccessed: algosdk.modelsv2.SimulateUnnamedResourcesAccessed,
    txnCount: number,
  ) =>
    new algosdk.modelsv2.SimulateTransactionGroupResult({
      txnResults: Array.from(
        { length: txnCount },
        () =>
          new algosdk.modelsv2.SimulateTransactionResult({
            txnResult: new algosdk.modelsv2.PendingTransactionResponse({
              txn: new algosdk.SignedTransaction({ txn: appCall() }),
              poolError: "",
            }),
          }),
      ),
      unnamedResourcesAccessed,
    });

  it("spills into the next app call once one is full", () => {
    const accounts = Array.from(
      { length: 9 },
      () => algosdk.generateAccount().addr,
    );
    const txns = [appCall(), appCall()];
    populateAppCallResources(
      txns,
      groupResult(
        new algosdk.modelsv2.SimulateUnnamedResourcesAccessed({ accounts }),
        2,
      ),
    );
    expect(txns[0]?.applicationCall?.accounts.length).toBe(8);
    expect(txns[1]?.applicationCall?.accounts.length).toBe(1);
  });

  it("throws when the group has no room left", () => {
    const accounts = Array.from(
      { length: 9 },
      () => algosdk.generateAccount().addr,
    );
    expect(() =>
      populateAppCallResources(
        [appCall()],
        groupResult(
          new algosdk.modelsv2.SimulateUnnamedResourcesAccessed({ accounts }),
          1,
        ),
      ),
    ).toThrow("No more transactions below reference limit");
  });

  it("adds an app local's app to a transaction that already has the account", () => {
    const account = algosdk.generateAccount().addr;
    const txns = [appCall(), appCall({ accounts: [account] })];
    populateAppCallResources(
      txns,
      groupResult(
        new algosdk.modelsv2.SimulateUnnamedResourcesAccessed({
          appLocals: [
            new algosdk.modelsv2.ApplicationLocalReference({
              account,
              app: 5n,
            }),
          ],
          accounts: [account],
          apps: [5n],
        }),
        2,
      ),
    );
    expect(txns[0]?.applicationCall?.foreignApps).toEqual([]);
    expect(txns[1]?.applicationCall?.foreignApps).toEqual([5n]);
    // The account was already referenced, so it is not added again
    expect(txns[1]?.applicationCall?.accounts.length).toBe(1);
  });

  it("adds extra box refs as empty references to the called app", () => {
    const txns = [appCall()];
    populateAppCallResources(
      txns,
      groupResult(
        new algosdk.modelsv2.SimulateUnnamedResourcesAccessed({
          extraBoxRefs: 2,
        }),
        1,
      ),
    );
    expect(txns[0]?.applicationCall?.boxes).toEqual([
      { appIndex: 0n, name: new Uint8Array(0) },
      { appIndex: 0n, name: new Uint8Array(0) },
    ]);
    expect(txns[0]?.applicationCall?.foreignApps).toEqual([]);
  });
});
