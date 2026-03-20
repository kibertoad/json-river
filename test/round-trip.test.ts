import { describe, it, expect } from "vitest";
import {
  collectTokens,
  stringifyTokens,
  parseToValues,
  serializeToString,
} from "./helpers.ts";

describe("round-trip: parse → stringify", () => {
  const testCases: Array<[string, string]> = [
    ["integer", "42"],
    ["negative", "-17"],
    ["float", "3.14"],
    ["exponent", "10000000000"],
    ["string", '"hello"'],
    ["escaped string", '"hello\\nworld"'],
    ["empty string", '""'],
    ["true", "true"],
    ["false", "false"],
    ["null", "null"],
    ["empty object", "{}"],
    ["empty array", "[]"],
    ["simple object", '{"a":1}'],
    ["simple array", "[1,2,3]"],
    ["nested", '{"a":{"b":[1,2]}}'],
    ["complex", '{"arr":[1,null,true,"str",{},[]],"num":-3.14}'],
  ];

  for (const [name, json] of testCases) {
    it(`round-trips: ${name}`, async () => {
      const tokens = await collectTokens(json);
      const result = await stringifyTokens(tokens);
      expect(result).toBe(json);
    });
  }
});

describe("round-trip: serialize → stringify", () => {
  const testCases: Array<[string, unknown]> = [
    ["integer", 42],
    ["negative", -17],
    ["float", 3.14],
    ["string", "hello"],
    ["empty string", ""],
    ["true", true],
    ["false", false],
    ["null", null],
    ["empty object", {}],
    ["empty array", []],
    ["simple object", { a: 1 }],
    ["simple array", [1, 2, 3]],
    ["nested", { a: { b: [1, 2] } }],
    ["mixed array", [1, "two", true, null, {}, []]],
  ];

  for (const [name, value] of testCases) {
    it(`matches JSON.stringify: ${name}`, async () => {
      const result = await serializeToString(value);
      expect(result).toBe(JSON.stringify(value));
    });
  }
});

describe("round-trip: serialize → stringify → parse → deserialize", () => {
  const testCases: Array<[string, unknown]> = [
    ["simple object", { name: "Alice", age: 30 }],
    ["nested", { users: [{ id: 1 }, { id: 2 }] }],
    ["array of mixed", [1, "str", true, null, { key: "val" }]],
    ["deeply nested", { a: { b: { c: { d: { e: "deep" } } } } }],
    ["special chars", { msg: 'hello\n"world"\ttab' }],
  ];

  for (const [name, value] of testCases) {
    it(`full round-trip: ${name}`, async () => {
      const jsonStr = await serializeToString(value);
      const [result] = await parseToValues(jsonStr);
      expect(result).toEqual(value);
    });
  }
});

describe("round-trip: formatted output", () => {
  it("serialize with 2-space indent matches JSON.stringify", async () => {
    const value = { name: "Alice", items: [1, 2, 3], nested: { key: "val" } };
    const result = await serializeToString(value, { space: 2 });
    expect(result).toBe(JSON.stringify(value, null, 2));
  });

  it("serialize with tab indent matches JSON.stringify", async () => {
    const value = [{ a: 1 }, { b: [2, 3] }];
    const result = await serializeToString(value, { space: "\t" });
    expect(result).toBe(JSON.stringify(value, null, "\t"));
  });
});

describe("round-trip: serializer edge cases", () => {
  it("skips undefined values in objects", async () => {
    const result = await serializeToString({ a: 1, b: undefined, c: 3 });
    expect(result).toBe(JSON.stringify({ a: 1, b: undefined, c: 3 }));
  });

  it("converts undefined in arrays to null", async () => {
    const result = await serializeToString([1, undefined, 3]);
    expect(result).toBe(JSON.stringify([1, undefined, 3]));
  });

  it("converts Infinity to null", async () => {
    const result = await serializeToString(Infinity);
    expect(result).toBe("null");
  });

  it("converts NaN to null", async () => {
    const result = await serializeToString(NaN);
    expect(result).toBe("null");
  });

  it("handles toJSON()", async () => {
    const obj = { toJSON: () => ({ serialized: true }) };
    const result = await serializeToString(obj);
    expect(result).toBe(JSON.stringify(obj));
  });
});
