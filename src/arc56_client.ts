import algosdk, {
  Algodv2,
  type AddressWithTransactionSigner,
  type SuggestedParams,
} from "algosdk";
import { Composer, type MethodParams } from "./composer";
import {
  type ARC56Contract,
  type StorageMap,
  type StructField,
  type StructFields,
} from "./types/arc56";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

type StructDef = StructField[] | StructFields | StructField["type"];

export type AppClientMethodParams = Omit<
  MethodParams,
  "appID" | "method" | "sender" | "methodArgs"
> & {
  method: string;
  sender?: AddressWithTransactionSigner;
  methodArgs?: unknown[];
};

export type CreateMethodParams = AppClientMethodParams & {
  templateVariables?: Record<string, string | bigint | number | Uint8Array>;
};

export type MethodExecutionResult = {
  confirmedRound: bigint;
  txIDs: string[];
  methodResults: algosdk.ABIResult[];
};

export type MethodCallResult<TReturn = unknown> = {
  result: MethodExecutionResult;
  returnValue: TReturn;
};

export type CreateMethodCallResult<TReturn = unknown> = {
  appClient: ARC56AppClient;
  appId: bigint;
  appAddress: algosdk.Address;
  result: MethodExecutionResult;
  returnValue: TReturn;
};

export type MethodReturnValue<T = unknown> = T;

export interface ARC56AppClientParams {
  arc56: ARC56Contract;
  appId: bigint | number;
  algod: Algodv2;
  getSuggestedParams?: () => Promise<SuggestedParams>;
}

export type ARC56AppClientCreateParams = Omit<ARC56AppClientParams, "appId"> &
  CreateMethodParams;

export class ARC56AppClient {
  readonly appId: bigint;
  algod: Algodv2;
  contract: algosdk.ABIContract;
  readonly appAddress: algosdk.Address;
  arc56: ARC56Contract;
  getSuggestedParams?: () => Promise<SuggestedParams>;

  constructor(p: ARC56AppClientParams) {
    this.arc56 = p.arc56;
    this.appId = BigInt(p.appId);
    this.appAddress = algosdk.getApplicationAddress(this.appId);
    this.algod = p.algod;
    this.contract = new algosdk.ABIContract({
      name: this.arc56.name,
      methods: this.arc56.methods,
      events: this.arc56.events,
      desc: this.arc56.desc,
      networks: this.arc56.networks,
    });
    this.getSuggestedParams = p.getSuggestedParams;
  }

  composer(): Composer {
    return new Composer({
      getSuggestedParams:
        this.getSuggestedParams ??
        (() => this.algod.getTransactionParams().do()),
    });
  }

  private async executeWithErrorParsing(composer: Composer) {
    try {
      return await composer.execute(this.algod);
    } catch (e: unknown) {
      const eMsg = e instanceof Error ? e.message : "";
      const str = eMsg ? `${eMsg} ${JSON.stringify(e)}` : JSON.stringify(e);
      const txId =
        str.match(/(?:transaction\s+)(\S+?)(?=:|\s)/)?.[1] ??
        str.match(/(?<=transaction\s+)\S+(?=:)/)?.[0];

      const appIdStr =
        str.match(/(?:app=)(\d+)/)?.[1] ??
        str.match(/(?:application\s+\((\d+)\))/)?.[1];
      const appId = appIdStr !== undefined ? BigInt(appIdStr) : undefined;

      const pcStr = str.match(/(?:pc=)(\d+)/)?.[1];
      const pc = pcStr !== undefined ? Number(pcStr) : undefined;

      if (appId !== undefined && appId !== this.appId) {
        throw e;
      }

      let errorMessage: string | undefined;
      if (pc !== undefined && this.arc56.sourceInfo) {
        if (Array.isArray(this.arc56.sourceInfo)) {
          errorMessage = this.arc56.sourceInfo.find((s) =>
            s.pc.includes(pc),
          )?.errorMessage;
        } else {
          const approvalInfo = this.arc56.sourceInfo.approval;
          let targetPc = pc;
          if (approvalInfo.pcOffsetMethod === "cblocks") {
            const approvalByteCode = this.arc56.byteCode?.approval
              ? new Uint8Array(
                  Buffer.from(this.arc56.byteCode.approval, "base64"),
                )
              : undefined;
            if (approvalByteCode) {
              const offset = this.getConstantBlockOffset(approvalByteCode);
              targetPc = pc - offset;
            }
          }
          errorMessage = approvalInfo.sourceInfo.find((s) =>
            s.pc.includes(targetPc),
          )?.errorMessage;
        }
      }

      if (errorMessage) {
        throw Error(
          `Runtime error when executing ${this.arc56.name} (appId: ${this.appId}) in transaction ${txId}: ${errorMessage}`,
          { cause: e },
        );
      }

      throw e;
    }
  }

