import algosdk from "algosdk";
import type {
  ARC56Contract,
  Method,
  StructField,
  StructFields,
} from "./types/arc56";

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export type StructDef = StructField[] | StructFields | StructField["type"];

export function getABITypeFromStructFields(
  arc56: ARC56Contract,
  structFields: StructDef,
): string {
  const typesArray: string[] = [];

  // Join rather than reformatting a JSON array, so that the square brackets of
  // a sized element type such as `byte[96]` survive
  const pushType = (val: StructDef) => {
    if (typeof val !== "string") {
      typesArray.push(getABITypeFromStructFields(arc56, val));
    } else if (arc56.structs && arc56.structs[val]) {
      typesArray.push(getABIType(arc56, val));
    } else {
      typesArray.push(val);
    }
  };

  if (Array.isArray(structFields)) {
    for (const field of structFields) {
      pushType(field.type);
    }
  } else if (typeof structFields === "object") {
    for (const val of Object.values(structFields)) {
      pushType(val);
    }
  }

  return `(${typesArray.join(",")})`;
}

export function getABIType(arc56: ARC56Contract, type: string): string {
  if (arc56.structs && arc56.structs[type]) {
    return getABITypeFromStructFields(arc56, arc56.structs[type]);
  }

  return type;
}

export function getABIValuesFromStructFieldsAndObject(
  arc56: ARC56Contract,
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
          isRecord(prop)
            ? getABIValuesFromStructFieldsAndObject(arc56, val, prop)
            : (prop as algosdk.ABIValue),
        );
      } else if (
        typeof val === "string" &&
        arc56.structs &&
        arc56.structs[val]
      ) {
        valuesArray.push(
          isRecord(prop)
            ? getABIValuesFromStructFieldsAndObject(
                arc56,
                arc56.structs[val],
                prop,
              )
            : (prop as algosdk.ABIValue),
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
          isRecord(prop)
            ? getABIValuesFromStructFieldsAndObject(arc56, val, prop)
            : (prop as algosdk.ABIValue),
        );
      } else if (
        typeof val === "string" &&
        arc56.structs &&
        arc56.structs[val]
      ) {
        valuesArray.push(
          isRecord(prop)
            ? getABIValuesFromStructFieldsAndObject(
                arc56,
                arc56.structs[val],
                prop,
              )
            : (prop as algosdk.ABIValue),
        );
      } else {
        valuesArray.push(prop as algosdk.ABIValue);
      }
    }
  }

  return valuesArray;
}

export function getABIValue(
  arc56: ARC56Contract,
  type: string,
  value: unknown,
): algosdk.ABIValue {
  if (
    type === "bytes" ||
    type === "AVMBytes" ||
    type === "AVMString" ||
    type === "AVMUint64"
  ) {
    return value as algosdk.ABIValue;
  }
  if (arc56.structs && arc56.structs[type]) {
    if (isRecord(value)) {
      return getABIValuesFromStructFieldsAndObject(
        arc56,
        arc56.structs[type],
        value,
      );
    }
    return value as algosdk.ABIValue;
  }

  return value as algosdk.ABIValue;
}

export function getObjectFromStructFieldsAndArray(
  arc56: ARC56Contract,
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
        obj[key] = getObjectFromStructFieldsAndArray(
          arc56,
          val,
          Array.isArray(nextVal) ? nextVal : [],
        );
      } else if (
        typeof val === "string" &&
        arc56.structs &&
        arc56.structs[val]
      ) {
        obj[key] = getObjectFromStructFieldsAndArray(
          arc56,
          arc56.structs[val],
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
        obj[key] = getObjectFromStructFieldsAndArray(
          arc56,
          val,
          Array.isArray(nextVal) ? nextVal : [],
        );
      } else if (
        typeof val === "string" &&
        arc56.structs &&
        arc56.structs[val]
      ) {
        obj[key] = getObjectFromStructFieldsAndArray(
          arc56,
          arc56.structs[val],
          Array.isArray(nextVal) ? nextVal : [],
        );
      } else {
        obj[key] = nextVal;
      }
    }
  }

  return obj;
}

export function getTypeScriptValue(
  arc56: ARC56Contract,
  type: string,
  value: Uint8Array,
): unknown {
  if (type === "bytes" || type === "AVMString") {
    return new TextDecoder().decode(value);
  }
  if (type === "AVMBytes") {
    return value;
  }
  if (type === "AVMUint64") {
    return algosdk.decodeUint64(value, "bigint");
  }

  const abiType = getABIType(arc56, type);
  const abiValue = algosdk.ABIType.from(abiType).decode(value);

  if (arc56.structs && arc56.structs[type]) {
    return getObjectFromStructFieldsAndArray(
      arc56,
      arc56.structs[type],
      Array.isArray(abiValue) ? abiValue : [abiValue],
    );
  }

  return abiValue;
}

