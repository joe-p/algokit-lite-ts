import algosdk, {
  addressWithSignersFromRawEd25519Signer,
  Algodv2,
  Indexer,
  Kmd,
  type Ed25519SigningKey,
} from "algosdk";
import nacl from "tweetnacl";
import { Composer } from "./composer";

export const DEFAULT_LOCALNET_TOKEN = "a".repeat(64);
export const DEFAULT_LOCALNET_HOST = "http://localhost";

export type APIClientOpts = { token: string; host: string; port: string };
export type GenerateAccountOpts = {
  fund?: bigint;
};

interface KmdWalletsResponse {
  wallets: Array<{ id: string; name: string }>;
}

interface KmdInitWalletResponse {
  wallet_handle_token: string;
}

interface KmdListKeysResponse {
  addresses: string[];
}

export class Localnet {
  kmd: Kmd;
  algod: Algodv2;
  indexer: Indexer;

  constructor(opts?: {
    kmd?: APIClientOpts;
    algod?: APIClientOpts;
    indexer?: APIClientOpts;
  }) {
    const kmdToken = opts?.kmd?.token ?? DEFAULT_LOCALNET_TOKEN;
    const kmdServer = opts?.kmd?.host ?? DEFAULT_LOCALNET_HOST;
    const kmdPort = opts?.kmd?.port ?? "4002";

    this.kmd = new algosdk.Kmd(kmdToken, kmdServer, kmdPort);

    const algodToken = opts?.algod?.token ?? DEFAULT_LOCALNET_TOKEN;
    const algodServer = opts?.algod?.host ?? DEFAULT_LOCALNET_HOST;
    const algodPort = opts?.algod?.port ?? "4001";

    this.algod = new algosdk.Algodv2(algodToken, algodServer, algodPort);

    const indexerToken = opts?.indexer?.token ?? DEFAULT_LOCALNET_TOKEN;
    const indexerServer = opts?.indexer?.host ?? DEFAULT_LOCALNET_HOST;
    const indexerPort = opts?.indexer?.port ?? "4001";

    this.indexer = new algosdk.Indexer(
      indexerToken,
      indexerServer,
      indexerPort,
    );
  }

  async fundAccount(receiver: algosdk.Address, amount: bigint) {
    return await this.composer()
      .addPayment({ sender: await this.dispenser(), receiver, amount })
      .execute(this.algod);
  }

  async generateAccount(opts: GenerateAccountOpts) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keypair = nacl.sign.keyPair.fromSeed(seed);
    const signingKey: Ed25519SigningKey = {
      ed25519PublicKey: keypair.publicKey,
      ed25519Signer: (bytesToSign) =>
        Promise.resolve(nacl.sign.detached(bytesToSign, keypair.secretKey)),
    };

    const account = addressWithSignersFromRawEd25519Signer(signingKey);

    if (opts.fund) {
      await this.fundAccount(account.address, opts.fund);
    }

    return account;
  }

  composer() {
    return new Composer({
      algod: this.algod,
      getSuggestedParams: () => {
        return this.algod.getTransactionParams().do();
      },
    });
  }

  async dispenser() {
    const dispenser = (await this.getLocalAccounts())[0];

    if (dispenser === undefined) {
      throw Error("Unable to get dispenser!");
    }

    return dispenser;
  }

  async getLocalAccounts() {
    const kmdClient = this.kmd;

    const wallets = (await kmdClient.listWallets()) as KmdWalletsResponse;

    let walletId: string | undefined;
    for (const wallet of wallets.wallets) {
      if (wallet.name === "unencrypted-default-wallet") walletId = wallet.id;
    }

    if (walletId === undefined)
      throw Error("No wallet named: unencrypted-default-wallet");

    const handleResp = (await kmdClient.initWalletHandle(
      walletId,
      "",
    )) as KmdInitWalletResponse;
    const handle = handleResp.wallet_handle_token;

    const addresses = (await kmdClient.listKeys(handle)) as KmdListKeysResponse;
    const acctPromises: Promise<{ private_key: Uint8Array }>[] = [];

    for (const addr of addresses.addresses) {
      acctPromises.push(kmdClient.exportKey(handle, "", addr));
    }
    const keys = await Promise.all(acctPromises);

    // Don't need to wait for it
    void kmdClient.releaseWalletHandle(handle);

    const accounts = keys.map((k) => {
      const addr = new algosdk.Address(k.private_key.slice(32));
      const acct: algosdk.Account = { sk: k.private_key, addr };

      return algosdk.addressWithSignersFromRawEd25519Signer({
        ed25519PublicKey: acct.addr.publicKey,
        ed25519Signer: (bytesToSign: Uint8Array) =>
          Promise.resolve(nacl.sign.detached(bytesToSign, acct.sk)),
      });
    });

    // kmd lists keys in an arbitrary order, and the sandbox wallet accumulates
    // throwaway accounts from the test suites that share it. Examples index into
    // this list expecting well-funded accounts, so order by balance. Accounts
    // that were rekeyed away sort last: their exported key can no longer
    // authorize them.
    const zeroAddress = algosdk.Address.zeroAddress().toString();
    const spendable = new Map<string, bigint>();
    await Promise.all(
      accounts.map(async (account) => {
        const address = account.address.toString();
        const info = await this.algod.accountInformation(address).do();
        const authAddr = info.authAddr ? info.authAddr.toString() : zeroAddress;
        const signable = authAddr === zeroAddress || authAddr === address;
        spendable.set(address, signable ? info.amount : BigInt(-1));
      }),
    );
    accounts.sort((a, b) => {
      const balanceA = spendable.get(a.address.toString()) ?? BigInt(0);
      const balanceB = spendable.get(b.address.toString()) ?? BigInt(0);
      if (balanceA === balanceB) return 0;
      return balanceA > balanceB ? -1 : 1;
    });

    return accounts;
  }
}
