import algosdk from "algosdk";
import type { ARC56Contract, StructFields, StructField } from "./types/arc56";
import * as fs from "fs";
import * as path from "path";

export interface ARC56GeneratorOptions {
  /**
   * The module specifier used in the generated import statement.
   * Defaults to "algokit-lite".
   */
  clientImportPath?: string;
}

export class ARC56Generator {
  arc56: ARC56Contract;
  options: ARC56GeneratorOptions;

  constructor(arc56: ARC56Contract, options: ARC56GeneratorOptions = {}) {
    this.arc56 = arc56;
    this.options = {
      clientImportPath: "algokit-lite",
      ...options,
    };
  }

  getTypeScriptType(type: string): string {
    if (!type) return "void";

    // Anonymous struct in object syntax: { foo: uint16; bar: uint16 }
    if (type.startsWith("{") && type.endsWith("}")) {
      return type;
    }

    const lastPart = type.split(".").at(-1) ?? "";
    return lastPart
      .replace(/\[\d+\]/g, "[]")
      .replaceAll("(", "[")
      .replaceAll(")", "]");
  }

  private structDefToTsType(
    def: StructField[] | StructFields | Record<string, any> | string,
  ): string {
    if (Array.isArray(def)) {
      const fields = def.map((f: StructField) => {
        const fieldType = Array.isArray(f.type)
          ? this.structDefToTsType(f.type)
          : this.getTypeScriptType(f.type);
        return `  ${f.name}: ${fieldType};`;
      });
      return `{\n${fields.join("\n")}\n}`;
    } else if (typeof def === "object") {
      const fields = Object.keys(def).map((key) => {
        const val = def[key];
        const fieldType =
          typeof val === "object" && val !== null && !Array.isArray(val)
            ? this.structDefToTsType(val)
            : this.getTypeScriptType(val);
        return `  ${key}: ${fieldType};`;
      });
      return `{\n${fields.join("\n")}\n}`;
    }
    return this.getTypeScriptType(def);
  }

  getABITypeLines(): string[] {
    const abiTypes: string[] = [];

    const pushType = (type: string) => {
      if (!type) return;
      if (abiTypes.includes(type)) return;
      if (["void", "string"].includes(type)) return;

      const baseName = type.split(".").at(-1) ?? "";
      if (
        this.arc56.structs &&
        (this.arc56.structs[type] || this.arc56.structs[baseName])
      ) {
        return;
      }
      if (type.startsWith("{") && type.endsWith("}")) return;

      // Array type
      if (type.match(/\[\d*\]$/)) {
        pushType(type.replace(/\[\d*\]$/, ""));
        return;
      }

      // Tuple type
      if (type.startsWith("(")) {
        try {
          const tupleType = algosdk.ABITupleType.from(
            type,
          ) as algosdk.ABITupleType;
          tupleType.childTypes.forEach((t) => {
            pushType(t.toString());
          });
          return;
        } catch {
          const inner = type.slice(1, -1);
          inner.split(",").forEach((t) => {
            pushType(t.trim());
          });
          return;
        }
      }

      abiTypes.push(type);
    };

    Object.values(this.arc56.templateVariables ?? {}).forEach((t) => {
      pushType(t.type);
    });

    this.arc56.methods.forEach((m) => {
      m.args.forEach((a) => {
        pushType(a.type);
      });
      pushType(m.returns.type);
    });

    if (this.arc56.state?.keys) {
      (["global", "local", "box"] as const).forEach((storageType) => {
        const keysObj = this.arc56.state.keys[storageType] ?? {};
        Object.values(keysObj).forEach((k) => {
          pushType(k.keyType);
          pushType(k.valueType);
        });
      });
    }

    if (this.arc56.state?.maps) {
      (["global", "local", "box"] as const).forEach((storageType) => {
        const mapsObj = this.arc56.state.maps[storageType] ?? {};
        Object.values(mapsObj).forEach((m) => {
          pushType(m.keyType);
          pushType(m.valueType);
        });
      });
    }

    const pushStructFields = (fields: any) => {
      if (Array.isArray(fields)) {
        fields.forEach((sf: any) => {
          if (typeof sf.type === "string") pushType(sf.type);
          else pushStructFields(sf.type);
        });
      } else if (typeof fields === "object" && fields !== null) {
        Object.values(fields).forEach((sf: any) => {
          if (typeof sf === "string") pushType(sf);
          else pushStructFields(sf);
        });
      }
    };

    Object.values(this.arc56.structs ?? {}).forEach((sf) => {
      pushStructFields(sf);
    });

    const typeMap: { abiType: string; tsType: string }[] = [];
    const lines = ["// Aliases for non-encoded ABI values"];

    abiTypes.forEach((t) => {
      if (t.match(/^uint/) || t.match(/^ufixed/)) {
        typeMap.push({ abiType: t, tsType: "bigint" });
      } else if (t === "bytes" || t === "byte") {
        typeMap.push({ abiType: t, tsType: "string" });
      } else if (t === "AVMBytes") {
        typeMap.push({ abiType: t, tsType: "Uint8Array | string" });
      } else if (t === "AVMString") {
        typeMap.push({ abiType: t, tsType: "string" });
      } else if (t === "AVMUint64") {
        typeMap.push({ abiType: t, tsType: "bigint" });
      } else if (t === "address") {
        typeMap.push({ abiType: t, tsType: "string" });
      } else if (t === "bool") {
        typeMap.push({ abiType: t, tsType: "boolean" });
      } else if (
        ["pay", "axfer", "afrz", "keyreg", "appl", "acfg"].includes(t)
      ) {
        typeMap.push({ abiType: t, tsType: "algosdk.Transaction" });
      } else {
        typeMap.push({ abiType: t, tsType: "any" });
      }
    });

    const abiTypeLines = typeMap.map(
      (tm) => `type ${tm.abiType} = ${tm.tsType};`,
    );

    return lines.concat(abiTypeLines);
  }