export function decodeMethodReturnValue(
  arc56: ARC56Contract,
  methodName: algosdk.ABIMethod | string,
  rawValue: Uint8Array,
): unknown {
  const { arc56Method: method } = getAbiMethod(arc56, methodName);
  if (method.returns.type === "void" || rawValue.length === 0) {
    return undefined;
  }
  return getTypeScriptValue(
    arc56,
    method.returns.struct ?? method.returns.type,
    rawValue,
  );
}

export function encodeMethodArgs(
  arc56: ARC56Contract,
  arc56Method: Method,
  rawArgs: unknown[],
): algosdk.ABIArgument[] {
  return rawArgs.map((a, i) => {
    if (algosdk.isTransactionWithSigner(a)) {
      return a;
    }

    const argDef = arc56Method.args[i];
    if (!argDef) return a as algosdk.ABIValue;

    return getABIValue(arc56, argDef.struct ?? argDef.type, a);
  });
}

export function getAbiMethod(
  arc56: ARC56Contract,
  method: algosdk.ABIMethod | string,
): { abiMethod: algosdk.ABIMethod; arc56Method: Method } {
  const identifier =
    typeof method === "string" ? method : method.getSignature();
  const isSignature = typeof method !== "string" || identifier.includes("(");
  const name = isSignature ? identifier.split("(")[0] : identifier;
  const candidates = arc56.methods
    .filter((m) => m.name === name)
    .map((arc56Method) => ({
      arc56Method,
      abiMethod: getAbiMethodFromDefinition(arc56, arc56Method),
    }));
  const matches = isSignature
    ? candidates.filter((m) => m.abiMethod.getSignature() === identifier)
    : candidates;

  const match = matches[0];
  if (!match) {
    throw new Error(
      `Method ${identifier} not found in ${arc56.name} ARC56 definition`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Method ${identifier} is ambiguous in ${arc56.name} ARC56 definition; use one of: ${matches.map((m) => m.abiMethod.getSignature()).join(", ")}`,
    );
  }

  return match;
}

export function getAbiMethodFromDefinition(
  arc56: ARC56Contract,
  arc56Method: Method,
): algosdk.ABIMethod {
  try {
    return new algosdk.ABIMethod(arc56Method);
  } catch {
    return new algosdk.ABIMethod({
      name: arc56Method.name,
      desc: arc56Method.desc,
      args: arc56Method.args.map((a) => ({
        name: a.name,
        type: getABIType(arc56, a.struct ?? a.type),
        desc: a.desc,
      })),
      returns: {
        type:
          arc56Method.returns.type === "void"
            ? "void"
            : getABIType(
                arc56,
                arc56Method.returns.struct ?? arc56Method.returns.type,
              ),
        desc: arc56Method.returns.desc,
      },
    });
  }
}

/**
 * The size of the constant blocks at the start of a program. Programs whose
 * source info uses the "cblocks" pcOffsetMethod record pcs relative to the end
 * of these blocks.
 */
function getConstantBlockOffset(program: Uint8Array): number {
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

/**
 * Turn a logic error from algod (when executing or simulating) into an error
 * carrying the ARC56 errorMessage for the failing pc. Returns undefined when
 * the error is from another app or the source info has no message for it.
 *
 * @param appId - The app the contract is deployed as, or 0 when creating it
 * @param message - The text of the error, which includes the pc and app id
 */
export function parseLogicError(
  arc56: ARC56Contract,
  appId: bigint,
  message: string,
  cause?: unknown,
): Error | undefined {
  const txId =
    message.match(/(?:transaction\s+)(\S+?)(?=:|\s)/)?.[1] ??
    message.match(/(?<=transaction\s+)\S+(?=:)/)?.[0];

  const appIdStr =
    message.match(/(?:app=)(\d+)/)?.[1] ??
    message.match(/(?:application\s+\((\d+)\))/)?.[1];
  const errAppId = appIdStr !== undefined ? BigInt(appIdStr) : undefined;

  const pcStr = message.match(/(?:pc=)(\d+)/)?.[1];
  const pc = pcStr !== undefined ? Number(pcStr) : undefined;

  if (appId !== 0n && errAppId !== undefined && errAppId !== appId) {
    return undefined;
  }

  if (pc === undefined || !arc56.sourceInfo) return undefined;

  let errorMessage: string | undefined;
  if (Array.isArray(arc56.sourceInfo)) {
    errorMessage = arc56.sourceInfo.find((s) =>
      s.pc.includes(pc),
    )?.errorMessage;
  } else {
    const approvalInfo = arc56.sourceInfo.approval;
    let targetPc = pc;
    if (approvalInfo.pcOffsetMethod === "cblocks" && arc56.byteCode?.approval) {
      targetPc =
        pc -
        getConstantBlockOffset(algosdk.base64ToBytes(arc56.byteCode.approval));
    }
    errorMessage = approvalInfo.sourceInfo.find((s) =>
      s.pc.includes(targetPc),
    )?.errorMessage;
  }

  if (!errorMessage) return undefined;

  return Error(
    `Runtime error when executing ${arc56.name} (appId: ${errAppId ?? appId}) in transaction ${txId}: ${errorMessage}`,
    { cause },
  );
}
