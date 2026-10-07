import { describe, it, expect, beforeAll } from "vitest";
import algosdk from "algosdk";
import { Localnet } from "../src/localnet";
import { ARC56AppClient } from "../src/arc56_client";
import { getConstantBlockOffset, parseLogicError } from "../src/arc56_utils";
import type { ARC56Contract } from "../src/types/arc56";
// Compiled by puya-ts 1.3.1 (puya 5.10.1) from:
//
// export class TemplateAssert extends Contract {
//   check(value: uint64, other: uint64): bytes {
//     assert(value === 42, 'value must be 42');
//     assert(other !== 0, 'other must not be 0');
//     return TemplateVar<bytes>('PAYLOAD');
//   }
// }
import templateAssertJson from "./fixtures/TemplateAssert.arc56.json";
// The Templates test contract of TEALScript 0.107.2. TEALScript counts
// "cblocks" pcs from the last byte of the constant blocks and leaves byteCode
// out when there are template variables.
import tealscriptTemplatesJson from "./fixtures/TEALScriptTemplates.arc56.json";

const templateAssert = templateAssertJson as unknown as ARC56Contract;
const tealscriptTemplates = tealscriptTemplatesJson as unknown as ARC56Contract;

describe("getConstantBlockOffset", () => {
  it("returns the pc of the first op after the constant blocks", () => {
    // version, bytecblock with one empty constant, txn NumAppArgs
    expect(
      getConstantBlockOffset(Uint8Array.from([11, 0x26, 1, 0, 0x31, 0x1b])),
    ).toBe(4);
  });

  it("reads constant lengths and counts as uvarints", () => {
    const program = Uint8Array.from([
      10,
      // bytecblock with one 200-byte constant (length 0xc8 0x01)
      0x26,
      1,
      0xc8,
      0x01,
      ...new Array<number>(200).fill(0x61),
      // intcblock with 130 values (count 0x82 0x01): 129 of 0, then 128 (0x80 0x01)
      0x20,
      0x82,
      0x01,
      ...new Array<number>(129).fill(0),
      0x80,
      0x01,
      // txn OnCompletion
      0x31,
      0x19,
    ]);
    expect(getConstantBlockOffset(program)).toBe(program.length - 2);
  });

  it("returns the pc after the version when there are no constant blocks", () => {
    // version, txn OnCompletion, then an intcblock opcode that is not at the top
    expect(
      getConstantBlockOffset(Uint8Array.from([10, 0x31, 0x19, 0x20])),
    ).toBe(1);
  });
});