  private getConstantBlockOffset(program: Uint8Array): number {
    const BYTE_CBLOCK = 38;
    const INT_CBLOCK = 32;
    const bytes = [...program];
    const programSize = bytes.length;
    bytes.shift(); // remove version

    let bytecblockOffset: number | undefined;
    let intcblockOffset: number | undefined;

    while (bytes.length > 0) {
      const byte = bytes.shift();
      if (byte === undefined) break;
      if (byte === BYTE_CBLOCK || byte === INT_CBLOCK) {
        const isBytecblock = byte === BYTE_CBLOCK;
        const valuesRemaining = bytes.shift() ?? 0;
        for (let i = 0; i < valuesRemaining; i++) {
          if (isBytecblock) {
            const length = bytes.shift() ?? 0;
            bytes.splice(0, length);
          } else {
            while (((bytes.shift() ?? 0) & 0x80) !== 0) {
              // intcblock is a uvarint
            }
          }
        }
        if (isBytecblock) bytecblockOffset = programSize - bytes.length - 1;
        else intcblockOffset = programSize - bytes.length - 1;

        if (bytes[0] !== BYTE_CBLOCK && bytes[0] !== INT_CBLOCK) {
          break;
        }
      } else {
        break;
      }
    }

    return Math.max(bytecblockOffset ?? 0, intcblockOffset ?? 0);
  }

  private getABITypeFromStructFields(structFields: StructDef): string {
    const typesArray: unknown[] = [];

    if (Array.isArray(structFields)) {
      for (const field of structFields) {
        const val = field.type;
        if (Array.isArray(val)) {
          typesArray.push(this.getABITypeFromStructFields(val));
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          typesArray.push(this.getABIType(val));
        } else {
          typesArray.push(val);
        }
      }
    } else if (typeof structFields === "object") {
      for (const [, val] of Object.entries(structFields)) {
        if (typeof val === "object") {
          typesArray.push(this.getABITypeFromStructFields(val));
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          typesArray.push(this.getABIType(val));
        } else {
          typesArray.push(val);
        }
      }
    }

    return JSON.stringify(typesArray)
      .replace(/"/g, "")
      .replace(/\]/g, ")")
      .replace(/\[/g, "(");
  }

  private getABIType(type: string): string {
    if (this.arc56.structs && this.arc56.structs[type]) {
      return this.getABITypeFromStructFields(this.arc56.structs[type]);
    }

    return type;
  }

  private getABIEncodedValue(value: unknown, type: string): Uint8Array {
    if (type === "bytes" || type === "AVMBytes") {
      if (typeof value === "string") {
        return new TextEncoder().encode(value);
      }
      if (value instanceof Uint8Array) {
        return value;
      }
      if (ArrayBuffer.isView(value) || Array.isArray(value)) {
        return new Uint8Array(value as ArrayLike<number>);
      }
      return new Uint8Array();
    }
    if (type === "AVMString") {
      if (typeof value === "string") {
        return new TextEncoder().encode(value);
      }
      if (value instanceof Uint8Array) {
        return value;
      }
      if (ArrayBuffer.isView(value) || Array.isArray(value)) {
        return new Uint8Array(value as ArrayLike<number>);
      }
      return new Uint8Array();
    }
    if (type === "AVMUint64") {
      const uintVal =
        typeof value === "bigint"
          ? value
          : typeof value === "number" || typeof value === "string"
            ? BigInt(value)
            : 0n;
      return algosdk.encodeUint64(uintVal);
    }

    const abiType = this.getABIType(type);
    return algosdk.ABIType.from(abiType).encode(this.getABIValue(type, value));
  }

  private getObjectFromStructFieldsAndArray(
    structFields: StructDef,
    valuesArray: unknown[],
  ): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    const arr = [...valuesArray];

    if (Array.isArray(structFields)) {
      for (const field of structFields) {
        const key = field.name;
        const val = field.type;
        const nextVal = arr.shift();
        if (Array.isArray(val)) {
          obj[key] = this.getObjectFromStructFieldsAndArray(
            val,
            Array.isArray(nextVal) ? nextVal : [],
          );
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          obj[key] = this.getObjectFromStructFieldsAndArray(
            this.arc56.structs[val],
            Array.isArray(nextVal) ? nextVal : [],
          );
        } else {
          obj[key] = nextVal;
        }
      }
    } else if (typeof structFields === "object") {
      for (const [key, val] of Object.entries(structFields)) {
        const nextVal = arr.shift();
        if (typeof val === "object") {
          obj[key] = this.getObjectFromStructFieldsAndArray(
            val,
            Array.isArray(nextVal) ? nextVal : [],
          );
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          obj[key] = this.getObjectFromStructFieldsAndArray(
            this.arc56.structs[val],
            Array.isArray(nextVal) ? nextVal : [],
          );
        } else {
          obj[key] = nextVal;
        }
      }
    }

    return obj;
  }

