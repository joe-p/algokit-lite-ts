import { describe, it, expect, beforeAll } from "bun:test";
import algosdk from "algosdk";
import * as path from "path";
import * as fs from "fs";
import { Localnet } from "../src/localnet";
import { ARC56Generator } from "../src/generator";
import type { ARC56Contract } from "../src/types/arc56";
import arc56Json from "./fixtures/ARC56Test.arc56.json";

describe("ARC56Generator", () => {
  const localnet = new Localnet();
  const arc56 = arc56Json as unknown as ARC56Contract;
  let dispenser: algosdk.AddressWithTransactionSigner;

  beforeAll(async () => {
    dispenser = await localnet.dispenser();
  });

  it("should generate valid TypeScript code for ARC-56 contract", async () => {
    const generator = new ARC56Generator(arc56, {
      clientImportPath: "../src",
    });

    const code = await generator.generate();

    // Check header imports
    expect(code).toContain('import algosdk from "algosdk";');
    expect(code).toContain('from "../src";');

    // Check ABI type aliases
    expect(code).toContain("type uint64 = bigint;");
    expect(code).toContain("type uint16 = bigint;");

    // Check struct types
    expect(code).toContain("export type Outputs = {");
    expect(code).toContain("sum: uint64;");
    expect(code).toContain("difference: uint64;");
    expect(code).toContain("export type Inputs = {");
    expect(code).toContain("add: {");
    expect(code).toContain("subtract: {");

    // Check template variables type
    expect(code).toContain("export type TemplateVariables = {");
    expect(code).toContain("someNumber: uint64;");

    // Check Client class definition
    expect(code).toContain(
      "export class ARC56TestClient extends ARC56AppClient {",
    );

    // Check methods
    expect(code).toContain("params = (methodParams?: TypedMethodParams) => {");
    expect(code).toContain("foo: (inputs: Inputs): MethodParams => {");
    expect(code).toContain(
      "call = (methodParams: TypedMethodParams = {}) => {",
    );
    expect(code).toContain(
      "optIn = (methodParams: TypedMethodParams = {}) => {",
    );
    expect(code).toContain("templateVariables: TemplateVariables;");
    expect(code).toContain("createApplication: async ()");

    // Check state accessors
    expect(code).toContain("state = {");
    expect(code).toContain("globalKey: async (): Promise<uint64> => {");
    expect(code).toContain('return this.getState.key("localKey", address);');
    expect(code).toContain("boxKey: async (): Promise<string> => {");
    expect(code).toContain("globalMap: {");
    expect(code).toContain(
      "value: async (key: string): Promise<{ foo: uint16; bar: uint16 }> => {",
    );

    // Check decodeReturnValue
    expect(code).toContain("decodeReturnValue = {");
    expect(code).toContain("foo: (rawValue: Uint8Array): Outputs => {");
  });

  it("should match snapshot for the full generated typed client", async () => {
    const generator = new ARC56Generator(arc56);
    const code = await generator.generate();
    expect(code).toMatchSnapshot();

    const exampleCode = await fs.promises.readFile(
      path.join(__dirname, "../example/ARC56TestClient.ts"),
      "utf-8",
    );
    expect(code).toBe(exampleCode);
  });

  it("should compile and execute the generated client against Localnet", async () => {
    const generator = new ARC56Generator(arc56, {
      clientImportPath: "../../src",
    });

    const generatedDir = path.join(__dirname, "generated");
    if (!fs.existsSync(generatedDir)) {
      fs.mkdirSync(generatedDir, { recursive: true });
    }
    const clientPath = path.join(generatedDir, "ARC56TestClient.ts");
    await generator.generateToFile(clientPath);

    // Dynamically import the generated client
    const module = (await import(clientPath)) as typeof import(
      "../example/ARC56TestClient"
    );
    const ARC56TestClient = module.ARC56TestClient;
    expect(ARC56TestClient).toBeDefined();

    // 1. Create app
    const { appClient, appId, appAddress } = await ARC56TestClient.create({
      algod: localnet.algod,
      sender: dispenser,
      templateVariables: { someNumber: 1337n },
    }).createApplication();

    expect(appId).toBeGreaterThan(0n);
    expect(appClient.appId).toBe(appId);
    expect(appAddress.toString()).toBe(
      algosdk.getApplicationAddress(appId).toString(),
    );

    const existingClient = new ARC56TestClient({
      appId,
      algod: localnet.algod,
    });
    expect(existingClient.appId).toBe(appId);

    // 2. Call method with typed struct inputs
    const inputs = {
      add: { a: 10n, b: 20n },
      subtract: { a: 50n, b: 15n },
    };

    const callResult = await appClient.call({ sender: dispenser }).foo(inputs);
    expect(callResult.returnValue).toEqual({ sum: 30n, difference: 35n });

    // 3. Call method with a different sender
    const bob = await localnet.generateAccount({ fund: 10_000_000n });
    const bobResult = await appClient.call({ sender: bob }).foo(inputs);
    expect(bobResult.returnValue).toEqual({ sum: 30n, difference: 35n });

    // 4. OptIn (needs box references and MBR)
    await localnet
      .composer()
      .addPayment({
        sender: dispenser,
        receiver: appClient.appAddress,
        amount: 1_000_000n,
      })
      .execute(localnet.algod);

    const box1 = new TextEncoder().encode("boxKey");
    const box2 = Uint8Array.from(
      Buffer.from(
        "700000000000000001000000000000000200000000000000040000000000000003",
        "hex",
      ),
    );

    const optInResult = await appClient
      .optIn({
        sender: dispenser,
        boxes: [
          { appIndex: 0, name: box1 },
          { appIndex: 0, name: box2 },
        ],
      })
      .optInToApplication();
    expect(optInResult.result.confirmedRound).toBeGreaterThan(0n);

    // 5. Read state
    const globalVal = await appClient.state.keys.globalKey();
    expect(globalVal).toBe(1337n);

    const globalMapVal = await appClient.state.maps.globalMap.value("foo");
    expect(globalMapVal).toEqual({ foo: 13n, bar: 37n });

    const localVal = await appClient.state.keys.localKey(dispenser);
    expect(localVal).toBe(1337n);

    const localMapVal = await appClient.state.maps.localMap.value(
      dispenser,
      "foo",
    );
    expect(localMapVal).toBe("bar");

    const boxKeyVal = await appClient.state.keys.boxKey();
    expect(boxKeyVal).toBe("baz");

    const boxMapVal = await appClient.state.maps.boxMap.value({
      add: { a: 1n, b: 2n },
      subtract: { a: 4n, b: 3n },
    });
    expect(boxMapVal).toEqual({ sum: 3n, difference: 1n });

    // 6. Composer integration via params()
    const composer = localnet.composer();
    composer.addMethodCall(appClient.params({ sender: dispenser }).foo(inputs));
    const compResult = await composer.execute(localnet.algod);
    expect(compResult.confirmedRound).toBeGreaterThan(0n);

    // 7. Decode return value
    const firstResult = compResult.methodResults[0];
    if (!firstResult) throw new Error("Expected method result");
    const decoded = appClient.decodeReturnValue.foo(firstResult.rawReturnValue);
    expect(decoded).toEqual({ sum: 30n, difference: 35n });

    // 8. Error handling
    expect(
      appClient.call({ sender: dispenser }).foo({
        add: { a: 1n, b: 2n },
        subtract: { a: 1n, b: 100n },
      }),
    ).rejects.toThrow("subtract.a must be greater than subtract.b");
  });

  it("should generate valid code for latest ARC-56 contracts with StructField[] and minimal definitions", async () => {
    const minimalArc56: ARC56Contract = {
      arcs: [4, 56],
      name: "SimpleContract",
      methods: [
        {
          name: "hello",
          args: [{ name: "name", type: "string" }],
          returns: { type: "string" },
          actions: { create: [], call: ["NoOp"] },
        },
        {
          name: "calculate",
          args: [
            {
              name: "coords",
              type: "(uint64,uint64)",
              struct: "Point",
            },
          ],
          returns: { type: "void" },
          actions: { create: ["NoOp"], call: [] },
        },
      ],
      structs: {
        Point: [
          { name: "x", type: "uint64" },
          { name: "y", type: "uint64" },
        ],
      },
      state: {
        schema: {
          global: { ints: 0, bytes: 0 },
          local: { ints: 0, bytes: 0 },
        },
        keys: { global: {}, local: {}, box: {} },
        maps: { global: {}, local: {}, box: {} },
      },
      bareActions: { create: [], call: [] },
    };

    const generator = new ARC56Generator(minimalArc56);
    const code = await generator.generate();

    expect(code).toContain(
      "export class SimpleContractClient extends ARC56AppClient {",
    );
    expect(code).toContain("export type Point = {");
    expect(code).toContain("x: uint64;");
    expect(code).toContain("y: uint64;");
    expect(code).toContain("hello: (name: string): MethodParams => {");
    expect(code).toContain("calculate: (coords: Point): MethodParams => {");
    expect(code).toContain("hello: async (");
    expect(code).toContain("calculate: async (");
    expect(code).toContain("static override create(");
  });
});