describe("cblocks error mapping", () => {
  const localnet = new Localnet();
  let sender: algosdk.AddressWithTransactionSigner;

  beforeAll(async () => {
    sender = await localnet.generateAccount({ fund: 10_000_000n });
  });

  it("maps errors of a puya contract for every template value", async () => {
    // The lengths change the size of the deployed bytecblock, including a
    // length that takes a 2-byte uvarint
    for (const length of [0, 10, 200]) {
      const { appClient } = await ARC56AppClient.bareCreate({
        arc56: templateAssert,
        algod: localnet.algod,
        sender,
        templateVariables: { PAYLOAD: new Uint8Array(length).fill(0x61) },
      });

      await expect(
        appClient.methodCall({ method: "check", methodArgs: [1n, 1n], sender }),
      ).rejects.toThrow("value must be 42");
      await expect(
        appClient.simulateMethodCall({
          method: "check",
          methodArgs: [1n, 1n],
          sender,
        }),
      ).rejects.toThrow("value must be 42");

      // A client constructed by app id reads the deployed program from algod
      const byId = new ARC56AppClient({
        arc56: templateAssert,
        algod: localnet.algod,
        appId: appClient.appId,
      });
      await expect(
        byId.methodCall({ method: "check", methodArgs: [42n, 0n], sender }),
      ).rejects.toThrow("other must not be 0");
    }
  });

  it("maps errors of a TEALScript contract for every template value", async () => {
    for (const length of [0, 10, 200]) {
      const { appClient } = await ARC56AppClient.createMethodCall({
        arc56: tealscriptTemplates,
        algod: localnet.algod,
        sender,
        method: "createApplication",
        templateVariables: {
          bytesTmplVar: new Uint8Array(length).fill(0x61),
          uint64TmplVar: 123n,
          bytes32TmplVar: new Uint8Array(32),
          bytes64TmplVar: new Uint8Array(64),
        },
      });

      await expect(
        appClient.methodCall({ method: "throwError", sender }),
      ).rejects.toThrow("this is an error");
    }
  });

  it("needs the deployed program to map errors of a template-variable contract", async () => {
    const deployed = await new ARC56AppClient({
      arc56: templateAssert,
      algod: localnet.algod,
      appId: 0n,
    }).compileProgram("approval", { PAYLOAD: new Uint8Array(10) });

    // With a 10-byte PAYLOAD the first op after the bytecblock is at pc 14, so
    // the assert "value must be 42" (pc 61 in the source info) is at pc 75
    const message =
      "logic eval error: assert failed pc=75. Details: app=1, pc=75";

    // The placeholder byteCode has a shorter bytecblock, so it is not used
    expect(parseLogicError(templateAssert, 1n, message)).toBeUndefined();
    expect(
      parseLogicError(templateAssert, 1n, message, undefined, deployed)
        ?.message,
    ).toContain("value must be 42");
  });

  /**
   * Create an app from TEAL with one bytecblock constant of 200 bytes (so its
   * length takes a 2-byte uvarint). Its "cblocks" source info gives the op
   * marked `// boom` the message "boom", with pcs counted from the op marked
   * `// first op` plus `baseShift`.
   */
  const createFromTeal = async (teal: string, baseShift: number) => {
    const compiled = await localnet.algod.compile(teal).sourcemap(true).do();
    const rawSourceMap = (
      compiled.sourcemap as unknown as { data: Map<string, unknown> }
    ).data;
    const sourceMap = new algosdk.ProgramSourceMap({
      version: Number(rawSourceMap.get("version")),
      sources: rawSourceMap.get("sources") as string[],
      names: rawSourceMap.get("names") as string[],
      mappings: rawSourceMap.get("mappings") as string,
    });
    const lines = teal.split("\n");
    const pcOf = (marker: string) => {
      const pc = sourceMap.getPcsOnSourceLine(
        0,
        lines.findIndex((l) => l.includes(marker)),
      )[0]?.pc;
      if (pc === undefined) throw Error(`no pc for ${marker}`);
      return pc;
    };
    const firstOpPc = pcOf("// first op");
    const clear = (
      await localnet.algod.compile("#pragma version 10\npushint 1\nreturn").do()
    ).result;

    const arc56 = {
      arcs: [],
      name: "Cblocks",
      structs: {},
      state: {
        schema: {
          global: { ints: 0, bytes: 0 },
          local: { ints: 0, bytes: 0 },
        },
        keys: { global: {}, local: {}, box: {} },
        maps: { global: {}, local: {}, box: {} },
      },
      bareActions: { create: ["NoOp"], call: [] },
      methods: [
        {
          name: "fail",
          args: [],
          returns: { type: "void" },
          actions: { create: [], call: ["NoOp"] },
        },
      ],
      sourceInfo: {
        approval: {
          sourceInfo: [
            {
              pc: [pcOf("// boom") - (firstOpPc + baseShift)],
              errorMessage: "boom",
            },
          ],
          pcOffsetMethod: "cblocks",
        },
        clear: { sourceInfo: [], pcOffsetMethod: "none" },
      },
      byteCode: { approval: compiled.result, clear },
    } as unknown as ARC56Contract;

    const { appClient } = await ARC56AppClient.bareCreate({
      arc56,
      algod: localnet.algod,
      sender,
    });
    return {
      appClient,
      program: algosdk.base64ToBytes(compiled.result),
      firstOpPc,
    };
  };

  it("maps errors with pcs counted from the first op after the constant blocks", async () => {
    const { appClient } = await createFromTeal(
      `#pragma version 10
bytecblock 0x${"61".repeat(200)}
txn ApplicationID // first op
bz ok
pushint 0
assert // boom
ok:
pushint 1
return`,
      0,
    );

    await expect(
      appClient.methodCall({ method: "fail", sender }),
    ).rejects.toThrow("boom");
  });

  it("maps errors of TEALScript programs with pcs counted from the last constant block byte", async () => {
    // TEALScript's `int 6` in its routing prelude becomes pushint, or intc
    // when 6 is in the intcblock
    for (const [intcblock, int6, int6Opcode] of [
      ["intcblock 1", "pushint 6", 0x81],
      ["intcblock 1 6", "intc_1", 0x23],
      ["intcblock 1 2 3 4 6", "intc 4", 0x21],
    ] as const) {
      const { appClient, program, firstOpPc } = await createFromTeal(
        `#pragma version 10
${intcblock}
bytecblock 0x${"61".repeat(200)}
txn ApplicationID // first op
!
${int6}
*
txn OnCompletion
+
switch call fail fail fail fail fail create
fail:
err
call:
pushint 0
assert // boom
create:
intc_0
return`,
        -1,
      );
      expect(program[firstOpPc + 3]).toBe(int6Opcode);

      await expect(
        appClient.methodCall({ method: "fail", sender }),
      ).rejects.toThrow("boom");
    }
  });
});
