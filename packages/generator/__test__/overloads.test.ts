import { describe, it, expect, vi } from "vitest";
import algosdk from "algosdk";
import ts from "typescript";
import { ARC56AppClient } from "@joe-p/algokit-lite-app-client";
import {
  getAbiMethod,
  decodeMethodReturnValue,
  Composer,
  type ARC56Contract,
} from "@joe-p/algokit-lite-composer";
import { ARC56Generator } from "../src/generator";
import arc56Json from "../../../fixtures/ARC56Test.arc56.json";

function contract(...signatures: string[]): ARC56Contract {
  return {
    ...(arc56Json as unknown as ARC56Contract),
    name: "Overloads",
    structs: {},
    templateVariables: {},
    state: {
      schema: { global: { ints: 0, bytes: 0 }, local: { ints: 0, bytes: 0 } },
      keys: { global: {}, local: {}, box: {} },
      maps: { global: {}, local: {}, box: {} },
    },
    methods: signatures.map((signature) => {
      const method = algosdk.ABIMethod.fromSignature(signature);
      return {
        name: method.name,
        args: method.args.map((a, i) => ({
          name: `arg${i}`,
          type: a.type.toString(),
        })),
        returns: { type: method.returns.type.toString() },
        actions: { create: ["NoOp"], call: ["NoOp", "OptIn"] },
      };
    }),
  };
}

const arc56 = contract(
  "bar(uint64)void",
  "bar(uint64)uint64",
  "bar(string)uint64",
  "bar()uint64",
  "foo(uint64)void",
);
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
const makeClient = (definition = arc56, appId = 1n) =>
  new ARC56AppClient({
    arc56: definition,
    appId,
    algod: new algosdk.Algodv2("", "http://localhost", 1),
  });