  /** Get the typescript value, which may be the ABIValue or the struct */
  private getTypeScriptValue(type: string, value: Uint8Array): unknown {
    if (type === "bytes" || type === "AVMString") {
      return new TextDecoder().decode(value);
    }
    if (type === "AVMBytes") {
      return value;
    }
    if (type === "AVMUint64") {
      return algosdk.decodeUint64(value);
    }

    const abiType = this.getABIType(type);
    const abiValue = algosdk.ABIType.from(abiType).decode(value);

    if (this.arc56.structs && this.arc56.structs[type]) {
      return this.getObjectFromStructFieldsAndArray(
        this.arc56.structs[type],
        Array.isArray(abiValue) ? abiValue : [abiValue],
      );
    }

    return abiValue;
  }

  private resolveAddress(
    address: string | algosdk.Address | AddressWithTransactionSigner,
  ): string {
    if (typeof address === "string") {
      return address;
    }
    if ("address" in address) {
      return address.address.toString();
    }
    return address.toString();
  }

  private async getLocalStateValue(
    address: string,
    b64Key: string,
    type: string,
  ): Promise<unknown> {
    const result = await this.algod
      .accountApplicationInformation(address, this.appId)
      .do();

    const localState = result.appLocalState?.keyValue ?? [];
    const targetKeyBytes = new Uint8Array(Buffer.from(b64Key, "base64"));

    const keyValue = localState.find((s) => {
      const keyBytes =
        s.key instanceof Uint8Array ? s.key : Buffer.from(s.key, "base64");
      if (keyBytes.length !== targetKeyBytes.length) return false;
      return keyBytes.every((b, i) => b === targetKeyBytes[i]);
    });

    if (!keyValue) {
      throw new Error(`Local state key not found: ${b64Key}`);
    }

    if (keyValue.value.type === 1) {
      const bytes =
        keyValue.value.bytes instanceof Uint8Array
          ? keyValue.value.bytes
          : new Uint8Array(Buffer.from(keyValue.value.bytes, "base64"));
      return this.getTypeScriptValue(type, bytes);
    } else {
      const uintVal =
        typeof keyValue.value.uint === "bigint"
          ? keyValue.value.uint
          : BigInt(keyValue.value.uint);
      return this.getTypeScriptValue(type, algosdk.encodeUint64(uintVal));
    }
  }

  private async getBoxValue(b64Key: string, type: string): Promise<unknown> {
    const boxName = new Uint8Array(Buffer.from(b64Key, "base64"));
    const result = await this.algod
      .getApplicationBoxByName(this.appId, boxName)
      .do();

    const bytes =
      result.value instanceof Uint8Array
        ? result.value
        : new Uint8Array(Buffer.from(result.value, "base64"));
    return this.getTypeScriptValue(type, bytes);
  }

