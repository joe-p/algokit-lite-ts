import { describe, expect, it, mock } from "bun:test";
import algosdk from "algosdk";
import { Composer } from "../src/composer";

function setup() {
  const account = algosdk.generateAccount();
  const sender = {
    address: account.addr,
    txnSigner: algosdk.makeBasicAccountTransactionSigner(account),
  };
  const suggestedParams: algosdk.SuggestedParams = {
    fee: 0n,
    minFee: 1_000n,
    firstValid: 1n,
    lastValid: 1_000n,
    genesisHash: new Uint8Array(32),
  };
  const getSuggestedParams = mock(() => Promise.resolve(suggestedParams));
  const getTransactionParams = mock(() => Promise.resolve(suggestedParams));
  const simulateTransactions = mock(
    (request: algosdk.modelsv2.SimulateRequest) => {
      const txns = request.txnGroups[0]?.txns ?? [];
      return Promise.resolve(
        new algosdk.modelsv2.SimulateResponse({
          version: 2,
          lastRound: 1n,
          txnGroups: [
            new algosdk.modelsv2.SimulateTransactionGroupResult({
              txnResults: [],
              groupUsage: BigInt(txns.length) * 1_000_000n,
              groupFeesPaid: txns.reduce((sum, t) => sum + t.txn.fee, 0n),
            }),
          ],
        }),
      );
    },
  );
  const sendRawTransaction = mock((txns: Uint8Array[]) => {
    const decoded = txns.map((txn) => algosdk.decodeSignedTransaction(txn).txn);
    expect(decoded.every((txn) => txn.fee >= 1_000n)).toBe(true);
    return Promise.resolve({ txId: decoded[0]?.txID() });
  });
  const algod = {
    getTransactionParams: () => ({ do: getTransactionParams }),
    simulateTransactions: (request: algosdk.modelsv2.SimulateRequest) => ({
      do: () => simulateTransactions(request),
    }),
    sendRawTransaction: (txns: Uint8Array[]) => ({
      do: () => sendRawTransaction(txns),
    }),
    status: () => ({ do: () => Promise.resolve({ lastRound: 1n }) }),
    pendingTransactionInformation: () => ({
      do: () => Promise.resolve({ confirmedRound: 2n }),
    }),
  } as unknown as algosdk.Algodv2;
  const composer = new Composer({ getSuggestedParams }).addPayment({
    sender,
    receiver: sender.address,
    amount: 100_000n,
  });
  return {
    composer,
    algod,
    sender,
    suggestedParams,
    getSuggestedParams,
    getTransactionParams,
    simulateTransactions,
    sendRawTransaction,
  };
}

function failedSimulation() {
  return new algosdk.modelsv2.SimulateResponse({
    version: 2,
    lastRound: 1n,
    txnGroups: [
      new algosdk.modelsv2.SimulateTransactionGroupResult({
        txnResults: [],
        failureMessage: "overspend",
      }),
    ],
  });
}

async function expectFailure(result: Promise<unknown>, message: string) {
  const error: unknown = await result.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected an error");
  expect(error.message).toContain(message);
}

