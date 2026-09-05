import algosdk, {
  Algodv2,
  AtomicTransactionComposer,
  AtomicTransactionComposerStatus,
  type AddressWithTransactionSigner,
  type SuggestedParams,
  type TransactionSigner,
} from "algosdk";

type ParamOverrides = {
  suggestedParams?: SuggestedParams;
  sender: AddressWithTransactionSigner;
};

type OverriddenParams = Pick<
  Parameters<typeof algosdk.makePaymentTxnWithSuggestedParamsFromObject>[0],
  "suggestedParams" | "sender"
>;

type Params<SDKMethod extends (...args: any) => any> = Omit<
  Parameters<SDKMethod>[0],
  "suggestedParams" | "sender"
> &
  ParamOverrides;

export type MethodParams = Params<
  typeof AtomicTransactionComposer.prototype.addMethodCall
>;

export type PaymentParams = Params<
  typeof algosdk.makePaymentTxnWithSuggestedParamsFromObject
>;

export type TransactionParams =
  { method: MethodParams } | { pay: PaymentParams };

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
    const { sender, suggestedParams } = params;

    if (suggestedParams === undefined && this.getSuggestedParams == undefined) {
      throw Error(
        "Transaction missing suggestedParams and this.getSuggestedParams is undefined",
      );
    }

    return {
      sender: sender.address,
      suggestedParams: suggestedParams ?? (await this.getSuggestedParams!()),
      signer: sender.txnSigner,
    };
  }

  add(params: TransactionParams) {
    this.pendingParams.push(params);
    return this;
  }

  addPayment(params: PaymentParams) {
    return this.add({ pay: params });
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
        const sdkParams = await this.getSdkParams(p.method);
        this.atc.addMethodCall({ ...p.method, ...sdkParams });
      } else throw Error("TODO");
    }

    return this.atc.buildGroup();
  }

  async execute(algod: Algodv2, roundsToWait: number = 3) {
    await this.buildGroup();
    // TODO: wait until latest last valid by default
    return await this.atc.execute(algod, roundsToWait);
  }
}
