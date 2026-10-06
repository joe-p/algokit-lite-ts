import algosdk, { Address, TransactionType } from "algosdk";

type UnnamedResources = algosdk.modelsv2.SimulateUnnamedResourcesAccessed;

/** Most accounts an app call may reference (MaxAppTxnAccounts) */
export const MAX_ACCOUNT_REFERENCES = 8;
/** Most accounts, apps, assets and boxes an app call may reference in total (MaxAppTotalTxnReferences) */
export const MAX_TOTAL_REFERENCES = 8;

type ReferenceArrays = Pick<
  algosdk.ApplicationTransactionFields,
  "accounts" | "foreignApps" | "foreignAssets" | "boxes"
>;

type GroupResource =
  | { type: "account"; account: Address }
  | { type: "app"; app: bigint }
  | { type: "asset"; asset: bigint }
  | { type: "box"; app: bigint; name: Uint8Array }
  | { type: "appLocal"; app: bigint; account: Address }
  | { type: "assetHolding"; asset: bigint; account: Address };

// Plain comparison rather than localeCompare so ordering is the same in every environment
const compare = (a: string | bigint, b: string | bigint) =>
  a < b ? -1 : a > b ? 1 : 0;

const isAppCall = (txn: algosdk.Transaction) =>
  txn.type === TransactionType.appl && txn.applicationCall !== undefined;

// Resources can only be added to the legacy reference arrays, which cannot be
// combined with an access list
const usesAccessList = (txn: algosdk.Transaction) =>
  (txn.applicationCall?.access.length ?? 0) > 0;

function refCount(txn: algosdk.Transaction): number {
  const ac = txn.applicationCall;
  if (ac === undefined) return 0;
  return (
    ac.accounts.length +
    ac.foreignApps.length +
    ac.foreignAssets.length +
    ac.boxes.length
  );
}

function addRefs(txn: algosdk.Transaction, refs: Partial<ReferenceArrays>) {
  const ac = txn.applicationCall;
  if (ac === undefined) throw Error("Cannot add references to a non app call");
  // applicationCall is readonly on Transaction, but replacing it is the only
  // way to add references to a built transaction
  (
    txn as { applicationCall: algosdk.ApplicationTransactionFields }
  ).applicationCall = {
    ...ac,
    accounts: [...ac.accounts, ...(refs.accounts ?? [])],
    foreignApps: [...ac.foreignApps, ...(refs.foreignApps ?? [])],
    foreignAssets: [...ac.foreignAssets, ...(refs.foreignAssets ?? [])],
    boxes: [...ac.boxes, ...(refs.boxes ?? [])],
  };
}

const hasApp = (txn: algosdk.Transaction, app: bigint) =>
  txn.applicationCall?.appIndex === app ||
  (txn.applicationCall?.foreignApps.includes(app) ?? false);

const hasAsset = (txn: algosdk.Transaction, asset: bigint) =>
  txn.applicationCall?.foreignAssets.includes(asset) ?? false;

function hasAccount(txn: algosdk.Transaction, account: Address): boolean {
  const ac = txn.applicationCall;
  if (ac === undefined) return false;
  const available = [
    txn.sender,
    ...ac.accounts,
    algosdk.getApplicationAddress(ac.appIndex),
    ...ac.foreignApps.map((app) => algosdk.getApplicationAddress(app)),
  ];
  return available.some((a) => a.equals(account));
}

/** Sort resources so population is deterministic */
function sortResources(r: UnnamedResources) {
  r.accounts?.sort((a, b) => compare(a.toString(), b.toString()));
  r.assets?.sort(compare);
  r.apps?.sort(compare);
  r.boxes?.sort((a, b) =>
    compare(
      `${a.app}-${Buffer.from(a.name).toString("hex")}`,
      `${b.app}-${Buffer.from(b.name).toString("hex")}`,
    ),
  );
  r.appLocals?.sort((a, b) =>
    compare(
      `${a.app}-${a.account.toString()}`,
      `${b.app}-${b.account.toString()}`,
    ),
  );
  r.assetHoldings?.sort((a, b) =>
    compare(
      `${a.asset}-${a.account.toString()}`,
      `${b.asset}-${b.account.toString()}`,
    ),
  );
}

/**
 * Add resources that only a single transaction may use (i.e. those accessed
 * before resource sharing applies) to that transaction's reference arrays
 */
function populateTxnResources(
  txn: algosdk.Transaction,
  r: UnnamedResources,
  idx: number,
) {
  if (r.boxes?.length || r.extraBoxRefs) {
    throw Error(
      `Unexpected boxes at the transaction level (transaction ${idx})`,
    );
  }
  if (r.appLocals?.length) {
    throw Error(
      `Unexpected app local at the transaction level (transaction ${idx})`,
    );
  }
  if (r.assetHoldings?.length) {
    throw Error(
      `Unexpected asset holding at the transaction level (transaction ${idx})`,
    );
  }

  addRefs(txn, {
    accounts: r.accounts ?? [],
    foreignApps: r.apps ?? [],
    foreignAssets: r.assets ?? [],
  });

  if ((txn.applicationCall?.accounts.length ?? 0) > MAX_ACCOUNT_REFERENCES) {
    throw Error(
      `Account reference limit of ${MAX_ACCOUNT_REFERENCES} exceeded in transaction ${idx}`,
    );
  }
  if (refCount(txn) > MAX_TOTAL_REFERENCES) {
    throw Error(
      `Resource reference limit of ${MAX_TOTAL_REFERENCES} exceeded in transaction ${idx}`,
    );
  }
}

