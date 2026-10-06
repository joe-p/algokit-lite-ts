import { describe, it, expect, beforeAll, spyOn } from "bun:test";
import algosdk from "algosdk";
import ts from "typescript";
import * as path from "path";
import { Localnet } from "../src/localnet";
import { ARC56AppClient } from "../src/arc56_client";
import { ARC56Generator } from "../src/generator";
import type { MethodParams } from "../src/composer";
import type { ARC56Contract } from "../src/types/arc56";

const selector = (signature: string) =>
  `pushbytes 0x${Buffer.from(algosdk.ABIMethod.fromSignature(signature).getSelector()).toString("hex")}`;
const GET_POINT = selector("getPoint(uint64)(uint64,uint64)");

// The constant blocks let the "cblocks" pcOffsetMethod be tested
const APPROVAL = `#pragma version 10
intcblock 0 1 2
bytecblock 0x151f7c75
txn ApplicationID
bz create
txn OnCompletion
intc_0
==
assert
txna ApplicationArgs 0
${GET_POINT}
${selector("mustBePositive(uint64)uint64")}
${selector("callOther(uint64)uint64")}
${selector("write()void")}
uncover 4
match getPoint mustBePositive callOther write
err
create:
intc_1
return
getPoint:
bytec_0
txna ApplicationArgs 1
concat
txna ApplicationArgs 1
btoi
intc_2
*
itob
concat
log
intc_1
return
mustBePositive:
txna ApplicationArgs 1
btoi
intc_0
>
assert // MUST_BE_POSITIVE
bytec_0
txna ApplicationArgs 1
concat
log
intc_1
return
callOther:
itxn_begin
pushint 6
itxn_field TypeEnum
txna ApplicationArgs 1
btoi
itxn_field ApplicationID
${GET_POINT}
itxn_field ApplicationArgs
pushint 7
itob
itxn_field ApplicationArgs
intc_0
itxn_field Fee
itxn_submit
bytec_0
itxn LastLog
extract 12 8
concat
log
intc_1
return
write:
intc_1
return`;

const CLEAR = `#pragma version 10
pushint 1
return`;

const methods: ARC56Contract["methods"] = [
  {
    name: "getPoint",
    args: [{ name: "x", type: "uint64" }],
    returns: { type: "(uint64,uint64)", struct: "Point" },
    actions: { create: [], call: ["NoOp"] },
    readonly: true,
  },
  {
    name: "mustBePositive",
    args: [{ name: "n", type: "uint64" }],
    returns: { type: "uint64" },
    actions: { create: [], call: ["NoOp"] },
    readonly: true,
  },
  {
    name: "callOther",
    args: [{ name: "appId", type: "uint64" }],
    returns: { type: "uint64" },
    actions: { create: [], call: ["NoOp"] },
    readonly: true,
  },
  {
    name: "write",
    args: [],
    returns: { type: "void" },
    actions: { create: [], call: ["NoOp"] },
  },
];

