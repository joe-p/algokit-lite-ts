import algosdk, {
  Algodv2,
  AtomicTransactionComposer,
  AtomicTransactionComposerStatus,
  SignedTransaction,
  type AddressWithTransactionSigner,
  type SuggestedParams,
  type TransactionSigner,
  type TransactionWithSigner,
} from "algosdk";
import type { ARC56Contract } from "./types/arc56";
import {
  decodeMethodReturnValue,
  encodeMethodArgs,
  getAbiMethod,
} from "./arc56_utils";

const USAGE_SCALE = 1_000_000n;
export const BASE_USAGE = 1_000_000n;

// Equivalent to protocol FeeForUsage(usage, minFee, 0): the fee that a given
// amount of usage (groupUsage units) is charged.
const feeForUsage = (usage: bigint, minFee: bigint): bigint =>
  (usage * minFee + USAGE_SCALE - 1n) / USAGE_SCALE;

type ParamOverrides = {
  suggestedParams?: SuggestedParams;
  sender: AddressWithTransactionSigner;
  signer?: TransactionSigner;
  /**
   * Pay exactly this many microAlgos of fee, ignoring the suggested fee. Use it
   * both for transactions that pay nothing, such as logic signature calls, and
   * for the transaction that covers them.
   */
  staticFee?: bigint;
  /**
   * Let this transaction's fee rise to cover up to this much group usage, so it
   * can pay for other transactions in the group that pay nothing themselves.
   * One transaction's worth of usage is `BASE_USAGE`.
   */
  maxUsage?: bigint;
};

type OverriddenParams = Pick<
  Parameters<typeof algosdk.makePaymentTxnWithSuggestedParamsFromObject>[0],
  "suggestedParams" | "sender"
>;

type Params<SDKMethod extends (...args: never[]) => unknown> = Omit<
  Parameters<SDKMethod>[0],
  "suggestedParams" | "sender" | "signer"
> &
  ParamOverrides;

type AppIdParams =
  | { appID: number | bigint; appId?: number | bigint }
  | { appID?: number | bigint; appId: number | bigint };

export type BaseMethodParams = Omit<
  Parameters<typeof AtomicTransactionComposer.prototype.addMethodCall>[0],
  "suggestedParams" | "sender" | "signer" | "method" | "methodArgs" | "appID"
> &
  ParamOverrides &
  AppIdParams;

export type ARC56MethodParams = BaseMethodParams & {
  arc56: ARC56Contract;
  method: algosdk.ABIMethod | string;
  methodArgs?: unknown[];
};

export type StandardMethodParams = BaseMethodParams & {
  arc56?: undefined;
  method: algosdk.ABIMethod;
  methodArgs?: algosdk.ABIArgument[];
};

declare const methodReturnType: unique symbol;

export type MethodParams<TReturn = unknown> = (
  ARC56MethodParams | StandardMethodParams
) & {
  readonly [methodReturnType]?: TReturn;
};

export type PaymentParams = Params<
  typeof algosdk.makePaymentTxnWithSuggestedParamsFromObject
>;

export type AppCreateParams = Params<
  typeof algosdk.makeApplicationCreateTxnFromObject
>;

export type TransactionParams =
  | { method: MethodParams }
  | { pay: PaymentParams }
  | { appCreate: AppCreateParams }
  | { txn: algosdk.TransactionWithSigner };

/** The overridable params of a transaction this composer builds itself */
function paramOverridesOf(
  p: Exclude<TransactionParams, { txn: algosdk.TransactionWithSigner }>,
): ParamOverrides {
  if ("pay" in p) return p.pay;
  if ("appCreate" in p) return p.appCreate;
  return p.method;
}

export interface MethodResult<TReturn = unknown> extends Omit<
  algosdk.ABIResult,
  "returnValue"
> {
  returnValue?: TReturn;
}

export type MethodResults<TReturns extends unknown[]> = TReturns extends []
  ? MethodResult[]
  : { [K in keyof TReturns]: MethodResult<TReturns[K]> };

export interface ComposerExecuteResult<TReturns extends unknown[] = unknown[]> {
  confirmedRound: bigint;
  txIDs: string[];
  methodResults: MethodResults<TReturns>;
}

export class Composer<TReturns extends unknown[] = []> {
  private atc: AtomicTransactionComposer = new AtomicTransactionComposer();
  private pendingParams: TransactionParams[] = [];
  private txnInfo: { maxUsage?: bigint }[] = [];