  private async getGlobalStateValue(
    b64Key: string,
    type: string,
  ): Promise<unknown> {
    const result = await this.algod.getApplicationByID(this.appId).do();

    const globalState = result.params?.globalState ?? [];
    const targetKeyBytes = new Uint8Array(Buffer.from(b64Key, "base64"));

    const keyValue = globalState.find((s) => {
      const keyBytes =
        s.key instanceof Uint8Array ? s.key : Buffer.from(s.key, "base64");
      if (keyBytes.length !== targetKeyBytes.length) return false;
      return keyBytes.every((b, i) => b === targetKeyBytes[i]);
    });

    if (!keyValue) {
      throw new Error(`Global state key not found: ${b64Key}`);
    }

    if (keyValue.value.type === 1) {
      const bytes =
        keyValue.value.bytes instanceof Uint8Array
          ? keyValue.value.bytes
          : new Uint8Array(Buffer.from(keyValue.value.bytes, "base64"));
      return this.getTypeScriptValue(type, bytes);
    } else {
      const uintVal =
        typeof keyValue.value.uint === "bigint"
          ? keyValue.value.uint
          : BigInt(keyValue.value.uint);
      return this.getTypeScriptValue(type, algosdk.encodeUint64(uintVal));
    }
  }

  private getABIValuesFromStructFieldsAndObject(
    structFields: StructDef,
    obj: unknown,
  ): algosdk.ABIValue[] {
    const valuesArray: algosdk.ABIValue[] = [];

    if (Array.isArray(structFields)) {
      for (const field of structFields) {
        const key = field.name;
        const val = field.type;
        const prop = isRecord(obj) ? obj[key] : undefined;
        if (Array.isArray(val)) {
          valuesArray.push(
            this.getABIValuesFromStructFieldsAndObject(val, prop),
          );
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          valuesArray.push(
            this.getABIValuesFromStructFieldsAndObject(
              this.arc56.structs[val],
              prop,
            ),
          );
        } else {
          valuesArray.push(prop as algosdk.ABIValue);
        }
      }
    } else if (typeof structFields === "object") {
      for (const [key, val] of Object.entries(structFields)) {
        const prop = isRecord(obj) ? obj[key] : undefined;
        if (typeof val === "object") {
          valuesArray.push(
            this.getABIValuesFromStructFieldsAndObject(val, prop),
          );
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          valuesArray.push(
            this.getABIValuesFromStructFieldsAndObject(
              this.arc56.structs[val],
              prop,
            ),
          );
        } else {
          valuesArray.push(prop as algosdk.ABIValue);
        }
      }
    }

    return valuesArray;
  }

  private getABIValue(type: string, value: unknown): algosdk.ABIValue {
    if (
      type === "bytes" ||
      type === "AVMBytes" ||
      type === "AVMString" ||
      type === "AVMUint64"
    ) {
      return value as algosdk.ABIValue;
    }
    if (this.arc56.structs && this.arc56.structs[type]) {
      return this.getABIValuesFromStructFieldsAndObject(
        this.arc56.structs[type],
        value,
      );
    }

    return value as algosdk.ABIValue;
  }

  async compileProgram(
    program: "clear" | "approval",
    templateVars?: Record<string, string | bigint | number | Uint8Array>,
  ): Promise<Uint8Array> {
    const expectedVarsCount = Object.keys(
      this.arc56.templateVariables ?? {},
    ).length;
    const providedVarsCount = Object.keys(templateVars ?? {}).length;

    if (
      this.arc56.byteCode?.[program] &&
      expectedVarsCount === 0 &&
      providedVarsCount === 0
    ) {
      return new Uint8Array(
        Buffer.from(this.arc56.byteCode[program], "base64"),
      );
    }

    if (!this.arc56.source?.[program]) {
      if (this.arc56.byteCode?.[program]) {
        return new Uint8Array(
          Buffer.from(this.arc56.byteCode[program], "base64"),
        );
      }
      throw new Error(
        `No source or bytecode found for ${program} program in ${this.arc56.name}`,
      );
    }

    let tealString = Buffer.from(this.arc56.source[program], "base64").toString(
      "utf-8",
    );

    if (expectedVarsCount !== providedVarsCount) {
      throw new Error(
        `${this.arc56.name} expected ${expectedVarsCount} template variables but got ${providedVarsCount}`,
      );
    }

    if (templateVars) {
      for (const name of Object.keys(templateVars)) {
        const val = templateVars[name];
        if (val === undefined) {
          throw new Error(`Template variable ${name} is undefined`);
        }
        const varDef = this.arc56.templateVariables?.[name];
        if (!varDef) {
          throw new Error(`Unexpected template variable: ${name}`);
        }
        const { type } = varDef;
        const isUint = type === "uint64" || type === "AVMUint64";
        const op = isUint ? "int" : "byte";
        let formattedVal: string;
        if (isUint) {
          formattedVal = val.toString();
        } else if (val instanceof Uint8Array) {
          formattedVal = "0x" + Buffer.from(val).toString("hex");
        } else if (typeof val === "string" && val.startsWith("0x")) {
          formattedVal = val;
        } else {
          formattedVal = `"${val}"`;
        }

        tealString = tealString.replace(
          new RegExp(`push${op}\\s+TMPL_${name}\\b`, "g"),
          `push${op} ${formattedVal}`,
        );
        tealString = tealString.replace(
          new RegExp(`\\bTMPL_${name}\\b`, "g"),
          formattedVal,
        );
      }
    }

    const result = await this.algod.compile(tealString).do();
    return new Uint8Array(Buffer.from(result.result, "base64"));
  }

