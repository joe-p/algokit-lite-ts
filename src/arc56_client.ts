import algosdk, {
  Algodv2,
  type AddressWithTransactionSigner,
  type SuggestedParams,
} from "algosdk";
import { Composer, type MethodParams } from "./composer";
import { type ARC56Contract, type StorageMap } from "./types/arc56";

export type AppClientMethodParams = Omit<
  MethodParams,
  "appID" | "method" | "sender" | "methodArgs"
> & {
  sender?: AddressWithTransactionSigner;
  methodArgs?: any[];
};

export type CreateMethodParams = AppClientMethodParams & {
  templateVariables?: Record<string, string | bigint | number | Uint8Array>;
};

export type MethodExecutionResult = {
  confirmedRound: bigint;
  txIDs: string[];
  methodResults: algosdk.ABIResult[];
};

export interface ARC56AppClientParams {
  arc56: ARC56Contract;
  appId?: bigint | number;
  algod: Algodv2;
  getSuggestedParams?: () => Promise<SuggestedParams>;
}

export class ARC56AppClient {
  appId: bigint;
  algod: Algodv2;
  contract: algosdk.ABIContract;
  appAddress: algosdk.Address;
  arc56: ARC56Contract;
  getSuggestedParams?: () => Promise<SuggestedParams>;