describe("readonly methods", () => {
  const localnet = new Localnet();
  let dispenser: algosdk.AddressWithTransactionSigner;
  let approval: Uint8Array;
  let clear: Uint8Array;
  /** pc of the assert in mustBePositive */
  let assertPc: number;

  /** The contract, with the assert's error message in the given format */
  const contract = (
    sourceInfo: "array" | "cblocks" | "none",
  ): ARC56Contract => ({
    arcs: [4, 56],
    name: "Readonly",
    structs: {
      Point: [
        { name: "x", type: "uint64" },
        { name: "y", type: "uint64" },
      ],
    },
    state: {
      schema: { global: { ints: 0, bytes: 0 }, local: { ints: 0, bytes: 0 } },
      keys: { global: {}, local: {}, box: {} },
      maps: { global: {}, local: {}, box: {} },
    },
    bareActions: { create: ["NoOp"], call: [] },
    methods,
    byteCode: {
      approval: algosdk.bytesToBase64(approval),
      clear: algosdk.bytesToBase64(clear),
    },
    ...(sourceInfo === "array"
      ? {
          sourceInfo: [{ pc: [assertPc], errorMessage: "n must be positive" }],
        }
      : sourceInfo === "cblocks"
        ? {
            sourceInfo: {
              approval: {
                // pcs leave out the intcblock (5 bytes) and bytecblock (7
                // bytes) that follow the version byte
                pcOffsetMethod: "cblocks",
                sourceInfo: [
                  { pc: [assertPc - 12], errorMessage: "n must be positive" },
                ],
              },
              clear: { pcOffsetMethod: "none", sourceInfo: [] },
            },
          }
        : {}),
  });

  const create = async (sourceInfo: "array" | "cblocks" | "none" = "array") =>
    (
      await ARC56AppClient.bareCreate({
        arc56: contract(sourceInfo),
        algod: localnet.algod,
        sender: dispenser,
      })
    ).appClient;

  const generateClient = async () => {
    const clientPath = path.join(
      __dirname,
      "generated",
      "ReadonlyTestClient.ts",
    );
    await new ARC56Generator(contract("array"), {
      clientImportPath: "../../src",
    }).generateToFile(clientPath);
    return (await import(clientPath)) as {
      ReadonlyClient: new (p: {
        appId: bigint;
        algod: algosdk.Algodv2;
      }) => GeneratedClient;
    };
  };

  type GeneratedClient = ARC56AppClient & {
    call: Record<
      "getPoint" | "write",
      (params: unknown) => Promise<{
        returnValue: unknown;
        result: { simulateResponse?: algosdk.modelsv2.SimulateResponse };
      }>
    >;
    params: { getPoint: (params: unknown) => MethodParams };
  };

  beforeAll(async () => {
    dispenser = await localnet.dispenser();
    const approvalCompiled = await localnet.algod
      .compile(APPROVAL)
      .sourcemap(true)
      .do();
    approval = algosdk.base64ToBytes(approvalCompiled.result);
    clear = algosdk.base64ToBytes(
      (await localnet.algod.compile(CLEAR).do()).result,
    );

    const rawSourceMap = (
      approvalCompiled.sourcemap as unknown as { data: Map<string, unknown> }
    ).data;
    const sourceMap = new algosdk.ProgramSourceMap({
      version: Number(rawSourceMap.get("version")),
      sources: rawSourceMap.get("sources") as string[],
      names: rawSourceMap.get("names") as string[],
      mappings: rawSourceMap.get("mappings") as string,
    });
    const assertLine = APPROVAL.split("\n").findIndex((l) =>
      l.includes("MUST_BE_POSITIVE"),
    );
    const pc = sourceMap.getPcsOnSourceLine(0, assertLine)[0]?.pc;
    if (pc === undefined) throw Error("assert pc not found");
    assertPc = pc;
  });

  it("generates simulate-backed call entries only for readonly methods", async () => {
    const code = await new ARC56Generator(contract("array")).generate();
    const callBody = code.split("call = {")[1]?.split("\n  };")[0] ?? "";
    for (const name of ["getPoint", "mustBePositive", "callOther"]) {
      expect(callBody).toContain(
        `this.simulateMethodCall({\n        method: "${name}",`,
      );
    }
    expect(callBody).toContain('this.methodCall({\n        method: "write",');
    expect(callBody).toContain(
      'Promise<{\n      result: MethodSimulationResult;\n      returnValue: ReadonlyReturnTypes["getPoint"];',
    );
    expect(callBody).toContain(
      'Promise<{\n      result: MethodExecutionResult;\n      returnValue: ReadonlyReturnTypes["write"];',
    );

    // params are generated the same way for readonly methods
    const paramsBody = code.split("params = {")[1]?.split("\n  };")[0] ?? "";
    expect(paramsBody).toContain(
      'getPoint: (\n      methodParams: TypedMethodParams<{ x: uint64 }>,\n    ): MethodParams<ReadonlyReturnTypes["getPoint"]> => {',
    );

    // The generated client and its return types type check
    const usage = `
declare const client: ReadonlyClient;
async function usage() {
  const { returnValue, result } = await client.call.getPoint({
    sender: algosdk.Address.zeroAddress(),
    args: { x: 1n },
    staticFee: 2000n,
  });
  const point: Point = returnValue;
  const response: algosdk.modelsv2.SimulateResponse = result.simulateResponse;
  const n: bigint = (await client.call.mustBePositive({ sender: algosdk.Address.zeroAddress(), args: { n: 1n } })).returnValue;
  const round: bigint = (await client.call.write({ sender: { address: algosdk.Address.zeroAddress(), txnSigner: algosdk.makeEmptyTransactionSigner() } })).result.confirmedRound;
  // @ts-expect-error execute results are not returned for readonly methods
  result.confirmedRound;
  return [point, response, n, round];
}
`;
    expect(typeCheck(code + usage)).toEqual([]);
  });

  it("simulates a readonly method returning a struct without signing or sending", async () => {
    const appClient = await create();
    const { ReadonlyClient } = await generateClient();
    const client = new ReadonlyClient({
      appId: appClient.appId,
      algod: localnet.algod,
    });

    let signed = 0;
    const sender = {
      address: dispenser.address,
      txnSigner: (...args: Parameters<algosdk.TransactionSigner>) => {
        signed++;
        return dispenser.txnSigner(...args);
      },
    };
    const send = spyOn(localnet.algod, "sendRawTransaction");
    try {
      const { returnValue, result } = await client.call.getPoint({
        sender,
        args: { x: 21n },
      });
      expect(returnValue).toEqual({ x: 21n, y: 42n });
      expect(result.simulateResponse?.txnGroups[0]?.failureMessage).toBe(
        undefined,
      );
      expect(signed).toBe(0);
      expect(send).not.toHaveBeenCalled();

      // A non-readonly method is still sent
      await client.call.write({ sender });
      expect(signed).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });

  it("works with a sender that has no signer", async () => {
    const appClient = await create();

    for (const sender of [dispenser.address, { address: dispenser.address }]) {
      const { returnValue } = await appClient.simulateMethodCall({
        method: "getPoint",
        sender,
        methodArgs: [5n],
      });
      expect(returnValue).toEqual({ x: 5n, y: 10n });
    }
  });

  it("throws the ARC56 error message when a readonly method fails an assert", async () => {
    for (const sourceInfo of ["array", "cblocks"] as const) {
      const appClient = await create(sourceInfo);

      const { returnValue } = await appClient.simulateMethodCall({
        method: "mustBePositive",
        sender: dispenser.address,
        methodArgs: [3n],
      });
      expect(returnValue).toBe(3n);

      const error = await appClient
        .simulateMethodCall({
          method: "mustBePositive",
          sender: dispenser.address,
          methodArgs: [0n],
        })
        .catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `Runtime error when executing Readonly (appId: ${appClient.appId})`,
      );
      expect((error as Error).message).toContain("n must be positive");

      // Executing reports the same error
      expect(
        appClient.methodCall({
          method: "mustBePositive",
          sender: dispenser,
          methodArgs: [0n],
        }),
      ).rejects.toThrow("n must be positive");
    }
  });

  it("throws the simulate failure message when there is no ARC56 error message", async () => {
    const appClient = await create("none");
    const error = await appClient
      .simulateMethodCall({
        method: "mustBePositive",
        sender: dispenser.address,
        methodArgs: [0n],
      })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("assert failed");
    expect((error as Error).message).toContain(`pc=${assertPc}`);
    expect((error as Error).cause).toBeInstanceOf(
      algosdk.modelsv2.SimulateResponse,
    );
  });

  it("covers the fee of a readonly method's inner app call", async () => {
    const appClient = await create();
    const other = await create();

    // The app pays its inner call's fee from the outer call's fee
    const { returnValue, result } = await appClient.simulateMethodCall({
      method: "callOther",
      sender: dispenser.address,
      methodArgs: [other.appId],
    });
    expect(returnValue).toBe(14n);
    const txn = result.simulateResponse.txnGroups[0]?.txnResults[0];
    expect(txn?.txnResult.txn.txn.fee).toBeGreaterThanOrEqual(2000n);

    // Fee overrides still apply
    expect(
      appClient.simulateMethodCall({
        method: "callOther",
        sender: dispenser.address,
        methodArgs: [other.appId],
        staticFee: 1000n,
      }),
    ).rejects.toThrow(/group fee .* too small/);
  });

  it("leaves params unchanged so readonly methods can be composed", async () => {
    const appClient = await create();
    const { ReadonlyClient } = await generateClient();
    const client = new ReadonlyClient({
      appId: appClient.appId,
      algod: localnet.algod,
    });

    const result = await localnet
      .composer()
      .addMethodCall(
        client.params.getPoint({ sender: dispenser, args: { x: 2n } }),
      )
      .execute(localnet.algod);
    expect(result.methodResults[0].returnValue).toEqual({ x: 2n, y: 4n });
  });
});

function typeCheck(code: string): string[] {
  const filename = path.join(import.meta.dir, "generated", "ReadonlyCheck.ts");
  const config = ts.readConfigFile(
    `${import.meta.dir}/../tsconfig.json`,
    (file) => ts.sys.readFile(file),
  );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    `${import.meta.dir}/..`,
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