  getStructTypeLines(): string[] {
    if (!this.arc56.structs || Object.keys(this.arc56.structs).length === 0) {
      return [];
    }

    const structLines = Object.keys(this.arc56.structs)
      .filter((structName) => !structName.includes(" "))
      .map((structName) => {
        const cleanName = structName.split(".").at(-1) ?? "";
        const tsBody = this.structDefToTsType(this.arc56.structs[structName]);
        return `export type ${cleanName} = ${tsBody};`;
      });

    if (structLines.length === 0) return [];
    return ["// Type definitions for ARC56 structs"].concat(structLines);
  }

  getTemplateVariableTypeLines(): string[] {
    if (
      !this.arc56.templateVariables ||
      Object.keys(this.arc56.templateVariables).length === 0
    ) {
      return [];
    }

    const lines = [
      "/** Compile-time variables */",
      "export type TemplateVariables = {",
    ];

    Object.keys(this.arc56.templateVariables).forEach((name) => {
      const varDef = this.arc56.templateVariables?.[name];
      if (varDef) {
        lines.push(`  ${name}: ${this.getTypeScriptType(varDef.type)};`);
      }
    });

    lines.push("};");

    return lines;
  }

  getParamsLines(): string[] {
    const lines = [
      "params = (methodParams?: TypedMethodParams) => {",
      "return {",
    ];

    this.arc56.methods.forEach((m) => {
      const argsSig = m.args
        .map(
          (a, i) =>
            `${a.name ?? `arg${i}`}: ${this.getTypeScriptType(a.struct ?? a.type)}`,
        )
        .join(", ");
      const argNames = m.args.map((a, i) => a.name ?? `arg${i}`).join(", ");

      lines.push(
        `${m.name}: (${argsSig}): MethodParams => {`,
        `  return this.getParams("${m.name}", { ...methodParams, methodArgs: [${argNames}] });`,
        "},",
      );
    });

    lines.push("};");
    lines.push("};");
    return lines;
  }

