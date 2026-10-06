import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { getTypeScriptValue } from "../src/arc56_utils";
import type { ARC56Contract } from "../src/types/arc56";
import arc56Json from "./fixtures/ARC56Test.arc56.json";

describe("getTypeScriptValue", () => {
  const arc56 = arc56Json as unknown as ARC56Contract;
  const values = [0n, 5n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 60n, 2n ** 64n - 1n];

  for (const type of ["AVMUint64", "uint64"]) {
    it.each(values)(`should decode ${type} %s as bigint`, (value) => {
      const decoded = getTypeScriptValue(
        arc56,
        type,
        algosdk.encodeUint64(value),
      );

      expect(typeof decoded).toBe("bigint");
      expect(decoded).toBe(value);
    });
  }
});
