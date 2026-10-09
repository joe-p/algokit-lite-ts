import { describe, it, expect, vi } from "vitest";
import { Localnet } from "../src/localnet";

describe("Localnet client configuration", () => {
  it.each([
    {
      name: "default",
      opts: undefined,
      url: "http://localhost:8980/v2/accounts",
    },
    {
      name: "custom",
      opts: {
        indexer: {
          token: "custom-token",
          host: "http://127.0.0.1",
          port: "9999",
        },
      },
      url: "http://127.0.0.1:9999/v2/accounts",
    },
  ])("should use the $name indexer port", async ({ opts, url }) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ accounts: [], "current-round": 0 }));
    try {
      await new Localnet(opts).indexer.searchAccounts().do();

      expect(fetchSpy).toHaveBeenCalledWith(url, expect.any(Object));
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

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