  getParams(params: AppClientMethodParams): MethodParams {
    const sender = params.sender;

    if (sender === undefined) {
      throw new Error("No sender provided");
    }

    let abiMethod: algosdk.ABIMethod;
    try {
      abiMethod = this.contract.getMethodByName(params.method);
    } catch {
      throw new Error(
        `Method ${params.method} not found in ${this.arc56.name} ARC56 definition`,
      );
    }

    const arc56Method = this.arc56.methods.find(
      (m) => m.name === params.method,
    );
    if (!arc56Method) {
      throw new Error(
        `Method ${params.method} not found in ${this.arc56.name} ARC56 definition`,
      );
    }

    const rawArgs = params.methodArgs ?? [];
    const encodedArgs = rawArgs.map((a, i) => {
      const argDef = arc56Method.args[i];
      if (!argDef) return a as algosdk.ABIValue;
      return this.getABIValue(argDef.struct ?? argDef.type, a);
    });

    let boxes = params.boxes;
    if (boxes === undefined && arc56Method.recommendations?.boxes) {
      const recBoxes = Array.isArray(arc56Method.recommendations.boxes)
        ? arc56Method.recommendations.boxes
        : [arc56Method.recommendations.boxes];
      boxes = recBoxes.map((b) => ({
        appIndex: b.app ?? 0,
        name: new Uint8Array(Buffer.from(b.key, "base64")),
      }));
    }

    const appAccounts =
      params.appAccounts ??
      (arc56Method.recommendations?.accounts
        ? arc56Method.recommendations.accounts
        : undefined);

    const appForeignApps =
      params.appForeignApps ??
      (arc56Method.recommendations?.apps
        ? arc56Method.recommendations.apps.map(BigInt)
        : undefined);

    const appForeignAssets =
      params.appForeignAssets ??
      (arc56Method.recommendations?.assets
        ? arc56Method.recommendations.assets.map(BigInt)
        : undefined);

    return {
      ...params,
      appID: this.appId,
      method: abiMethod,
      sender,
      methodArgs: encodedArgs,
      ...(boxes !== undefined ? { boxes } : {}),
      ...(appAccounts !== undefined ? { appAccounts } : {}),
      ...(appForeignApps !== undefined ? { appForeignApps } : {}),
      ...(appForeignAssets !== undefined ? { appForeignAssets } : {}),
    };
  }

  private async callWithOC<TReturn = unknown>(
    onComplete: algosdk.OnApplicationComplete,
    params: AppClientMethodParams,
  ): Promise<MethodCallResult<TReturn>> {
    const callOrCreate = this.appId === 0n ? "create" : "call";

    const composer = this.composer();

    composer.addMethodCall({
      ...this.getParams(params),
      onComplete,
    });

    const ocStrings: Array<
      | "NoOp"
      | "OptIn"
      | "CloseOut"
      | "ClearState"
      | "UpdateApplication"
      | "DeleteApplication"
    > = [
      "NoOp",
      "OptIn",
      "CloseOut",
      "ClearState",
      "UpdateApplication",
      "DeleteApplication",
    ];

    const arc56Method = this.arc56.methods.find(
      (m) => m.name === params.method,
    );
    if (!arc56Method) {
      throw new Error(
        `Method ${params.method} not found in ${this.arc56.name} ARC56 definition`,
      );
    }

    const ocString = ocStrings[onComplete] ?? "NoOp";
    if (
      !(arc56Method.actions[callOrCreate] as readonly string[]).includes(
        ocString,
      )
    ) {
      throw Error(`${ocString} is not supported for ${params.method}`);
    }

    const result = await this.executeWithErrorParsing(composer);

    let returnValue: unknown = undefined;

    if (arc56Method.returns.struct ?? arc56Method.returns.type !== "void") {
      const lastRes = result.methodResults.at(-1);
      if (lastRes?.rawReturnValue && lastRes.rawReturnValue.length > 0) {
        returnValue = this.decodeMethodReturnValue(
          params.method,
          lastRes.rawReturnValue,
        );
      }
    }
    return {
      result,
      returnValue: returnValue as TReturn,
    };
  }