  getCallLines(): string[] {
    const lines: string[] = [];

    const ocMap: Record<string, { property: string; clientMethod: string }> = {
      NoOp: { property: "call", clientMethod: "methodCall" },
      OptIn: { property: "optIn", clientMethod: "optInMethodCall" },
      CloseOut: { property: "closeOut", clientMethod: "closeOutMethodCall" },
      ClearState: {
        property: "clearState",
        clientMethod: "clearStateMethodCall",
      },
      UpdateApplication: {
        property: "update",
        clientMethod: "updateMethodCall",
      },
      DeleteApplication: {
        property: "delete",
        clientMethod: "deleteMethodCall",
      },
    };

    for (const oc of Object.keys(ocMap)) {
      const entry = ocMap[oc];
      if (!entry) continue;
      const { property, clientMethod } = entry;
      const methods = this.arc56.methods.filter((m) =>
        m.actions.call.includes(oc as any),
      );

      if (methods.length === 0) continue;

      lines.push(
        `${property} = (methodParams: TypedMethodParams = {}) => {`,
        "return {",
      );

      methods.forEach((m) => {
        const argsSig = m.args
          .map(
            (a, i) =>
              `${a.name ?? `arg${i}`}: ${this.getTypeScriptType(a.struct ?? a.type)}`,
          )
          .join(", ");
        const argNames = m.args.map((a, i) => a.name ?? `arg${i}`).join(", ");
        const retType = this.getTypeScriptType(
          m.returns.struct ?? m.returns.type,
        );

        lines.push(
          `${m.name}: async (${argsSig}): Promise<{ result: MethodExecutionResult; returnValue: ${retType} }> => {`,
          `  return this.${clientMethod}("${m.name}", { ...methodParams, methodArgs: [${argNames}] });`,
          "},",
        );
      });

      lines.push("};");
      lines.push("};");
    }

    return lines;
  }

  getCreateLines(): string[] {
    const lines: string[] = [];
    const createMethods = this.arc56.methods.filter(
      (m) => m.actions.create.length > 0,
    );
    if (createMethods.length === 0) return [];

    const hasTemplateVars =
      this.arc56.templateVariables !== undefined &&
      Object.keys(this.arc56.templateVariables).length > 0;

    if (hasTemplateVars) {
      lines.push(
        `create = (methodParams: TypedCreateMethodParams & { templateVariables: TemplateVariables; onComplete?: algosdk.OnApplicationComplete }) => {`,
      );
    } else {
      lines.push(
        `create = (methodParams: TypedCreateMethodParams & { templateVariables?: Record<string, string | bigint | number | Uint8Array>; onComplete?: algosdk.OnApplicationComplete } = {}) => {`,
      );
    }

    lines.push(`return {`);

    createMethods.forEach((m) => {
      const argsSig = m.args
        .map(
          (a, i) =>
            `${a.name ?? `arg${i}`}: ${this.getTypeScriptType(a.struct ?? a.type)}`,
        )
        .join(", ");
      const argNames = m.args.map((a, i) => a.name ?? `arg${i}`).join(", ");
      const retType = this.getTypeScriptType(
        m.returns.struct ?? m.returns.type,
      );

      lines.push(
        `${m.name}: async (${argsSig}): Promise<{ result: MethodExecutionResult; returnValue: ${retType}; appId: bigint; appAddress: algosdk.Address }> => {`,
        `  return this.createMethodCall("${m.name}", { ...methodParams, methodArgs: [${argNames}] });`,
        "},",
      );
    });

    lines.push("};");
    lines.push("};");

    return lines;
  }

