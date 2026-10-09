import { describe, it, expect, vi } from "vitest";
import algosdk from "algosdk";
import ts from "typescript";
import { ARC56AppClient } from "@joe-p/algokit-lite-app-client";
import {
  getTypeScriptValue,
  Composer,
  type ARC56Contract,
} from "@joe-p/algokit-lite-composer";
import { ARC56Generator } from "../src/generator";
import arc56Json from "../../../fixtures/ARC56Test.arc56.json";

function contract(...types: string[]): ARC56Contract {
  return {
    ...(arc56Json as unknown as ARC56Contract),
    name: "Bytes",
    structs: {},
    templateVariables: {},
    state: {
      schema: { global: { ints: 0, bytes: 0 }, local: { ints: 0, bytes: 0 } },
      keys: { global: {}, local: {}, box: {} },
      maps: { global: {}, local: {}, box: {} },
    },
    methods: types.map((type, i) => ({
      name: `method${i}`,
      args: [{ name: "value", type }],
      returns: { type },
      actions: { create: [], call: ["NoOp"] },
    })),
  };
}

const cases: [string, algosdk.ABIValue, unknown][] = [
  ["byte", 7, 7],
  ["byte[]", [1, 2, 3], new Uint8Array([1, 2, 3])],
  ["byte[]", [], new Uint8Array()],
  ["byte[4]", [1, 2, 3, 4], new Uint8Array([1, 2, 3, 4])],
  ["byte[32]", Array<number>(32).fill(1), new Uint8Array(32).fill(1)],
  ["(byte[4],uint64)", [[1, 2, 3, 4], 9n], [new Uint8Array([1, 2, 3, 4]), 9n]],
  [
    "(byte,(byte[],uint64[]))",
    [
      7,
      [
        [1, 2],
        [9n, 10n],
      ],
    ],
    [7, [new Uint8Array([1, 2]), [9n, 10n]]],
  ],
  [
    "byte[2][]",
    [
      [1, 2],
      [3, 4],
    ],
    [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
  ],
  ["byte[][2]", [[1], [2, 3]], [new Uint8Array([1]), new Uint8Array([2, 3])]],
  [
    "(byte[],byte)[2]",
    [
      [[1, 2], 3],
      [[], 4],
    ],
    [
      [new Uint8Array([1, 2]), 3],
      [new Uint8Array(), 4],
    ],
  ],
  ["uint8[]", [1n, 2n], [1n, 2n]],
  ["string", "hello", "hello"],
  ["bool[]", [true, false], [true, false]],
];

describe("ABI bytes", () => {
  it.each(cases)(
    "decodes %s consistently in utilities and method returns",
    (type, value, expected) => {
      const arc56 = contract(type);
      const raw = algosdk.ABIType.from(type).encode(value);
      const client = new ARC56AppClient({
        arc56,
        appId: 1n,
        algod: new algosdk.Algodv2("", "http://localhost", 1),
      });
      expect(getTypeScriptValue(arc56, type, raw)).toEqual(expected);
      expect(client.decodeMethodReturnValue("method0", raw)).toEqual(expected);
    },
  );

  it.each(["array", "object"] as const)(
    "decodes byte fields in nested %s structs",
    (format) => {
      const arc56 = contract("(byte,byte[],(byte[2],(byte[],uint64)))");
      arc56.structs =
        format === "array"
          ? {
              Inner: [
                { name: "fixed", type: "byte[2]" },
                { name: "tuple", type: "(byte[],uint64)" },
              ],
              Output: [
                { name: "single", type: "byte" },
                { name: "dynamic", type: "byte[]" },
                { name: "nested", type: "Inner" },
              ],
            }
          : {
              Inner: { fixed: "byte[2]", tuple: "(byte[],uint64)" },
              Output: { single: "byte", dynamic: "byte[]", nested: "Inner" },
            };
      const method = arc56.methods[0];
      if (!method) throw new Error("Expected method");
      method.returns.struct = "Output";
      const raw = algosdk.ABIType.from(method.returns.type).encode([
        7,
        [1, 2, 3],
        [
          [4, 5],
          [[6], 9n],
        ],
      ]);
      const expected = {
        single: 7,
        dynamic: new Uint8Array([1, 2, 3]),
        nested: {
          fixed: new Uint8Array([4, 5]),
          tuple: [new Uint8Array([6]), 9n],
        },
      };
      expect(getTypeScriptValue(arc56, "Output", raw)).toEqual(expected);
      const client = new ARC56AppClient({
        arc56,
        appId: 1n,
        algod: new algosdk.Algodv2("", "http://localhost", 1),
      });
      expect(client.decodeMethodReturnValue("method0", raw)).toEqual(expected);
    },
  );

  it.each([false, true])(
    "generates type-correct byte tuples (scalar alias: %s)",
    async (scalar) => {
      const arc56 = contract(
        "(byte[4],uint64)",
        "(byte[],(byte[2][],uint64))[]",
        ...(scalar ? ["byte"] : []),
      );
      const code = await new ARC56Generator(arc56).generate();
      expect(code).toContain("method0: [Uint8Array, uint64];");
      expect(code).toContain(
        "method1: [Uint8Array, [Uint8Array[], uint64]][];",
      );
      expect(code).not.toContain("type byte = string;");
      if (scalar) expect(code).toContain("type byte = number;");

      const filename = `${import.meta.dirname}/BytesClient.ts`;
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
    },
  );

  it("builds numeric byte and Uint8Array arguments offline", async () => {
    const arc56 = contract("byte", "byte[]", "(byte[2],byte)");
    const account = algosdk.generateAccount();
    const sender = {
      address: account.addr,
      txnSigner: algosdk.makeBasicAccountTransactionSigner(account),
    };
    const client = new ARC56AppClient({
      arc56,
      appId: 1n,
      algod: new algosdk.Algodv2("", "http://localhost", 1),
    });
    for (const [i, value] of [
      7,
      new Uint8Array([1, 2, 3]),
      [new Uint8Array([4, 5]), 6],
    ].entries()) {
      const group = await new Composer({
        getSuggestedParams: () =>
          Promise.resolve({
            fee: 1000n,
            minFee: 1000n,
            flatFee: true,
            firstValid: 1n,
            lastValid: 1000n,
            genesisHash: new Uint8Array(32),
            genesisID: "offline",
          }),
      })
        .addMethodCall(
          client.getParams({
            method: `method${i}`,
            methodArgs: [value],
            sender,
          }),
        )
        .buildGroupOffline();
      expect(group).toHaveLength(1);
      const arg = arc56.methods[i]?.args[0];
      if (!arg) throw new Error("Expected argument");
      expect(group[0]?.txn.applicationCall?.appArgs[1]).toEqual(
        algosdk.ABIType.from(arg.type).encode(value as algosdk.ABIValue),
      );
    }
  });

  it("generates matching byte types for struct fields and state getters", async () => {
    const arc56 = contract("(byte,byte[],(byte[4],uint64))");
    arc56.structs = {
      Output: [
        { name: "single", type: "byte" },
        { name: "blob", type: "byte[]" },
        { name: "tuple", type: "(byte[4],uint64)" },
      ],
    };
    const method = arc56.methods[0];
    const keys = arc56.state?.keys?.global;
    const maps = arc56.state?.maps?.box;
    if (!method || !keys || !maps) throw new Error("Expected definitions");
    method.returns.struct = "Output";
    keys.blob = { key: "AQ==", keyType: "AVMBytes", valueType: "byte[]" };
    maps.blobs = { keyType: "byte", valueType: "byte[4]" };
    const code = await new ARC56Generator(arc56).generate();
    expect(code).toContain("type byte = number;");
    expect(code).toContain("single: byte;");
    expect(code).toContain("blob: Uint8Array;");
    expect(code).toContain("tuple: [Uint8Array, uint64];");
    expect(code).toContain("blob: async (): Promise<Uint8Array>");
    expect(code).toContain("value: async (key: byte): Promise<Uint8Array>");
  });

  it("supports byte-array consumers and preserves legacy bytes and AVM values", () => {
    const arc56 = contract();
    const text = new Uint8Array([104, 105]);
    const decoded = getTypeScriptValue(
      arc56,
      "byte[]",
      algosdk.ABIType.from("byte[]").encode(text),
    ) as Uint8Array;
    expect(new TextDecoder().decode(decoded)).toBe("hi");
    const key = new Uint8Array(32).fill(1);
    const decodedKey = getTypeScriptValue(arc56, "byte[32]", key) as Uint8Array;
    expect(new algosdk.Address(decodedKey).publicKey).toEqual(key);
    expect(getTypeScriptValue(arc56, "bytes", text)).toBe("hi");
    expect(getTypeScriptValue(arc56, "AVMString", text)).toBe("hi");
    expect(getTypeScriptValue(arc56, "AVMBytes", text)).toBe(text);
  });

  it.each(["global", "local", "box"] as const)(
    "decodes %s state keys and map values as Uint8Array",
    async (storage) => {
      const arc56 = contract();
      const key = algosdk.bytesToBase64(new Uint8Array([1]));
      const keys = arc56.state?.keys?.[storage];
      const maps = arc56.state?.maps?.[storage];
      if (!keys || !maps) throw new Error("Expected state definitions");
      keys.blob = {
        key,
        keyType: "AVMBytes",
        valueType: "byte[4]",
      };
      maps.blobs = {
        keyType: "byte",
        valueType: "byte[]",
      };
      const algod = new algosdk.Algodv2("", "http://localhost", 1);
      const client = new ARC56AppClient({ arc56, appId: 1n, algod });
      const address = algosdk.generateAccount().addr;
      const state = [
        {
          key: new Uint8Array([1]),
          value: { type: 1, bytes: new Uint8Array([1, 2, 3, 4]) },
        },
        {
          key: new Uint8Array([7]),
          value: { type: 1, bytes: new Uint8Array([0, 3, 1, 2, 3]) },
        },
      ];
      if (storage === "global") {
        vi.spyOn(algod, "getApplicationByID").mockReturnValue({
          do: () => Promise.resolve({ params: { globalState: state } }),
        } as unknown as ReturnType<typeof algod.getApplicationByID>);
      } else if (storage === "local") {
        vi.spyOn(algod, "accountApplicationInformation").mockReturnValue({
          do: () => Promise.resolve({ appLocalState: { keyValue: state } }),
        } as unknown as ReturnType<typeof algod.accountApplicationInformation>);
      } else {
        vi.spyOn(algod, "getApplicationBoxByName").mockImplementation(
          (_appId, name) =>
            ({
              do: () =>
                Promise.resolve({
                  value: state.find((s) => s.key[0] === name[0])?.value.bytes,
                }),
            }) as unknown as ReturnType<typeof algod.getApplicationBoxByName>,
        );
      }
      expect(await client.getState.key("blob", address)).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      );
      expect(await client.getState.map.value("blobs", 7, address)).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    },
  );
});