  constructor(p: ARC56AppClientParams) {
    this.arc56 = p.arc56;
    this.appId = p.appId !== undefined ? BigInt(p.appId) : 0n;
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
    } catch (e: any) {
      const str = e?.message
        ? `${e.message} ${JSON.stringify(e)}`
        : JSON.stringify(e);
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
            s?.pc?.includes(pc),
          )?.errorMessage;
        } else if (this.arc56.sourceInfo.approval) {
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
            s?.pc?.includes(targetPc),
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
      const byte = bytes.shift()!;
      if (byte === BYTE_CBLOCK || byte === INT_CBLOCK) {
        const isBytecblock = byte === BYTE_CBLOCK;
        const valuesRemaining = bytes.shift()!;
        for (let i = 0; i < valuesRemaining; i++) {
          if (isBytecblock) {
            const length = bytes.shift()!;
            bytes.splice(0, length);
          } else {
            while ((bytes.shift()! & 0x80) !== 0) {
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

  private getABITypeFromStructFields(structFields: any): string {
    const typesArray: any[] = [];

    if (Array.isArray(structFields)) {
      for (const field of structFields) {
        const val = field.type;
        if (Array.isArray(val) || (typeof val === "object" && val !== null)) {
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
    } else {
      for (const key in structFields) {
        const val = structFields[key];
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
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

  private getABIEncodedValue(value: any, type: string): Uint8Array {
    if (type === "bytes" || type === "AVMBytes") {
      if (typeof value === "string") {
        return new TextEncoder().encode(value);
      }
      if (value instanceof Uint8Array) {
        return value;
      }
      return new Uint8Array(value);
    }
    if (type === "AVMString") {
      if (typeof value === "string") {
        return new TextEncoder().encode(value);
      }
      return new Uint8Array(value);
    }
    if (type === "AVMUint64") {
      const uintVal = typeof value === "bigint" ? value : BigInt(value);
      return algosdk.encodeUint64(uintVal);
    }

    const abiType = this.getABIType(type);
    return algosdk.ABIType.from(abiType).encode(this.getABIValue(type, value));
  }

  private getObjectFromStructFieldsAndArray(
    structFields: any,
    valuesArray: any[],
  ): any {
    const obj: any = {};
    const arr = [...valuesArray];

    if (Array.isArray(structFields)) {
      for (const field of structFields) {
        const key = field.name;
        const val = field.type;
        if (Array.isArray(val) || (typeof val === "object" && val !== null)) {
          obj[key] = this.getObjectFromStructFieldsAndArray(val, arr.shift());
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          obj[key] = this.getObjectFromStructFieldsAndArray(
            this.arc56.structs[val],
            arr.shift(),
          );
        } else {
          obj[key] = arr.shift();
        }
      }
    } else {
      for (const key in structFields) {
        const val = structFields[key];
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          obj[key] = this.getObjectFromStructFieldsAndArray(val, arr.shift());
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          obj[key] = this.getObjectFromStructFieldsAndArray(
            this.arc56.structs[val],
            arr.shift(),
          );
        } else {
          obj[key] = arr.shift();
        }
      }
    }

    return obj;
  }

  /** Get the typescript value, which may be the ABIValue or the struct */
  private getTypeScriptValue(type: string, value: Uint8Array): any {
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
        abiValue as algosdk.ABIValue[],
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
  ): Promise<any> {
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

    if (Number(keyValue.value.type) === 1) {
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

  private async getBoxValue(b64Key: string, type: string): Promise<any> {
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
  ): Promise<any> {
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

    if (Number(keyValue.value.type) === 1) {
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
    structFields: any,
    obj: any,
  ): algosdk.ABIValue[] {
    const valuesArray: any[] = [];

    if (Array.isArray(structFields)) {
      for (const field of structFields) {
        const key = field.name;
        const val = field.type;
        if (Array.isArray(val) || (typeof val === "object" && val !== null)) {
          valuesArray.push(
            this.getABIValuesFromStructFieldsAndObject(val, obj[key]),
          );
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          valuesArray.push(
            this.getABIValuesFromStructFieldsAndObject(
              this.arc56.structs[val],
              obj[key],
            ),
          );
        } else {
          valuesArray.push(obj[key]);
        }
      }
    } else {
      for (const key in structFields) {
        const val = structFields[key];
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          valuesArray.push(
            this.getABIValuesFromStructFieldsAndObject(val, obj[key]),
          );
        } else if (
          typeof val === "string" &&
          this.arc56.structs &&
          this.arc56.structs[val]
        ) {
          valuesArray.push(
            this.getABIValuesFromStructFieldsAndObject(
              this.arc56.structs[val],
              obj[key],
            ),
          );
        } else {
          valuesArray.push(obj[key]);
        }
      }
    }

    return valuesArray;
  }

  private getABIValue(type: string, value: any): algosdk.ABIValue {
    if (
      type === "bytes" ||
      type === "AVMBytes" ||
      type === "AVMString" ||
      type === "AVMUint64"
    ) {
      return value;
    }
    if (this.arc56.structs && this.arc56.structs[type]) {
      return this.getABIValuesFromStructFieldsAndObject(
        this.arc56.structs[type],
        value,
      );
    }

    return value;
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

  getParams(
    methodName: string,
    methodParams?: AppClientMethodParams,
  ): MethodParams {
    const sender = methodParams?.sender;

    if (sender === undefined) {
      throw new Error("No sender provided");
    }

    let method: algosdk.ABIMethod;
    try {
      method = this.contract.getMethodByName(methodName);
    } catch {
      throw new Error(
        `Method ${methodName} not found in ${this.arc56.name} ARC56 definition`,
      );
    }

    const arc56Method = this.arc56.methods.find((m) => m.name === methodName);
    if (!arc56Method) {
      throw new Error(
        `Method ${methodName} not found in ${this.arc56.name} ARC56 definition`,
      );
    }

    const rawArgs = methodParams?.methodArgs ?? [];
    const encodedArgs = rawArgs.map((a, i) => {
      const argDef = arc56Method.args[i];
      if (!argDef) return a;
      return this.getABIValue(argDef.struct ?? argDef.type, a);
    });

    let boxes = methodParams?.boxes;
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
      methodParams?.appAccounts ??
      (arc56Method.recommendations?.accounts
        ? arc56Method.recommendations.accounts
        : undefined);

    const appForeignApps =
      methodParams?.appForeignApps ??
      (arc56Method.recommendations?.apps
        ? arc56Method.recommendations.apps.map(BigInt)
        : undefined);

    const appForeignAssets =
      methodParams?.appForeignAssets ??
      (arc56Method.recommendations?.assets
        ? arc56Method.recommendations.assets.map(BigInt)
        : undefined);

    return {
      ...methodParams,
      appID: this.appId,
      method,
      sender,
      methodArgs: encodedArgs,
      ...(boxes !== undefined ? { boxes } : {}),
      ...(appAccounts !== undefined ? { appAccounts } : {}),
      ...(appForeignApps !== undefined ? { appForeignApps } : {}),
      ...(appForeignAssets !== undefined ? { appForeignAssets } : {}),
    };
  }

  private async callWithOC(
    methodName: string,
    onComplete: algosdk.OnApplicationComplete,
    methodParams: AppClientMethodParams = {},
  ) {
    const callOrCreate = this.appId === 0n ? "create" : "call";

    const composer = this.composer();

    composer.addMethodCall({
      ...this.getParams(methodName, methodParams),
      onComplete,
    });

    const ocStrings = [
      "NoOp",
      "OptIn",
      "CloseOut",
      "ClearState",
      "UpdateApplication",
      "DeleteApplication",
    ];

    const method = this.arc56.methods.find((m) => m.name === methodName);
    if (!method) {
      throw new Error(
        `Method ${methodName} not found in ${this.arc56.name} ARC56 definition`,
      );
    }

    if (!method.actions[callOrCreate].includes(ocStrings[onComplete] as any)) {
      throw Error(
        `${ocStrings[onComplete]} is not supported for ${methodName}`,
      );
    }

    const result = await this.executeWithErrorParsing(composer);

    let returnValue: any = undefined;

    if (method.returns.struct ?? method.returns.type !== "void") {
      const lastRes = result.methodResults.at(-1);
      if (lastRes?.rawReturnValue && lastRes.rawReturnValue.length > 0) {
        returnValue = this.decodeMethodReturnValue(
          methodName,
          lastRes.rawReturnValue,
        );
      }
    }
    return {
      result,
      returnValue,
    };
  }

  async methodCall(
    methodName: string,
    methodParams: AppClientMethodParams = {},
  ) {
    return await this.callWithOC(
      methodName,
      algosdk.OnApplicationComplete.NoOpOC,
      methodParams,
    );
  }

  async optInMethodCall(
    methodName: string,
    methodParams: AppClientMethodParams = {},
  ) {
    return await this.callWithOC(
      methodName,
      algosdk.OnApplicationComplete.OptInOC,
      methodParams,
    );
  }

  async updateMethodCall(
    methodName: string,
    methodParams: AppClientMethodParams = {},
  ) {
    return await this.callWithOC(
      methodName,
      algosdk.OnApplicationComplete.UpdateApplicationOC,
      methodParams,
    );
  }

  async deleteMethodCall(
    methodName: string,
    methodParams: AppClientMethodParams = {},
  ) {
    return await this.callWithOC(
      methodName,
      algosdk.OnApplicationComplete.DeleteApplicationOC,
      methodParams,
    );
  }

  async closeOutMethodCall(
    methodName: string,
    methodParams: AppClientMethodParams = {},
  ) {
    return await this.callWithOC(
      methodName,
      algosdk.OnApplicationComplete.CloseOutOC,
      methodParams,
    );
  }

  async clearStateMethodCall(
    methodName: string,
    methodParams: AppClientMethodParams = {},
  ) {
    return await this.callWithOC(
      methodName,
      algosdk.OnApplicationComplete.ClearStateOC,
      methodParams,
    );
  }

  async createMethodCall(
    methodName: string,
    methodParams: CreateMethodParams = {},
  ) {
    if (this.appId !== 0n) {
      throw Error(
        `Create was called but the app has already been created: ${this.appId.toString()}`,
      );
    }

    const numGlobalByteSlices =
      methodParams.numGlobalByteSlices ??
      this.arc56.state?.schema?.global?.bytes ??
      0;
    const numGlobalInts =
      methodParams.numGlobalInts ?? this.arc56.state?.schema?.global?.ints ?? 0;
    const numLocalByteSlices =
      methodParams.numLocalByteSlices ??
      this.arc56.state?.schema?.local?.bytes ??
      0;
    const numLocalInts =
      methodParams.numLocalInts ?? this.arc56.state?.schema?.local?.ints ?? 0;

    const approvalProgram =
      methodParams.approvalProgram ??
      (await this.compileProgram("approval", methodParams.templateVariables));
    const clearProgram =
      methodParams.clearProgram ??
      (await this.compileProgram("clear", methodParams.templateVariables));

    const params: AppClientMethodParams = {
      ...methodParams,
      numGlobalByteSlices,
      numGlobalInts,
      numLocalByteSlices,
      numLocalInts,
      approvalProgram,
      clearProgram,
    };

    const result = await this.callWithOC(
      methodName,
      methodParams.onComplete ?? algosdk.OnApplicationComplete.NoOpOC,
      params,
    );

    const createdAppId =
      result.result.methodResults.at(-1)?.txInfo?.applicationIndex;
    if (createdAppId !== undefined) {
      this.appId = BigInt(createdAppId);
      this.appAddress = algosdk.getApplicationAddress(this.appId);
    }

    return {
      appId: this.appId,
      appAddress: this.appAddress,
      result: result.result,
      returnValue: result.returnValue,
    };
  }

  getState = {
    key: async (
      key: string,
      address?: string | algosdk.Address | AddressWithTransactionSigner,
    ): Promise<any> => {
      if (this.arc56.state?.keys?.global?.[key]) {
        return await this.getGlobalStateValue(
          this.arc56.state.keys.global[key].key,
          this.arc56.state.keys.global[key].valueType,
        );
      }

      if (this.arc56.state?.keys?.local?.[key]) {
        if (!address) {
          throw new Error(
            `Address must be provided for local key ${key} in ${this.arc56.name} state`,
          );
        }
        const addr = this.resolveAddress(address);
        return await this.getLocalStateValue(
          addr,
          this.arc56.state.keys.local[key].key,
          this.arc56.state.keys.local[key].valueType,
        );
      }

      if (this.arc56.state?.keys?.box?.[key]) {
        return await this.getBoxValue(
          this.arc56.state.keys.box[key].key,
          this.arc56.state.keys.box[key].valueType,
        );
      }

      throw new Error(`Key ${key} not found in ${this.arc56.name} state`);
    },

    map: {
      value: async (
        mapName: string,
        key: any,
        address?: string | algosdk.Address | AddressWithTransactionSigner,
      ): Promise<any> => {
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
          return await this.getGlobalStateValue(b64Key, mapObject.valueType);
        }

        if (this.arc56.state?.maps?.local?.[mapName]) {
          if (!address) {
            throw new Error(
              `Address must be provided for local map ${mapName} in ${this.arc56.name} state`,
            );
          }
          const addr = this.resolveAddress(address);
          return await this.getLocalStateValue(
            addr,
            b64Key,
            mapObject.valueType,
          );
        }

        if (this.arc56.state?.maps?.box?.[mapName]) {
          return await this.getBoxValue(b64Key, mapObject.valueType);
        }
      },
    },
  };

  decodeMethodReturnValue(methodName: string, rawValue: Uint8Array): any {
    const method = this.arc56.methods.find((m) => m.name === methodName);
    if (!method) {
      throw new Error(`Method ${methodName} not found in ${this.arc56.name}`);
    }
    if (method.returns.type === "void" || !rawValue || rawValue.length === 0) {
      return undefined;
    }
    return this.getTypeScriptValue(
      method.returns.struct ?? method.returns.type,
      rawValue,
    );
  }
}