  getStateLines(): string[] {
    if (!this.arc56.state) return [];
    const hasKeys =
      this.arc56.state.keys &&
      Object.values(this.arc56.state.keys).some(
        (k) => Object.keys(k).length > 0,
      );
    const hasMaps =
      this.arc56.state.maps &&
      Object.values(this.arc56.state.maps).some(
        (m) => Object.keys(m).length > 0,
      );

    if (!hasKeys && !hasMaps) return [];

    const lines = ["state = {"];

    if (hasKeys && this.arc56.state.keys) {
      lines.push("keys: {");
      (["global", "local", "box"] as const).forEach((storageType) => {
        const keysObj = this.arc56.state.keys[storageType] ?? {};
        Object.keys(keysObj).forEach((name) => {
          const k = keysObj[name];
          if (!k) return;
          const valType = this.getTypeScriptType(k.valueType);
          if (storageType === "local") {
            lines.push(
              `${name}: async (address: algosdk.AddressWithTransactionSigner): Promise<${valType}> => { return this.getState.key("${name}", address); },`,
            );
          } else {
            lines.push(
              `${name}: async (): Promise<${valType}> => { return this.getState.key("${name}"); },`,
            );
          }
        });
      });
      lines.push("},");
    }

    if (hasMaps && this.arc56.state.maps) {
      lines.push("maps: {");
      (["global", "local", "box"] as const).forEach((storageType) => {
        const mapsObj = this.arc56.state.maps[storageType] ?? {};
        Object.keys(mapsObj).forEach((name) => {
          const m = mapsObj[name];
          if (!m) return;
          const keyType = this.getTypeScriptType(m.keyType);
          const valType = this.getTypeScriptType(m.valueType);
          lines.push(`${name}: {`);
          if (storageType === "local") {
            lines.push(
              `value: async (address: algosdk.AddressWithTransactionSigner, key: ${keyType}): Promise<${valType}> => { return this.getState.map.value("${name}", key, address); },`,
            );
          } else {
            lines.push(
              `value: async (key: ${keyType}): Promise<${valType}> => { return this.getState.map.value("${name}", key); },`,
            );
          }
          lines.push("},");
        });
      });
      lines.push("},");
    }

    lines.push("};");
    return lines;
  }

  getDecodeReturnValueLines(): string[] {
    if (this.arc56.methods.every((m) => m.returns.type === "void")) return [];

    const lines = ["decodeReturnValue = {"];

    this.arc56.methods.forEach((m) => {
      if (m.returns.type === "void") return;

      const retType = this.getTypeScriptType(
        m.returns.struct ?? m.returns.type,
      );
      lines.push(
        `${m.name}: (rawValue: Uint8Array): ${retType} => {`,
        `  return this.decodeMethodReturnValue("${m.name}", rawValue);`,
        "},",
      );
    });

    lines.push("};");

    return lines;
  }

  getConstructorLines(): string {
    return `constructor(p: {
    appId?: bigint | number;
    algod: algosdk.Algodv2;
    getSuggestedParams?: () => Promise<algosdk.SuggestedParams>;
    arc56?: ARC56Contract;
  }) {
    super({ arc56: JSON.parse(ARC56_JSON), ...p });
  }`;
  }

  async generate(): Promise<string> {
    const clientImportPath = this.options.clientImportPath ?? "algokit-lite";

    const content = `
import algosdk from "algosdk";
import {
  ARC56AppClient,
  type AppClientMethodParams,
  type CreateMethodParams,
  type MethodParams,
  type MethodExecutionResult,
  type ARC56Contract,
} from "${clientImportPath}";

type TypedMethodParams = Omit<AppClientMethodParams, "methodArgs">;
type TypedCreateMethodParams = Omit<CreateMethodParams, "methodArgs">;

const ARC56_JSON = ${JSON.stringify(JSON.stringify(this.arc56))};

${this.getABITypeLines().join("\n")}

${this.getStructTypeLines().join("\n")}

${this.getTemplateVariableTypeLines().join("\n")}

export class ${this.arc56.name}Client extends ARC56AppClient {
  ${this.getConstructorLines()}

  ${this.getParamsLines().join("\n")}

  ${this.getCallLines().join("\n")}

  ${this.getCreateLines().join("\n")}

  ${this.getStateLines().join("\n")}

  ${this.getDecodeReturnValueLines().join("\n")}
}

export default ${this.arc56.name}Client;
`.trim();

    try {
      const { format } = await import("prettier");
      return await format(content, { parser: "typescript" });
    } catch {
      return content;
    }
  }

  async generateToFile(filePath: string): Promise<void> {
    const code = await this.generate();
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, code, "utf-8");
  }
}

export default ARC56Generator;
