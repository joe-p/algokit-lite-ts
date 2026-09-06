import algosdk, {
  Algodv2,
  AtomicTransactionComposer,
  AtomicTransactionComposerStatus,
  type AddressWithTransactionSigner,
  type SuggestedParams,
  type TransactionSigner,
} from "algosdk";
import type { ARC56Contract } from "./types/arc56";
import {
  decodeMethodReturnValue,
  encodeMethodArgs,
  getAbiMethod,
} from "./arc56_utils";

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

  /** Turn the pending params into transactions on the underlying composer */
  private async innerBuild(): Promise<void> {
    const { atc } = this;
    for (const p of this.pendingParams) {
      if ("txn" in p) {
        atc.addTransaction(p.txn);
      } else if ("pay" in p) {
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
          atc.addMethodCall({
            ...rawMethodParams,
            ...sdkParams,
            appID,
            method: p.method.method,
            methodArgs: p.method.methodArgs,
          });
        }
      } else throw Error("Unsupported transaction params");
    }
  }

  async buildGroup() {
    if (this.atc.getStatus() >= AtomicTransactionComposerStatus.BUILT) {
      return this.atc.buildGroup();
    }

    await this.innerBuild();

    return this.atc.buildGroup();
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
    await this.buildGroup();
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
    await this.buildGroup();
    const result = await this.atc.simulate(algod, request);

    return {
      simulateResponse: result.simulateResponse,
      methodResults: this.decodeResults(
        result.methodResults,
      ) as MethodResults<TReturns>,
    };
  }
}