  async methodCall<TReturn = unknown>(
    params: AppClientMethodParams,
  ): Promise<MethodCallResult<TReturn>> {
    return await this.callWithOC<TReturn>(
      algosdk.OnApplicationComplete.NoOpOC,
      params,
    );
  }

  async optInMethodCall<TReturn = unknown>(
    params: AppClientMethodParams,
  ): Promise<MethodCallResult<TReturn>> {
    return await this.callWithOC<TReturn>(
      algosdk.OnApplicationComplete.OptInOC,
      params,
    );
  }

  async updateMethodCall<TReturn = unknown>(
    params: AppClientMethodParams,
  ): Promise<MethodCallResult<TReturn>> {
    return await this.callWithOC<TReturn>(
      algosdk.OnApplicationComplete.UpdateApplicationOC,
      params,
    );
  }

  async deleteMethodCall<TReturn = unknown>(
    params: AppClientMethodParams,
  ): Promise<MethodCallResult<TReturn>> {
    return await this.callWithOC<TReturn>(
      algosdk.OnApplicationComplete.DeleteApplicationOC,
      params,
    );
  }

  async closeOutMethodCall<TReturn = unknown>(
    params: AppClientMethodParams,
  ): Promise<MethodCallResult<TReturn>> {
    return await this.callWithOC<TReturn>(
      algosdk.OnApplicationComplete.CloseOutOC,
      params,
    );
  }

  async clearStateMethodCall<TReturn = unknown>(
    params: AppClientMethodParams,
  ): Promise<MethodCallResult<TReturn>> {
    return await this.callWithOC<TReturn>(
      algosdk.OnApplicationComplete.ClearStateOC,
      params,
    );
  }

  static async create<TReturn = unknown>(
    params: ARC56AppClientCreateParams,
  ): Promise<CreateMethodCallResult<TReturn>> {
    const { arc56, algod, getSuggestedParams, ...methodParams } = params;
    const clientParams = { arc56, algod, getSuggestedParams };

    const tempClient = new ARC56AppClient({
      ...clientParams,
      appId: 0n,
    });

    const numGlobalByteSlices =
      methodParams.numGlobalByteSlices ??
      tempClient.arc56.state?.schema?.global?.bytes ??
      0;
    const numGlobalInts =
      methodParams.numGlobalInts ??
      tempClient.arc56.state?.schema?.global?.ints ??
      0;
    const numLocalByteSlices =
      methodParams.numLocalByteSlices ??
      tempClient.arc56.state?.schema?.local?.bytes ??
      0;
    const numLocalInts =
      methodParams.numLocalInts ??
      tempClient.arc56.state?.schema?.local?.ints ??
      0;

    const approvalProgram =
      methodParams.approvalProgram ??
      (await tempClient.compileProgram(
        "approval",
        methodParams.templateVariables,
      ));
    const clearProgram =
      methodParams.clearProgram ??
      (await tempClient.compileProgram(
        "clear",
        methodParams.templateVariables,
      ));

    const callParams: AppClientMethodParams = {
      ...methodParams,
      numGlobalByteSlices,
      numGlobalInts,
      numLocalByteSlices,
      numLocalInts,
      approvalProgram,
      clearProgram,
    };

    const result = await tempClient.callWithOC<TReturn>(
      methodParams.onComplete ?? algosdk.OnApplicationComplete.NoOpOC,
      callParams,
    );

    const createdAppId =
      result.result.methodResults.at(-1)?.txInfo?.applicationIndex;
    if (createdAppId === undefined) {
      throw Error(
        "Application creation failed: applicationIndex not found in method execution result",
      );
    }

    const appClient = new ARC56AppClient({
      ...clientParams,
      appId: createdAppId,
    });

    return {
      appClient,
      appId: appClient.appId,
      appAddress: appClient.appAddress,
      result: result.result,
      returnValue: result.returnValue,
    };
  }