  /**
   * Called once per transaction that does not carry its own suggestedParams.
   * Caching is up to this function.
   */
  getSuggestedParams?: () => Promise<SuggestedParams>;

  constructor(opts: { getSuggestedParams?: () => Promise<SuggestedParams> }) {
    this.getSuggestedParams = opts.getSuggestedParams;
  }

  private async getSdkParams(
    params: ParamOverrides & { signer?: TransactionSigner },
  ): Promise<OverriddenParams & { signer: TransactionSigner }> {
    const { sender } = params;

    let suggestedParams =
      params.suggestedParams ?? (await this.getSuggestedParams?.());
    if (suggestedParams === undefined) {
      throw Error(
        "Transaction missing suggestedParams and this.getSuggestedParams is undefined",
      );
    }

    if (params.staticFee !== undefined) {
      suggestedParams = {
        ...suggestedParams,
        fee: params.staticFee,
        flatFee: true,
      };
    }

    return {
      sender: sender.address,
      suggestedParams,
      signer: params.signer ?? sender.txnSigner,
    };
  }

  /**
   * Convert a method argument that an ABI method expects to be a transaction
   * into a TransactionWithSigner. A `pay` argument may be supplied as a
   * PaymentParams object, in which case this builder constructs the payment
   * transaction. All other transaction types must already be built.
   */
  private async buildTxnArg(
    arg: unknown,
    argType: string,
  ): Promise<{
    arg: algosdk.TransactionWithSigner;
    txnInfo?: { maxUsage?: bigint };
  }> {
    if (algosdk.isTransactionWithSigner(arg)) {
      return { arg, txnInfo: {} };
    }

    if (argType === "pay") {
      const paymentParams = arg as PaymentParams;
      const sdkParams = await this.getSdkParams(paymentParams);
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        ...paymentParams,
        ...sdkParams,
      });
      return {
        arg: { txn, signer: sdkParams.signer },
        txnInfo: { maxUsage: paymentParams.maxUsage },
      };
    }

    throw new Error(
      `Unsupported transaction type "${argType}" for method argument. Expected a TransactionWithSigner.`,
    );
  }

  add(params: TransactionParams) {
    this.pendingParams.push(params);
    return this;
  }

  addPayment(params: PaymentParams) {
    return this.add({ pay: params });
  }

  /** Create an application with a bare (non-ABI) call */
  addAppCreate(params: AppCreateParams) {
    return this.add({ appCreate: params });
  }

  /** Add a transaction that has already been built */
  addTransaction(txn: algosdk.TransactionWithSigner): this;
  addTransaction(txn: algosdk.Transaction, signer: TransactionSigner): this;
  addTransaction(
    txn: algosdk.Transaction | algosdk.TransactionWithSigner,
    signer?: TransactionSigner,
  ) {
    if (algosdk.isTransactionWithSigner(txn)) {
      return this.add({ txn });
    }
    if (signer === undefined) {
      throw Error(
        "A TransactionSigner is required when adding a Transaction that has no signer attached",
      );
    }
    return this.add({ txn: { txn, signer } });
  }

  addMethodCall<TReturn>(
    params: MethodParams<TReturn>,
  ): Composer<[...TReturns, TReturn]> {
    this.add({ method: params });
    return this as unknown as Composer<[...TReturns, TReturn]>;
  }

  /** (Re)compute the group ID of a group whose transactions were mutated after building */
  private static regroup(txns: algosdk.Transaction[]) {
    if (txns.length < 2) return;
    // The group ID is computed over transactions with an empty group field
    for (const txn of txns) txn.group = undefined;
    algosdk.assignGroupID(txns);
  }

  private async simulateForInfo(algod: Algodv2) {
    const minFee = (await algod.getTransactionParams().do()).minFee;
    const simAtc = this.atc.clone();
    const simTxns = simAtc.buildGroup().map((t) => t.txn);
    let addedFees = 0n;

    // Simulate will fail if it doesn't have enough fees, so we will
    // max out the fees on each txn before simulating
    for (const [i, txn] of simTxns.entries()) {
      const maxUsage = this.txnInfo[i]?.maxUsage;
      if (maxUsage) {
        const maxFee = feeForUsage(maxUsage, minFee);
        if (maxFee > txn.fee) {
          addedFees += maxFee - txn.fee;
          txn.fee = maxFee;
        }
      }
    }

    Composer.regroup(simTxns);

    const simulateResponse = await algod
      .simulateTransactions(
        new algosdk.modelsv2.SimulateRequest({
          allowEmptySignatures: true,
          fixSigners: true,
          txnGroups: [
            new algosdk.modelsv2.SimulateRequestTransactionGroup({
              // NOTE: Right now we do not account for non ed signatures
              // I think the path forward here is attaching an optional second
              // signer specifically for simulate for each transaction
              txns: simTxns.map((txn) => new SignedTransaction({ txn })),
            }),
          ],
        }),
      )
      .do();

    const groupResponse = simulateResponse.txnGroups[0];
    if (groupResponse === undefined) {
      throw Error("simulate did not include a group response");
    }

    let { failureMessage } = groupResponse;
    if (failureMessage) {
      if (failureMessage.includes("fees is less")) {
        failureMessage +=
          ". You need to increase maxUsage on one or more transactions";
      }
      throw new Error(failureMessage);
    }

    const { groupUsage, groupFeesPaid } = groupResponse;

    const usage = BigInt(groupUsage ?? 0);
    const paid = BigInt(groupFeesPaid ?? 0) - addedFees;

    const requiredFees = feeForUsage(usage, minFee);
    let feeNeeded = requiredFees > paid ? requiredFees - paid : 0n;
    if (feeNeeded === 0n) return;

    const txns = this.atc.buildGroup().map((t) => t.txn);

    // Distribute the required group fee across the transactions
    //
    // Right now it just starts at index 0 and keeps adding fees until its done
    // This means that txns in the beginning of the group may end up paying more
    // than at the end (if they all have the same max usage)
    //
    // Some alternatives
    //
    // 1. Increase fees in proportion to the txns maxUsage. Higher maxUsage pays more, but
    // all txns still contribute
    //
    // 2. Increase fees inversely proportional to the txns flat fee. Txns that already
    // contribute a lot to the group fees don't need to pay much extra
    //
    // 3. Some combination of the above
    for (const [i, txn] of txns.entries()) {
      const maxUsage = this.txnInfo[i]?.maxUsage;
      if (maxUsage) {
        const maxFee = feeForUsage(maxUsage, minFee);
        if (maxFee > txn.fee) {
          const maxAddable = maxFee - txn.fee;
          const amountToAdd = feeNeeded < maxAddable ? feeNeeded : maxAddable;
          txn.fee += amountToAdd;
          feeNeeded -= amountToAdd;
        }
      }

      if (feeNeeded === 0n) break;
    }

    // Fees changed after the group was built, so the group ID must be recomputed
    Composer.regroup(txns);
  }

  private async _buildGroup(algod?: Algodv2) {
    if (this.atc.getStatus() >= AtomicTransactionComposerStatus.BUILT) {
      return this.atc.buildGroup();
    }

    const { atc } = this;
    for (const p of this.pendingParams) {
      if ("txn" in p) {
        // Already built, so its fee is fixed and cannot cover anything else
        atc.addTransaction(p.txn);
        continue;
      }

      if ("pay" in p) {
        const sdkParams = await this.getSdkParams(p.pay);
        const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          ...p.pay,
          ...sdkParams,
        });

        atc.addTransaction({ txn, signer: sdkParams.signer });
      } else if ("appCreate" in p) {
        const sdkParams = await this.getSdkParams(p.appCreate);
        const txn = algosdk.makeApplicationCreateTxnFromObject({
          ...p.appCreate,
          ...sdkParams,
        });

        atc.addTransaction({ txn, signer: sdkParams.signer });
      } else if ("method" in p) {
        const { arc56, appId, ...rawMethodParams } = p.method;
        const sdkParams = await this.getSdkParams(p.method);
        const appID = p.method.appID ?? appId;
        if (appID === undefined) {
          throw new Error("appID (or appId) is required for method call");
        }

        if (arc56) {
          const { abiMethod, arc56Method } = getAbiMethod(
            arc56,
            p.method.method,
          );
          const rawArgs = p.method.methodArgs ?? [];
          const encodedArgs = encodeMethodArgs(arc56, arc56Method, rawArgs);
          // ABI methods can take transactions as arguments (e.g. `pay`).
          // Let the caller pass a PaymentParams object and build the
          // transaction here, where we have access to the composer's params.
          for (let i = 0; i < rawArgs.length; i++) {
            const argType = arc56Method.args[i]?.type;
            if (!algosdk.abiTypeIsTransaction(argType)) continue;
            const built = await this.buildTxnArg(rawArgs[i], argType);
            encodedArgs[i] = built.arg;
            if (built.txnInfo !== undefined) {
              this.txnInfo.push(built.txnInfo);
            }
          }

          let boxes = p.method.boxes;
          if (boxes === undefined && arc56Method.recommendations?.boxes) {
            const recBoxes = Array.isArray(arc56Method.recommendations.boxes)
              ? arc56Method.recommendations.boxes
              : [arc56Method.recommendations.boxes];
            boxes = recBoxes.map((b) => ({
              appIndex: b.app ?? 0,
              name: new Uint8Array(Buffer.from(b.key, "base64")),
            }));
          }

          const appAccounts =
            p.method.appAccounts ??
            (arc56Method.recommendations?.accounts
              ? arc56Method.recommendations.accounts
              : undefined);

          const appForeignApps =
            p.method.appForeignApps ??
            (arc56Method.recommendations?.apps
              ? arc56Method.recommendations.apps.map(BigInt)
              : undefined);

          const appForeignAssets =
            p.method.appForeignAssets ??
            (arc56Method.recommendations?.assets
              ? arc56Method.recommendations.assets.map(BigInt)
              : undefined);

          atc.addMethodCall({
            ...rawMethodParams,
            ...sdkParams,
            appID,
            method: abiMethod,
            methodArgs: encodedArgs,
            ...(boxes !== undefined ? { boxes } : {}),
            ...(appAccounts !== undefined ? { appAccounts } : {}),
            ...(appForeignApps !== undefined ? { appForeignApps } : {}),
            ...(appForeignAssets !== undefined ? { appForeignAssets } : {}),
          });
        } else {
          if (typeof p.method.method === "string") {
            throw new Error(
              "ARC56 definition is required when method is specified as a string",
            );
          }
          const { methodArgs } = p.method;
          if (methodArgs)
            for (const arg of methodArgs) {
              if (typeof arg === "object" && "txn" in arg) {
                this.txnInfo.push({});
              }
            }
          atc.addMethodCall({
            ...rawMethodParams,
            ...sdkParams,
            appID,
            method: p.method.method,
            methodArgs: p.method.methodArgs,
          });
        }
      } else throw Error("Unsupported transaction params");

      this.txnInfo.push({ maxUsage: paramOverridesOf(p).maxUsage });
    }

    if (algod) {
      await this.simulateForInfo(algod);
    }

    return this.atc.buildGroup();
  }

  async buildGroup(algod: Algodv2) {
    return this._buildGroup(algod);
  }

  buildGroupOffline() {
    return this._buildGroup();
  }

  private decodeResults(methodResults: algosdk.ABIResult[]): MethodResult[] {
    const methodCalls = this.pendingParams
      .filter((p): p is { method: MethodParams } => "method" in p)
      .map((p) => p.method);

    return methodResults.map((mr, idx) => {
      const callParams = methodCalls[idx];
      if (!callParams?.arc56) {
        return mr;
      }

      const arc56 = callParams.arc56;

      const methodDef = arc56.methods.find((m) => {
        if (typeof callParams.method === "string") {
          return m.name === callParams.method.split("(")[0];
        }
        return m.name === callParams.method.name;
      });

      if (!methodDef) {
        return mr;
      }

      if (methodDef.returns.type === "void") {
        return {
          ...mr,
          returnValue: undefined,
        };
      }

      if (mr.rawReturnValue.length > 0) {
        try {
          const returnValue = decodeMethodReturnValue(
            arc56,
            methodDef.name,
            mr.rawReturnValue,
          );
          return {
            ...mr,
            returnValue,
            decodeError: undefined,
          };
        } catch (e) {
          return {
            ...mr,
            decodeError: e as Error,
          };
        }
      }

      return mr;
    });
  }

  async execute(
    algod: Algodv2,
    roundsToWait: number = 3,
  ): Promise<ComposerExecuteResult<TReturns>> {
    await this.buildGroup(algod);
    // TODO: wait until latest last valid by default
    const result = await this.atc.execute(algod, roundsToWait);

    return {
      confirmedRound: result.confirmedRound,
      txIDs: result.txIDs,
      methodResults: this.decodeResults(
        result.methodResults,
      ) as MethodResults<TReturns>,
    };
  }

  async simulate(
    algod: Algodv2,
    request?: algosdk.modelsv2.SimulateRequest,
  ): Promise<{
    methodResults: MethodResults<TReturns>;
    simulateResponse: algosdk.modelsv2.SimulateResponse;
  }> {
    await this.buildGroup(algod);
    const result = await this.atc.simulate(algod, request);

    return {
      simulateResponse: result.simulateResponse,
      methodResults: this.decodeResults(
        result.methodResults,
      ) as MethodResults<TReturns>,
    };
  }
}
