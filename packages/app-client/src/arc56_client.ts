import algosdk, {
  Algodv2,
  type AddressWithTransactionSigner,
  type SuggestedParams,
} from "algosdk";
import {
  Composer,
  type AppCreateParams,
  type ComposerSender,
  type ARC56MethodParams,
  type MethodParams,
  type MethodResult,
  type ARC56Contract,
  type Method,
  type StorageMap,
  getABIType as utilsGetABIType,
  getABIValue as utilsGetABIValue,
  getTypeScriptValue as utilsGetTypeScriptValue,
  decodeMethodReturnValue as utilsDecodeMethodReturnValue,
  getAbiMethod,
  parseLogicError,
} from "@joe-p/algokit-lite-composer";

/** Bytes of program that fit in a single application program page */
const APP_PAGE_SIZE = 2048;

/**
 * The number of extra program pages needed to hold both programs. The first
 * page is free, so a pair of programs totalling one page needs no extras.
 */
function requiredExtraPages(
  approvalProgram: Uint8Array,
  clearProgram: Uint8Array,
): number {
  const pages = Math.ceil(
    (approvalProgram.length + clearProgram.length) / APP_PAGE_SIZE,
  );

  return Math.max(pages - 1, 0);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytesEqual(bytes.subarray(0, prefix.length), prefix);
}

/** ARC56 action names, indexed by their OnApplicationComplete value */
const ON_COMPLETE_STRINGS: Array<
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

export type AppClientMethodParams = Omit<
  ARC56MethodParams,
  "appID" | "method" | "sender" | "methodArgs" | "arc56"
> & {
  method: algosdk.ABIMethod | string;
  sender?: AddressWithTransactionSigner;
  methodArgs?: unknown[];
};

export type CreateMethodParams = AppClientMethodParams & {
  templateVariables?: Record<string, string | bigint | number | Uint8Array>;
};

/**
 * Params for creating an app with a bare (non-ABI) call. The programs and the
 * state schema default to what the ARC56 contract declares.
 */
export type BareCreateParams = Omit<
  AppCreateParams,
  | "onComplete"
  | "approvalProgram"
  | "clearProgram"
  | "numGlobalByteSlices"
  | "numGlobalInts"
  | "numLocalByteSlices"
  | "numLocalInts"
> & {
  onComplete?: algosdk.OnApplicationComplete;
  approvalProgram?: Uint8Array;
  clearProgram?: Uint8Array;
  numGlobalByteSlices?: number;
  numGlobalInts?: number;
  numLocalByteSlices?: number;
  numLocalInts?: number;
  templateVariables?: Record<string, string | bigint | number | Uint8Array>;
};

export type MethodExecutionResult = {
  confirmedRound: bigint;
  txIDs: string[];
  methodResults: MethodResult[];
};

export type SimulateMethodParams = Omit<AppClientMethodParams, "sender"> & {
  sender: ComposerSender;
};

export type MethodSimulationResult = {
  simulateResponse: algosdk.modelsv2.SimulateResponse;
  methodResults: MethodResult[];
};

