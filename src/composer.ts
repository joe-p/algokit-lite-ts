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

export type MethodParams = ARC56MethodParams | StandardMethodParams;

export type PaymentParams = Params<
  typeof algosdk.makePaymentTxnWithSuggestedParamsFromObject
>;

export type TransactionParams =
  { method: MethodParams } | { pay: PaymentParams };

export interface MethodResult extends Omit<algosdk.ABIResult, "returnValue"> {
  returnValue?: unknown;
}

export interface ComposerExecuteResult {
  confirmedRound: bigint;
  txIDs: string[];
  methodResults: MethodResult[];
}

export class Composer {
  private atc: AtomicTransactionComposer = new AtomicTransactionComposer();
  private pendingParams: TransactionParams[] = [];

  getSuggestedParams?: () => Promise<SuggestedParams>;

  constructor(opts: { getSuggestedParams?: () => Promise<SuggestedParams> }) {
    this.getSuggestedParams = opts.getSuggestedParams;
  }

  private async getSdkParams(
    params: ParamOverrides & { signer?: TransactionSigner },
  ): Promise<OverriddenParams & { signer: TransactionSigner }> {
    const { sender } = params;

    const suggestedParams =
      params.suggestedParams ?? (await this.getSuggestedParams?.());
    if (suggestedParams === undefined) {
      throw Error(
        "Transaction missing suggestedParams and this.getSuggestedParams is undefined",
      );
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

  addMethodCall(params: MethodParams) {
    return this.add({ method: params });
  }

  async buildGroup() {
    if (this.atc.getStatus() >= AtomicTransactionComposerStatus.BUILT) {
      return this.atc.buildGroup();
    }

    for (const p of this.pendingParams) {
      if ("pay" in p) {
        const sdkParams = await this.getSdkParams(p.pay);
        const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          ...p.pay,
          ...sdkParams,
        });

        this.atc.addTransaction({ txn, signer: sdkParams.signer });
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
          const encodedArgs = encodeMethodArgs(
            arc56,
            arc56Method,
            rawArgs,
          );

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

          this.atc.addMethodCall({
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
          this.atc.addMethodCall({
            ...rawMethodParams,
            ...sdkParams,
            appID,
            method: p.method.method,
            methodArgs: p.method.methodArgs,
          });
        }
      } else throw Error("TODO");
    }

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
  ): Promise<ComposerExecuteResult> {
    await this.buildGroup();
    // TODO: wait until latest last valid by default
    const result = await this.atc.execute(algod, roundsToWait);

    return {
      confirmedRound: result.confirmedRound,
      txIDs: result.txIDs,
      methodResults: this.decodeResults(result.methodResults),
    };
  }

  async simulate(
    algod: Algodv2,
    request?: algosdk.modelsv2.SimulateRequest,
  ): Promise<{
    methodResults: MethodResult[];
    simulateResponse: algosdk.modelsv2.SimulateResponse;
  }> {
    await this.buildGroup();
    const result = await this.atc.simulate(algod, request);

    return {
      simulateResponse: result.simulateResponse,
      methodResults: this.decodeResults(result.methodResults),
    };
  }
}
