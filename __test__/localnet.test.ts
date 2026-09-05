import { describe, it, expect } from "bun:test";
import { Localnet } from "../src/localnet";

describe("Localnet", () => {
  const localnet = new Localnet();
  it("should generate a funded account", async () => {
    const account = await localnet.generateAccount({ fund: 1_000_000n });

    const balance = (
      await localnet.algod.accountInformation(account.address).do()
    ).amount;

    expect(balance).toBe(1_000_000n);
  });
});