describe("ABI overloads", () => {
  for (const signature of ["bar(uint64)uint64", "bar(string)uint64"]) {
    for (const method of [
      signature,
      algosdk.ABIMethod.fromSignature(signature),
    ]) {
      it(`resolves and builds the exact selector for ${signature} (${typeof method})`, async () => {
        const args = signature.includes("string") ? ["hi"] : [7n];
        const resolved = getAbiMethod(arc56, method);
        expect(resolved.abiMethod.getSignature()).toBe(signature);
        expect(resolved.arc56Method.returns.type).toBe("uint64");

        const params = makeClient().getParams({
          method,
          sender,
          methodArgs: args,
        });
        if (typeof params.method === "string")
          throw new Error("Expected ABIMethod");
        expect(params.method.getSignature()).toBe(signature);

        for (const call of [
          { arc56, appID: 1n, method, sender, methodArgs: args },
          params,
        ]) {
          const group = await new Composer({
            getSuggestedParams: () => Promise.resolve(suggestedParams),
          })
            .addMethodCall(call)
            .buildGroupOffline();
          expect(group[0]?.txn.applicationCall?.appArgs[0]).toEqual(
            algosdk.ABIMethod.fromSignature(signature).getSelector(),
          );
        }
        expect(
          decodeMethodReturnValue(arc56, method, algosdk.encodeUint64(42n)),
        ).toBe(42n);
        expect(
          makeClient().decodeMethodReturnValue<bigint>(
            method,
            algosdk.encodeUint64(42n),
          ),
        ).toBe(42n);
      });
    }
  }

  it("rejects ambiguous names and lists all signatures", async () => {
    const message =
      "Method bar is ambiguous in Overloads ARC56 definition; use one of: bar(uint64)void, bar(uint64)uint64, bar(string)uint64, bar()uint64";
    expect(() => getAbiMethod(arc56, "bar")).toThrow(message);
    expect(() => makeClient().getParams({ method: "bar", sender })).toThrow(
      message,
    );
    expect(() =>
      decodeMethodReturnValue(arc56, "bar", new Uint8Array()),
    ).toThrow(message);
    await expect(
      new Composer({
        getSuggestedParams: () => Promise.resolve(suggestedParams),
      })
        .addMethodCall({ arc56, appID: 1n, method: "bar", sender })
        .buildGroupOffline(),
    ).rejects.toThrow(message);
  });

  for (const signature of ["bar(bool)uint64", "foo(string)uint64"]) {
    for (const method of [
      signature,
      algosdk.ABIMethod.fromSignature(signature),
    ]) {
      it(`rejects unmatched ${signature} (${typeof method})`, async () => {
        const message = `Method ${signature} not found`;
        expect(() => getAbiMethod(arc56, method)).toThrow(message);
        expect(() => makeClient().getParams({ method, sender })).toThrow(
          message,
        );
        expect(() =>
          makeClient().decodeMethodReturnValue(method, new Uint8Array()),
        ).toThrow(message);
        await expect(
          new Composer({
            getSuggestedParams: () => Promise.resolve(suggestedParams),
          })
            .addMethodCall({
              arc56,
              appID: 1n,
              method,
              sender,
              methodArgs: [5n],
            })
            .buildGroupOffline(),
        ).rejects.toThrow(message);
      });
    }
  }

  it("keeps unique bare names and void decoding working", () => {
    expect(getAbiMethod(arc56, "foo").abiMethod.getSignature()).toBe(
      "foo(uint64)void",
    );
    const { method } = makeClient().getParams({ method: "foo", sender });
    if (typeof method === "string") throw new Error("Expected ABIMethod");
    expect(method.getSignature()).toBe("foo(uint64)void");
    expect(
      decodeMethodReturnValue(
        arc56,
        "bar(uint64)void",
        algosdk.encodeUint64(42n),
      ),
    ).toBeUndefined();
  });

  it("decodes composer results with the selected overload, including structs", () => {
    const definition = contract(
      "bar(uint64)void",
      "bar(uint64)(uint64,uint64)",
    );
    definition.structs = {
      Output: [
        { name: "a", type: "uint64" },
        { name: "b", type: "uint64" },
      ],
    };
    const structMethod = definition.methods[1];
    if (!structMethod) throw new Error("Expected struct method");
    structMethod.returns.struct = "Output";
    const method = algosdk.ABIMethod.fromSignature(
      "bar(uint64)(uint64,uint64)",
    );
    const rawReturnValue = algosdk.ABIType.from("(uint64,uint64)").encode([
      42n,
      7n,
    ]);
    for (const identifier of [method, method.getSignature()]) {
      const composer = new Composer({}).addMethodCall({
        arc56: definition,
        appID: 1n,
        method: identifier,
        sender,
        methodArgs: [1n],
      });
      const results = composer["decodeResults"]([
        {
          txID: "offline",
          method,
          rawReturnValue,
          returnValue: undefined,
        },
      ]);
      expect(results[0]?.returnValue).toEqual({ a: 42n, b: 7n });
      expect(results[0]?.decodeError).toBeUndefined();
    }
  });

  it("uses the exact overload for app-client actions and return values", async () => {
    const definition = contract("bar(uint64)void", "bar(uint64)uint64");
    const voidMethod = definition.methods[0];
    if (!voidMethod) throw new Error("Expected void method");
    voidMethod.actions = { create: [], call: ["OptIn"] };
    const method = algosdk.ABIMethod.fromSignature("bar(uint64)uint64");
    const execute = vi.spyOn(Composer.prototype, "execute").mockResolvedValue({
      confirmedRound: 1n,
      txIDs: ["offline"],
      methodResults: [
        {
          txID: "offline",
          method,
          rawReturnValue: algosdk.encodeUint64(42n),
          returnValue: 42n,
        },
      ],
    });
    try {
      for (const identifier of [method, method.getSignature()]) {
        for (const appId of [0n, 1n]) {
          const result = await makeClient(definition, appId).methodCall({
            method: identifier,
            sender,
            methodArgs: [7n],
          });
          expect(result.returnValue).toBe(42n);
        }
      }
      await expect(
        makeClient(definition).methodCall({
          method: "bar(uint64)void",
          sender,
          methodArgs: [7n],
        }),
      ).rejects.toThrow("NoOp is not supported");
    } finally {
      execute.mockRestore();
    }
  });

  it("generates distinct, type-correct signature keys in every method API", async () => {
    const code = await new ARC56Generator(arc56).generate();
    expect(code).not.toMatch(/^\s*bar[:(]/m);
    expect(code).not.toContain('method: "bar"');
    expect(code).toContain('"bar(uint64)void": void;');
    expect(code).toContain('"bar(uint64)uint64": uint64;');
    expect(code).toContain(
      'this.decodeMethodReturnValue("bar(uint64)uint64", rawValue)',
    );
    expect(code).toContain("foo:");
    expect(code).toContain('method: "foo"');
    for (const section of ["params", "call", "optIn", "static create"]) {
      const body = code.split(`${section} = {`)[1]?.split("\n  };")[0];
      for (const signature of [
        "bar(uint64)void",
        "bar(uint64)uint64",
        "bar(string)uint64",
        "bar()uint64",
      ]) {
        expect(body).toContain(`"${signature}":`);
        expect(body).toContain(`method: "${signature}"`);
      }
    }

    const filename = `${import.meta.dirname}/OverloadsClient.ts`;
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
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
  });
});