/** Add a resource that any app call in the group may reference */
function populateGroupResource(
  txns: algosdk.Transaction[],
  resource: GroupResource,
) {
  const candidates = txns.filter((t) => isAppCall(t) && !usesAccessList(t));
  const belowLimit = (t: algosdk.Transaction) =>
    refCount(t) < MAX_TOTAL_REFERENCES;
  const accountsBelowLimit = (t: algosdk.Transaction) =>
    (t.applicationCall?.accounts.length ?? 0) < MAX_ACCOUNT_REFERENCES;

  // Cross-product resources (locals and holdings) are only available when the
  // account and the app or asset are in the same transaction, so prefer a
  // transaction that already has one of them and only needs the other
  if (resource.type === "appLocal" || resource.type === "assetHolding") {
    const withAccount = candidates.find(
      (t) => belowLimit(t) && hasAccount(t, resource.account),
    );
    if (withAccount) {
      if (resource.type === "appLocal") {
        addRefs(withAccount, { foreignApps: [resource.app] });
      } else {
        addRefs(withAccount, { foreignAssets: [resource.asset] });
      }
      return;
    }

    const withAppOrAsset = candidates.find(
      (t) =>
        belowLimit(t) &&
        accountsBelowLimit(t) &&
        (resource.type === "appLocal"
          ? hasApp(t, resource.app)
          : hasAsset(t, resource.asset)),
    );
    if (withAppOrAsset) {
      addRefs(withAppOrAsset, { accounts: [resource.account] });
      return;
    }
  }

  // A box is available in any transaction that has its app available
  if (resource.type === "box") {
    const withApp = candidates.find(
      (t) => belowLimit(t) && hasApp(t, resource.app),
    );
    if (withApp) {
      addRefs(withApp, {
        boxes: [{ appIndex: resource.app, name: resource.name }],
      });
      return;
    }
  }

  const txn = candidates.find((t) => {
    const total = refCount(t);
    switch (resource.type) {
      case "account":
        return accountsBelowLimit(t) && total < MAX_TOTAL_REFERENCES;
      // Needs room for both the account and the app or asset
      case "appLocal":
      case "assetHolding":
        return accountsBelowLimit(t) && total < MAX_TOTAL_REFERENCES - 1;
      // Needs room for both the box and its app, unless the box belongs to the
      // called app (app 0)
      case "box":
        return resource.app === 0n
          ? total < MAX_TOTAL_REFERENCES
          : total < MAX_TOTAL_REFERENCES - 1;
      default:
        return total < MAX_TOTAL_REFERENCES;
    }
  });

  if (txn === undefined) {
    throw Error(
      "No more transactions below reference limit. Add another app call to the group.",
    );
  }

  switch (resource.type) {
    case "account":
      addRefs(txn, { accounts: [resource.account] });
      break;
    case "app":
      addRefs(txn, { foreignApps: [resource.app] });
      break;
    case "asset":
      addRefs(txn, { foreignAssets: [resource.asset] });
      break;
    case "box":
      addRefs(txn, {
        boxes: [{ appIndex: resource.app, name: resource.name }],
        foreignApps: resource.app === 0n ? [] : [resource.app],
      });
      break;
    case "appLocal":
      addRefs(txn, {
        accounts: [resource.account],
        foreignApps: [resource.app],
      });
      break;
    case "assetHolding":
      addRefs(txn, {
        accounts: [resource.account],
        foreignAssets: [resource.asset],
      });
      break;
  }
}

/**
 * Add the resources that a successful simulation (run with
 * allowUnnamedResources) reported as accessed but not referenced to the app
 * calls' reference arrays. The transactions are mutated in place, so their
 * group ID must be recomputed afterwards. App calls that use an access list
 * are left untouched.
 *
 * @returns whether any transaction was changed
 */
export function populateAppCallResources(
  txns: algosdk.Transaction[],
  groupResult: algosdk.modelsv2.SimulateTransactionGroupResult,
): boolean {
  let changed = false;

  for (const [i, txnResult] of groupResult.txnResults.entries()) {
    const r = txnResult.unnamedResourcesAccessed;
    const txn = txns[i];
    if (r === undefined || txn === undefined) continue;
    if (!isAppCall(txn) || usesAccessList(txn)) continue;
    populateTxnResources(txn, r, i);
    changed = true;
  }

  const g = groupResult.unnamedResourcesAccessed;
  if (g === undefined) return changed;
  sortResources(g);

  let accounts = g.accounts ?? [];
  let apps = g.apps ?? [];
  let assets = g.assets ?? [];
  const resources: GroupResource[] = [];

  // Cross-product resources go first since they are the most restrictive in
  // terms of which transactions can hold them. Anything they make available
  // no longer needs its own reference.
  for (const { app, account } of g.appLocals ?? []) {
    resources.push({ type: "appLocal", app, account });
    accounts = accounts.filter((a) => !a.equals(account));
    apps = apps.filter((a) => a !== app);
  }
  for (const { asset, account } of g.assetHoldings ?? []) {
    resources.push({ type: "assetHolding", asset, account });
    accounts = accounts.filter((a) => !a.equals(account));
    assets = assets.filter((a) => a !== asset);
  }

  // Accounts next since they have their own, separate limit
  for (const account of accounts) resources.push({ type: "account", account });

  for (const { app, name } of g.boxes ?? []) {
    resources.push({ type: "box", app, name });
    apps = apps.filter((a) => a !== app);
  }
  for (const asset of assets) resources.push({ type: "asset", asset });
  for (const app of apps) resources.push({ type: "app", app });

  // Each extra box ref grants more box I/O quota. An empty reference to the
  // called app is enough.
  for (let i = 0; i < (g.extraBoxRefs ?? 0); i++) {
    resources.push({ type: "box", app: 0n, name: new Uint8Array(0) });
  }

  for (const resource of resources) {
    populateGroupResource(txns, resource);
    changed = true;
  }

  return changed;
}
