import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import ts from "typescript";
import * as path from "path";
import type { ARC56AppClientParams } from "@joe-p/algokit-lite-app-client";
import { Composer, type ARC56Contract } from "@joe-p/algokit-lite-composer";
import { ARC56Generator } from "../src/generator";

const arc56: ARC56Contract = {
  arcs: [4, 56],
  name: "Typed",
  structs: {},
  methods: [
    {
      name: "sum",
      args: [
        { name: "a", type: "uint64" },
        { name: "b", type: "uint64" },
      ],
      returns: { type: "uint64" },
      actions: { create: [], call: ["NoOp"] },
    },
    {
      name: "greet",
      args: [{ name: "name", type: "string" }],
      returns: { type: "string" },
      actions: { create: [], call: ["NoOp"] },
    },
    {
      name: "bar",
      args: [{ name: "a", type: "uint64" }],
      returns: { type: "void" },
      actions: { create: [], call: ["NoOp"] },
    },
    {
      name: "bar",
      args: [{ name: "a", type: "string" }],
      returns: { type: "uint64" },
      actions: { create: [], call: ["NoOp"] },
    },
    {
      // Named after a Composer method
      name: "execute",
      args: [],
      returns: { type: "void" },
      actions: { create: [], call: ["NoOp"] },
    },
    {
      name: "register",
      args: [],
      returns: { type: "void" },
      actions: { create: [], call: ["OptIn"] },
    },
    {
      name: "createApplication",
      args: [],
      returns: { type: "void" },
      actions: { create: ["NoOp"], call: [] },
    },
  ],
  state: {
    schema: { global: { ints: 0, bytes: 0 }, local: { ints: 0, bytes: 0 } },
    keys: { global: {}, local: {}, box: {} },
    maps: { global: {}, local: {}, box: {} },
  },
  bareActions: { create: [], call: [] },
};

const account = algosdk.generateAccount();
const sender = {
  address: account.addr,
  txnSigner: algosdk.makeBasicAccountTransactionSigner(account),
};
const suggestedParams: algosdk.SuggestedParams = {
  fee: 1000n,
  minFee: 1000n,
  flatFee: true,
  firstValid: 1n,
  lastValid: 1000n,
  genesisHash: new Uint8Array(32),
  genesisID: "offline",
};

/** Type check the generated client followed by the given usage code */
function typeCheck(code: string): string[] {
  const filename = `${import.meta.dirname}/TypedClient.ts`;
  const config = ts.readConfigFile(
    `${import.meta.dirname}/../tsconfig.json`,
    (file) => ts.sys.readFile(file),
  );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    `${import.meta.dirname}/..`,
  );
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    file,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    file === filename
      ? ts.createSourceFile(file, code, languageVersion, true)
      : getSourceFile(
          file,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
  const program = ts.createProgram([filename], parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("generated typed composer", () => {
  it("generates a method for each callable method", async () => {
    const code = await new ARC56Generator(arc56).generate();
    expect(code).toContain(
      "export class TypedComposer<\n  TReturns extends unknown[] = [],\n> extends Composer<TReturns> {",
    );
    expect(code).toContain("override newComposer(): TypedComposer {");
    const body = code.split("export class TypedComposer")[1] ?? "";
    expect(body).toMatch(/^ {2}sum\(/m);
    expect(body).toMatch(/^ {2}"bar\(uint64\)void"\(/m);
    expect(body).toMatch(/^ {2}"bar\(string\)uint64"\(/m);
    // A method named after a composer member uses its signature
    expect(body).toMatch(/^ {2}"execute\(\)void"\(/m);
    expect(body).not.toMatch(/^ {2}execute\(/m);
    // Create-only methods can't be added to an existing app's composer
    expect(body).not.toContain("createApplication");
  });

  it.each(["toString", "valueOf", "hasOwnProperty"])(
    "uses the full signature for inherited member %s",
    async (name) => {
      const code = await new ARC56Generator({
        ...arc56,
        methods: [
          {
            name,
            args: [],
            returns: { type: "uint64" },
            actions: { create: [], call: ["NoOp"] },
          },
        ],
      }).generate();
      const body = code.split("export class TypedComposer")[1] ?? "";
      expect(body).toContain(`"${name}()uint64"(`);
      expect(typeCheck(code)).toEqual([]);
    },
  );

  it("type checks and infers the return type of each call", async () => {
    const code = await new ARC56Generator(arc56).generate();
    const usage = `
declare const client: TypedClient;
declare const sender: algosdk.AddressWithTransactionSigner;
// The params of a method of another client's app
declare const otherParams: MethodParams<{ other: true }>;
async function usage() {
  const result = await client
    .newComposer()
    .sum({ sender, args: { a: 1n, b: 2n } })
    .addPayment({ sender, receiver: sender.address, amount: 0n })
    .greet({ sender, args: { name: "foo" } })
    ["bar(string)uint64"]({ sender, args: { a: "foo" } })
    .addMethodCall(client.params["bar(uint64)void"]({ sender, args: { a: 1n } }))
    .register({ sender })
    .addMethodCall(otherParams)
    .sum({ sender, args: { a: 1n, b: 2n } })
    .execute(client.algod);

  const sum: bigint | undefined = result.methodResults[0].returnValue;
  const greeting: string | undefined = result.methodResults[1].returnValue;
  const bar: bigint | undefined = result.methodResults[2].returnValue;
  const other: { other: true } | undefined = result.methodResults[5].returnValue;
  const sumAfterOther: bigint | undefined = result.methodResults[6].returnValue;
  // @ts-expect-error The return value of greet is a string
  const wrong: bigint | undefined = result.methodResults[1].returnValue;
  // @ts-expect-error Args are required
  client.newComposer().sum({ sender });
  return [sum, greeting, bar, other, sumAfterOther, wrong];
}
void usage;
`;
    expect(typeCheck(code + usage)).toEqual([]);
  });

  it("adds typed method calls to the client's app", async () => {
    const clientPath = path.join(
      import.meta.dirname,
      "generated",
      "TypedClient.ts",
    );
    await new ARC56Generator(arc56).generateToFile(clientPath);
    const { TypedClient } = (await import(clientPath)) as {
      TypedClient: new (p: Omit<ARC56AppClientParams, "arc56">) => {
        newComposer(): Composer &
          Record<
            "sum" | "bar(string)uint64" | "execute()void" | "register",
            (p: unknown) => unknown
          >;
      };
    };

    const client = new TypedClient({
      appId: 1234n,
      algod: new algosdk.Algodv2("", "http://localhost", 1),
      getSuggestedParams: () => Promise.resolve(suggestedParams),
    });

    const composer = client.newComposer();
    composer.sum({ sender, args: { a: 1n, b: 2n } });
    composer["bar(string)uint64"]({ sender, args: { a: "foo" } });
    composer["execute()void"]({ sender });
    composer.register({ sender });
    const group = await composer.buildGroupOffline();

    const calls = group.map(({ txn }) => ({
      appId: txn.applicationCall?.appIndex,
      onComplete: txn.applicationCall?.onComplete,
      selector: txn.applicationCall?.appArgs[0],
    }));
    const expected = (signature: string, onComplete = 0) => ({
      appId: 1234n,
      onComplete,
      selector: algosdk.ABIMethod.fromSignature(signature).getSelector(),
    });
    expect(calls).toEqual([
      expected("sum(uint64,uint64)uint64"),
      expected("bar(string)uint64"),
      expected("execute()void"),
      expected("register()void", algosdk.OnApplicationComplete.OptInOC),
    ]);
  });
});