export type MethodSimulateCallResult<TReturn = unknown> = {
  result: MethodSimulationResult;
  returnValue: TReturn;
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

export type BareExecutionResult = {
  confirmedRound: bigint;
  txIDs: string[];
};

export type BareCreateResult = {
  appClient: ARC56AppClient;
  appId: bigint;
  appAddress: algosdk.Address;
  result: BareExecutionResult;
};

export type MethodReturnValue<T = unknown> = T;

/**
 * All the global, local or box state of an app, decoded with the ARC56 contract.
 * Keys that are not set on chain are omitted.
 */
export type DecodedState = {
  /** The values of the set ARC56 state keys, by key name */
  keys: Record<string, unknown>;
  /** The entries of each ARC56 state map, by map name */
  maps: Record<string, Array<{ key: unknown; value: unknown }>>;
};

/** The raw bytes of a global, local or box state key and its value */
type RawStateEntry = { key: Uint8Array; value: Uint8Array };

export interface ARC56AppClientParams {
  arc56: ARC56Contract;
  appId: bigint | number;
  algod: Algodv2;
  getSuggestedParams?: () => Promise<SuggestedParams>;
}

export type ARC56AppClientCreateParams = Omit<ARC56AppClientParams, "appId"> &
  CreateMethodParams;

export type ARC56AppClientBareCreateParams = Omit<
  ARC56AppClientParams,
  "appId"
> &
  BareCreateParams;

export class ARC56AppClient {
  readonly appId: bigint;
  algod: Algodv2;
  contract: algosdk.ABIContract;
  readonly appAddress: algosdk.Address;
  arc56: ARC56Contract;
  getSuggestedParams?: () => Promise<SuggestedParams>;
  /** The approval program being created, while appId is 0 */
  private createApprovalProgram?: Uint8Array;

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

  /**
   * The deployed approval program, which errors are mapped with when the
   * source info uses the "cblocks" pcOffsetMethod. Undefined otherwise, so
   * algod is only queried when the program is needed.
   */
  private async deployedApprovalProgram(): Promise<Uint8Array | undefined> {
    const sourceInfo = this.arc56.sourceInfo;
    if (
      !sourceInfo ||
      Array.isArray(sourceInfo) ||
      sourceInfo.approval.pcOffsetMethod !== "cblocks"
    ) {
      return undefined;
    }

    if (this.appId === 0n) return this.createApprovalProgram;

    try {
      const app = await this.algod.getApplicationByID(this.appId).do();
      return app.params?.approvalProgram;
    } catch {
      return undefined;
    }
  }

  private async executeWithErrorParsing(composer: Composer<unknown[]>) {
    try {
      return await composer.execute(this.algod);
    } catch (e: unknown) {
      const eMsg = e instanceof Error ? e.message : "";
      const str = eMsg ? `${eMsg} ${JSON.stringify(e)}` : JSON.stringify(e);
      throw (
        parseLogicError(
          this.arc56,
          this.appId,
          str,
          e,
          await this.deployedApprovalProgram(),
        ) ?? e
      );
    }
  }

  private getABIType(type: string): string {
    return utilsGetABIType(this.arc56, type);
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

  /** Get the typescript value, which may be the ABIValue or the struct */
  private getTypeScriptValue(type: string, value: Uint8Array): unknown {
    return utilsGetTypeScriptValue(this.arc56, type, value);
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

  /** The raw key/value pairs of the app's global state */
  private async getRawGlobalState(): Promise<algosdk.modelsv2.TealKeyValue[]> {
    const result = await this.algod.getApplicationByID(this.appId).do();
    return result.params?.globalState ?? [];
  }

  /** The raw key/value pairs of an account's local state for the app */
  private async getRawLocalState(
    address: string,
  ): Promise<algosdk.modelsv2.TealKeyValue[]> {
    const result = await this.algod
      .accountApplicationInformation(address, this.appId)
      .do();
    return result.appLocalState?.keyValue ?? [];
  }

  /** The bytes of a state value, with uints encoded as uint64 */
  private stateValueBytes(value: algosdk.modelsv2.TealValue): Uint8Array {
    if (value.type === 1) {
      return value.bytes instanceof Uint8Array
        ? value.bytes
        : algosdk.base64ToBytes(value.bytes);
    }
    const uintVal =
      typeof value.uint === "bigint" ? value.uint : BigInt(value.uint);
    return algosdk.encodeUint64(uintVal);
  }

  private stateKeyBytes(kv: algosdk.modelsv2.TealKeyValue): Uint8Array {
    return kv.key instanceof Uint8Array
      ? kv.key
      : algosdk.base64ToBytes(kv.key);
  }

  /** The raw key/value pairs of global or local state */
  private rawStateEntries(
    state: algosdk.modelsv2.TealKeyValue[],
  ): RawStateEntry[] {
    return state.map((kv) => ({
      key: this.stateKeyBytes(kv),
      value: this.stateValueBytes(kv.value),
    }));
  }

  /**
   * The names and values of the app's boxes that start with any of the given
   * prefixes, paging through the results with every page pinned to one round
   */
  private async getRawBoxes(prefixes: Uint8Array[]): Promise<RawStateEntry[]> {
    // Drop any prefix covered by a shorter one, so no box is fetched twice
    const queries = prefixes
      .sort((a, b) => a.length - b.length)
      .filter(
        (prefix, i, sorted) =>
          !sorted.slice(0, i).some((shorter) => startsWith(prefix, shorter)),
      );

    const boxes: RawStateEntry[] = [];
    let round: number | undefined;
    for (const prefix of queries) {
      let next: string | undefined;
      do {
        const request = this.algod
          .getApplicationBoxes(this.appId)
          .include("values");
        if (next !== undefined) request.next(next);
        if (prefix.length > 0) request.prefix(prefix);
        if (round !== undefined) request.round(round);

        const result = await request.do();
        round ??= result.round;
        for (const box of result.boxes) {
          boxes.push({ key: box.name, value: box.value ?? new Uint8Array() });
        }
        next = result.nextToken;
      } while (next);
    }

    return boxes;
  }

  private findStateValue(
    state: algosdk.modelsv2.TealKeyValue[],
    b64Key: string,
    type: string,
    storage: "Global" | "Local",
  ): unknown {
    const targetKeyBytes = algosdk.base64ToBytes(b64Key);

    const keyValue = state.find((s) =>
      bytesEqual(this.stateKeyBytes(s), targetKeyBytes),
    );

    if (!keyValue) {
      throw new Error(`${storage} state key not found: ${b64Key}`);
    }

    return this.getTypeScriptValue(type, this.stateValueBytes(keyValue.value));
  }

  /** Decode every ARC56 key and map entry in raw global, local or box state */
  private decodeState(
    state: RawStateEntry[],
    storage: "global" | "local" | "box",
  ): DecodedState {
    const keyDefs = Object.entries(this.arc56.state?.keys?.[storage] ?? {}).map(
      ([name, k]) => ({ name, k, key: algosdk.base64ToBytes(k.key) }),
    );
    const mapDefs = Object.entries(this.arc56.state?.maps?.[storage] ?? {})
      .map(([name, map]) => ({
        name,
        map,
        prefix: algosdk.base64ToBytes(map.prefix ?? ""),
      }))
      // Match the most specific prefix first
      .sort((a, b) => b.prefix.length - a.prefix.length);

    const decoded: DecodedState = {
      keys: Object.create(null) as DecodedState["keys"],
      maps: Object.create(null) as DecodedState["maps"],
    };
    for (const { name } of mapDefs) decoded.maps[name] = [];

    for (const { key: keyBytes, value: valueBytes } of state) {
      const keyDef = keyDefs.find(({ key }) => bytesEqual(key, keyBytes));
      if (keyDef) {
        decoded.keys[keyDef.name] = this.getTypeScriptValue(
          keyDef.k.valueType,
          valueBytes,
        );
        continue;
      }

      for (const { name, map, prefix } of mapDefs) {
        if (!startsWith(keyBytes, prefix)) continue;
        let key: unknown;
        try {
          key = this.getTypeScriptValue(
            map.keyType,
            keyBytes.subarray(prefix.length),
          );
        } catch {
          // Not an entry of this map, so try the next one
          continue;
        }
        const value = this.getTypeScriptValue(map.valueType, valueBytes);
        decoded.maps[name]?.push({ key, value });
        break;
      }
    }

    return decoded;
  }

  private async getLocalStateValue(
    address: string,
    b64Key: string,
    type: string,
  ): Promise<unknown> {
    return this.findStateValue(
      await this.getRawLocalState(address),
      b64Key,
      type,
      "Local",
    );
  }

  private async getBoxValue(b64Key: string, type: string): Promise<unknown> {
    const boxName = algosdk.base64ToBytes(b64Key);
    const result = await this.algod
      .getApplicationBoxByName(this.appId, boxName)
      .do();

    const bytes =
      result.value instanceof Uint8Array
        ? result.value
        : algosdk.base64ToBytes(result.value);
    return this.getTypeScriptValue(type, bytes);
  }

  private async getGlobalStateValue(
    b64Key: string,
    type: string,
  ): Promise<unknown> {
    return this.findStateValue(
      await this.getRawGlobalState(),
      b64Key,
      type,
      "Global",
    );
  }

  private getABIValue(type: string, value: unknown): algosdk.ABIValue {
    return utilsGetABIValue(this.arc56, type, value);
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
      return algosdk.base64ToBytes(this.arc56.byteCode[program]);
    }

    if (!this.arc56.source?.[program]) {
      if (this.arc56.byteCode?.[program]) {
        return algosdk.base64ToBytes(this.arc56.byteCode[program]);
      }
      throw new Error(
        `No source or bytecode found for ${program} program in ${this.arc56.name}`,
      );
    }

    let tealString = algosdk.bytesToString(
      algosdk.base64ToBytes(this.arc56.source[program]),
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
          formattedVal = "0x" + algosdk.bytesToHex(val);
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
    return algosdk.base64ToBytes(result.result);
  }

  getParams<TReturn = unknown>(
    params: AppClientMethodParams,
  ): MethodParams<TReturn> {
    const sender = params.sender;

    if (sender === undefined) {
      throw new Error("No sender provided");
    }

    const { abiMethod, arc56Method } = getAbiMethod(this.arc56, params.method);

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
        name: algosdk.base64ToBytes(b.key),
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
      arc56: this.arc56,
      ...(boxes !== undefined ? { boxes } : {}),
      ...(appAccounts !== undefined ? { appAccounts } : {}),
      ...(appForeignApps !== undefined ? { appForeignApps } : {}),
      ...(appForeignAssets !== undefined ? { appForeignAssets } : {}),
    };
  }

  /** Compose a call of an ARC56 method, checking the OnComplete is allowed */
  private composeMethodCall(params: AppClientMethodParams) {
    const onComplete =
      params.onComplete ?? algosdk.OnApplicationComplete.NoOpOC;
    const callOrCreate = this.appId === 0n ? "create" : "call";

    const composer = new Composer({
      getSuggestedParams:
        this.getSuggestedParams ??
        (() => this.algod.getTransactionParams().do()),
    });

    composer.addMethodCall({
      ...this.getParams(params),
      onComplete,
    });

    const { arc56Method } = getAbiMethod(this.arc56, params.method);

    const ocString = ON_COMPLETE_STRINGS[onComplete] ?? "NoOp";
    if (
      !(arc56Method.actions[callOrCreate] as readonly string[]).includes(
        ocString,
      )
    ) {
      const identifier =
        typeof params.method === "string"
          ? params.method
          : params.method.getSignature();
      throw Error(`${ocString} is not supported for ${identifier}`);
    }

    return { composer, arc56Method };
  }

  /** Decode the return value of the last method call in a group */
  private lastReturnValue(
    method: algosdk.ABIMethod | string,
    arc56Method: Method,
    methodResults: MethodResult[],
  ): unknown {
    if (!(arc56Method.returns.struct ?? arc56Method.returns.type !== "void")) {
      return undefined;
    }
    const lastRes = methodResults.at(-1);
    if (lastRes?.rawReturnValue && lastRes.rawReturnValue.length > 0) {
      return this.decodeMethodReturnValue(method, lastRes.rawReturnValue);
    }
    return undefined;
  }

  /**
   * Simulate a method call instead of sending it, as is done for readonly
   * methods. Nothing is signed, so the sender's signer is never called. Throws if
   * the call fails, with the ARC56 error message when the source info has one.
   */
  async simulateMethodCall<TReturn = unknown>(
    params: SimulateMethodParams,
  ): Promise<MethodSimulateCallResult<TReturn>> {
    const { composer, arc56Method } = this.composeMethodCall(params);

    const { simulateResponse, methodResults } = await composer.simulate(
      this.algod,
      {
        skipSignatures: true,
        allowUnnamedResources: true,
        // Thrown below, with the ARC56 error message
        throwOnFailure: false,
      },
    );

    const failureMessage = simulateResponse.txnGroups[0]?.failureMessage;
    if (failureMessage) {
      throw (
        parseLogicError(
          this.arc56,
          this.appId,
          failureMessage,
          simulateResponse,
          await this.deployedApprovalProgram(),
        ) ?? Error(failureMessage, { cause: simulateResponse })
      );
    }

    return {
      result: { simulateResponse, methodResults },
      returnValue: this.lastReturnValue(
        params.method,
        arc56Method,
        methodResults,
      ) as TReturn,
    };
  }

  /**
   * Call an ARC56 method. The OnComplete defaults to NoOp, and throws if the
   * method does not support it.
   */
  async methodCall<TReturn = unknown>(
    params: AppClientMethodParams,
  ): Promise<MethodCallResult<TReturn>> {
    const { composer, arc56Method } = this.composeMethodCall(params);

    const result = await this.executeWithErrorParsing(composer);

    return {
      result,
      returnValue: this.lastReturnValue(
        params.method,
        arc56Method,
        result.methodResults,
      ) as TReturn,
    };
  }

  static async createMethodCall<TReturn = unknown>(
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
    tempClient.createApprovalProgram = approvalProgram;

    const callParams: AppClientMethodParams = {
      ...methodParams,
      numGlobalByteSlices,
      numGlobalInts,
      numLocalByteSlices,
      numLocalInts,
      approvalProgram,
      clearProgram,
      extraPages:
        methodParams.extraPages ??
        requiredExtraPages(approvalProgram, clearProgram),
    };

    const result = await tempClient.methodCall<TReturn>(callParams);

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

  /**
   * Create an application with a bare (non-ABI) call, for contracts whose
   * `bareActions.create` is non-empty.
   */
  static async bareCreate(
    params: ARC56AppClientBareCreateParams,
  ): Promise<BareCreateResult> {
    const { arc56, algod, getSuggestedParams, ...createParams } = params;
    const clientParams = { arc56, algod, getSuggestedParams };

    const tempClient = new ARC56AppClient({ ...clientParams, appId: 0n });

    const bareCreateActions = tempClient.arc56.bareActions?.create ?? [];
    if (bareCreateActions.length === 0) {
      throw Error(
        `${tempClient.arc56.name} does not support bare creation. Use one of its create methods instead.`,
      );
    }

    const onComplete =
      createParams.onComplete ?? algosdk.OnApplicationComplete.NoOpOC;
    const ocString = ON_COMPLETE_STRINGS[onComplete];
    if (
      ocString === undefined ||
      !(bareCreateActions as readonly string[]).includes(ocString)
    ) {
      throw Error(
        `${ocString ?? onComplete} is not a supported bare create action for ${tempClient.arc56.name}`,
      );
    }

    const approvalProgram =
      createParams.approvalProgram ??
      (await tempClient.compileProgram(
        "approval",
        createParams.templateVariables,
      ));
    const clearProgram =
      createParams.clearProgram ??
      (await tempClient.compileProgram(
        "clear",
        createParams.templateVariables,
      ));
    tempClient.createApprovalProgram = approvalProgram;

    const composer = new Composer({
      getSuggestedParams:
        getSuggestedParams ?? (() => algod.getTransactionParams().do()),
    });
    composer.addAppCreate({
      ...createParams,
      onComplete,
      approvalProgram,
      clearProgram,
      extraPages:
        createParams.extraPages ??
        requiredExtraPages(approvalProgram, clearProgram),
      numGlobalByteSlices:
        createParams.numGlobalByteSlices ??
        tempClient.arc56.state?.schema?.global?.bytes ??
        0,
      numGlobalInts:
        createParams.numGlobalInts ??
        tempClient.arc56.state?.schema?.global?.ints ??
        0,
      numLocalByteSlices:
        createParams.numLocalByteSlices ??
        tempClient.arc56.state?.schema?.local?.bytes ??
        0,
      numLocalInts:
        createParams.numLocalInts ??
        tempClient.arc56.state?.schema?.local?.ints ??
        0,
    });

    const result = await tempClient.executeWithErrorParsing(composer);

    const createTxId = result.txIDs.at(-1);
    if (createTxId === undefined) {
      throw Error("Application creation failed: no transaction ID returned");
    }

    const txInfo = await algod.pendingTransactionInformation(createTxId).do();
    if (txInfo.applicationIndex === undefined) {
      throw Error(
        "Application creation failed: applicationIndex not found in transaction result",
      );
    }

    const appClient = new ARC56AppClient({
      ...clientParams,
      appId: txInfo.applicationIndex,
    });

    return {
      appClient,
      appId: appClient.appId,
      appAddress: appClient.appAddress,
      result: { confirmedRound: result.confirmedRound, txIDs: result.txIDs },
    };
  }

  getState = {
    /**
     * Get all the app's global state, decoded with the ARC56 state keys and
     * maps. Keys that are not set are omitted, and entries that match no ARC56
     * key or map are ignored. An entry whose bytes exactly match an ARC56 key
     * is always decoded as that key, even if it was written as a map entry.
     */
    global: async (): Promise<DecodedState> => {
      return this.decodeState(
        this.rawStateEntries(await this.getRawGlobalState()),
        "global",
      );
    },

    /**
     * Get all of an account's local state for the app, decoded with the ARC56
     * state keys and maps. Keys that are not set are omitted, and entries that
     * match no ARC56 key or map are ignored. An entry whose bytes exactly match
     * an ARC56 key is always decoded as that key, even if it was written as a
     * map entry.
     */
    local: async (
      address: string | algosdk.Address | AddressWithTransactionSigner,
    ): Promise<DecodedState> => {
      return this.decodeState(
        this.rawStateEntries(
          await this.getRawLocalState(this.resolveAddress(address)),
        ),
        "local",
      );
    },

    /**
     * Get all the app's box state, decoded with the ARC56 box keys and maps.
     * Only boxes whose names match an ARC56 box key or map prefix are fetched.
     * Keys that are not set are omitted. A box whose name exactly matches an
     * ARC56 key is always decoded as that key, even if it was written as a map
     * entry.
     */
    box: async (): Promise<DecodedState> => {
      const prefixes = [
        ...Object.values(this.arc56.state?.keys?.box ?? {}).map((k) => k.key),
        ...Object.values(this.arc56.state?.maps?.box ?? {}).map(
          (m) => m.prefix ?? "",
        ),
      ].map((b64) => algosdk.base64ToBytes(b64));

      return this.decodeState(await this.getRawBoxes(prefixes), "box");
    },

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

        const prefixBytes = algosdk.base64ToBytes(mapObject.prefix ?? "");
        const keyBytes = this.getABIEncodedValue(key, mapObject.keyType);
        const encodedKey = new Uint8Array(prefixBytes.length + keyBytes.length);
        encodedKey.set(prefixBytes, 0);
        encodedKey.set(keyBytes, prefixBytes.length);
        const b64Key = algosdk.bytesToBase64(encodedKey);

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
    methodName: algosdk.ABIMethod | string,
    rawValue: Uint8Array,
  ): MethodReturnValue<T> {
    return utilsDecodeMethodReturnValue(this.arc56, methodName, rawValue) as T;
  }
}
