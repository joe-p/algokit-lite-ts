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