  static async createMethodCall<TReturn = unknown>(
    params: ARC56AppClientCreateParams,
  ): Promise<CreateMethodCallResult<TReturn>> {
    return await ARC56AppClient.create<TReturn>(params);
  }

  getState = {
    key: async <T = unknown>(
      key: string,
      address?: string | algosdk.Address | AddressWithTransactionSigner,
    ): Promise<T> => {
      if (this.arc56.state?.keys?.global?.[key]) {
        return (await this.getGlobalStateValue(
          this.arc56.state.keys.global[key].key,
          this.arc56.state.keys.global[key].valueType,
        )) as T;
      }

      if (this.arc56.state?.keys?.local?.[key]) {
        if (!address) {
          throw new Error(
            `Address must be provided for local key ${key} in ${this.arc56.name} state`,
          );
        }
        const addr = this.resolveAddress(address);
        return (await this.getLocalStateValue(
          addr,
          this.arc56.state.keys.local[key].key,
          this.arc56.state.keys.local[key].valueType,
        )) as T;
      }

      if (this.arc56.state?.keys?.box?.[key]) {
        return (await this.getBoxValue(
          this.arc56.state.keys.box[key].key,
          this.arc56.state.keys.box[key].valueType,
        )) as T;
      }

      throw new Error(`Key ${key} not found in ${this.arc56.name} state`);
    },

    map: {
      value: async <T = unknown>(
        mapName: string,
        key: unknown,
        address?: string | algosdk.Address | AddressWithTransactionSigner,
      ): Promise<T> => {
        let mapObject: StorageMap | undefined;

        if (this.arc56.state?.maps?.global?.[mapName]) {
          mapObject = this.arc56.state.maps.global[mapName];
        } else if (this.arc56.state?.maps?.local?.[mapName]) {
          mapObject = this.arc56.state.maps.local[mapName];
        } else if (this.arc56.state?.maps?.box?.[mapName]) {
          mapObject = this.arc56.state.maps.box[mapName];
        }

        if (!mapObject) {
          throw new Error(
            `Map ${mapName} not found in ${this.arc56.name} state`,
          );
        }

        const prefixBytes = new TextEncoder().encode(mapObject.prefix ?? "");
        const keyBytes = this.getABIEncodedValue(key, mapObject.keyType);
        const encodedKey = new Uint8Array(prefixBytes.length + keyBytes.length);
        encodedKey.set(prefixBytes, 0);
        encodedKey.set(keyBytes, prefixBytes.length);
        const b64Key = Buffer.from(encodedKey).toString("base64");

        if (this.arc56.state?.maps?.global?.[mapName]) {
          return (await this.getGlobalStateValue(
            b64Key,
            mapObject.valueType,
          )) as T;
        }

        if (this.arc56.state?.maps?.local?.[mapName]) {
          if (!address) {
            throw new Error(
              `Address must be provided for local map ${mapName} in ${this.arc56.name} state`,
            );
          }
          const addr = this.resolveAddress(address);
          return (await this.getLocalStateValue(
            addr,
            b64Key,
            mapObject.valueType,
          )) as T;
        }

        if (this.arc56.state?.maps?.box?.[mapName]) {
          return (await this.getBoxValue(b64Key, mapObject.valueType)) as T;
        }

        throw new Error(`Map ${mapName} not found in ${this.arc56.name} state`);
      },
    },
  };

  decodeMethodReturnValue<T = unknown>(
    methodName: string,
    rawValue: Uint8Array,
  ): MethodReturnValue<T> {
    const method = this.arc56.methods.find((m) => m.name === methodName);
    if (!method) {
      throw new Error(`Method ${methodName} not found in ${this.arc56.name}`);
    }
    if (method.returns.type === "void" || rawValue.length === 0) {
      return undefined as T;
    }
    return this.getTypeScriptValue(
      method.returns.struct ?? method.returns.type,
      rawValue,
    ) as T;
  }
}