describe("Composer retries", () => {
  for (const first of ["execute", "simulate", "buildGroup"] as const) {
    for (const retry of ["execute", "simulate", "buildGroup"] as const) {
      it(`should retry fee simulation after failed ${first} on ${retry}`, async () => {
        const { composer, algod, simulateTransactions, sendRawTransaction } =
          setup();
        simulateTransactions.mockResolvedValueOnce(failedSimulation());

        if (first === "simulate") {
          const result = await composer.simulate(algod);
          expect(result.simulateResponse.txnGroups[0]?.failureMessage).toBe(
            "overspend",
          );
          expect(result.methodResults).toEqual([]);
        } else {
          await expectFailure(composer[first](algod), "overspend");
        }
        expect(sendRawTransaction).not.toHaveBeenCalled();

        await composer[retry](algod);
        expect(simulateTransactions).toHaveBeenCalledTimes(
          retry === "simulate" ? 3 : 2,
        );
        const group = await composer.buildGroup(algod);
        expect(group).toHaveLength(1);
        expect(group[0]?.txn.fee).toBe(1_000n);
        if (retry === "execute") {
          expect(sendRawTransaction.mock.calls[0]?.[0]).toHaveLength(1);
        }
      });
    }
  }

  it("should repeat a returned failure rather than cache unadjusted fees", async () => {
    const { composer, algod, simulateTransactions } = setup();
    simulateTransactions.mockResolvedValue(failedSimulation());
    await expectFailure(composer.buildGroup(algod), "overspend");
    await expectFailure(composer.buildGroup(algod), "overspend");
    expect(simulateTransactions).toHaveBeenCalledTimes(2);
  });

  for (const failure of ["params", "simulate", "suggestedParams"] as const) {
    it(`should execute each transaction once after thrown ${failure} error`, async () => {
      const {
        composer,
        algod,
        sender,
        suggestedParams,
        getSuggestedParams,
        getTransactionParams,
        simulateTransactions,
        sendRawTransaction,
      } = setup();
      const error = new TypeError("fetch failed");
      if (failure === "params") {
        getTransactionParams.mockRejectedValueOnce(error);
      } else if (failure === "simulate") {
        simulateTransactions.mockRejectedValueOnce(error);
      } else {
        composer.addPayment({
          sender,
          receiver: sender.address,
          amount: 200_000n,
        });
        getSuggestedParams
          .mockResolvedValueOnce(suggestedParams)
          .mockRejectedValueOnce(error);
      }

      await expectFailure(composer.execute(algod), "fetch failed");
      expect(sendRawTransaction).not.toHaveBeenCalled();
      const result = await composer.execute(algod);
      const count = failure === "suggestedParams" ? 2 : 1;
      expect(result.txIDs).toHaveLength(count);
      expect(sendRawTransaction).toHaveBeenCalledTimes(1);
      expect(sendRawTransaction.mock.calls[0]?.[0]).toHaveLength(count);
    });
  }

  it("should discard default fee shares after a thrown simulation", async () => {
    const { composer, algod, sender, simulateTransactions } = setup();
    simulateTransactions.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expectFailure(composer.execute(algod), "fetch failed");
    composer.addPayment({
      sender,
      receiver: sender.address,
      amount: 200_000n,
    });
    const group = await composer.buildGroup(algod);
    expect(group.map((t) => t.txn.fee)).toEqual([1_000n, 1_000n]);
  });

  it("should not duplicate explicit fee shares on retry", async () => {
    const { algod, sender, getSuggestedParams, simulateTransactions } = setup();
    const composer = new Composer({ getSuggestedParams }).addPayment({
      sender,
      receiver: sender.address,
      amount: 100_000n,
      feePercent: 1,
    });
    simulateTransactions.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expectFailure(composer.execute(algod), "fetch failed");
    expect((await composer.execute(algod)).txIDs).toHaveLength(1);
  });

  it("should retry a pre-built transaction without duplicating it", async () => {
    const { algod, sender, suggestedParams, simulateTransactions } = setup();
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: sender.address,
      receiver: sender.address,
      amount: 100_000n,
      suggestedParams: { ...suggestedParams, fee: 1_000n, flatFee: true },
    });
    const composer = new Composer({}).addTransaction(txn, sender.txnSigner);
    simulateTransactions.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expectFailure(composer.execute(algod), "fetch failed");
    expect((await composer.execute(algod)).txIDs).toHaveLength(1);
  });

  it("should not bypass maxUsage on retry or leave pre-built arguments grouped", async () => {
    const { algod, sender, suggestedParams, getSuggestedParams } = setup();
    const payment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: sender.address,
      receiver: sender.address,
      amount: 100_000n,
      suggestedParams: { ...suggestedParams, fee: 0n, flatFee: true },
    });
    const composer = new Composer({ getSuggestedParams }).addMethodCall({
      appID: 1n,
      method: algosdk.ABIMethod.fromSignature("deposit(pay)void"),
      sender,
      methodArgs: [{ txn: payment, signer: sender.txnSigner }],
      feePercent: 1,
      maxUsage: 1_000_000n,
    });
    await expectFailure(composer.buildGroup(algod), "maxUsage exceeded");
    await expectFailure(composer.buildGroup(algod), "maxUsage exceeded");
    expect(payment.group).toBeUndefined();
    expect(payment.fee).toBe(0n);
  });
});
