import { describe, it, expect } from "vitest";
import { collectTokens, stringifyTokens, parseToValues, serializeToString } from "./helpers.ts";

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

  it("throws on BigInt by default", async () => {
    await expect(serializeToString(42n)).rejects.toThrow(TypeError);
    await expect(serializeToString(42n)).rejects.toThrow("Do not know how to serialize a BigInt");
  });

  it("throws on BigInt in object values by default", async () => {
    await expect(serializeToString({ count: 100n })).rejects.toThrow(TypeError);
  });

  it("throws on BigInt in arrays by default", async () => {
    await expect(serializeToString([1n, 2n, 3n])).rejects.toThrow(TypeError);
  });

  it("converts BigInt to Number with bigint: 'number'", async () => {
    const result = await serializeToString(42n, { bigint: "number" });
    expect(result).toBe("42");
  });

  it("converts BigInt in object values with bigint: 'number'", async () => {
    const result = await serializeToString({ count: 100n }, { bigint: "number" });
    expect(result).toBe('{"count":100}');
  });

  it("converts BigInt in arrays with bigint: 'number'", async () => {
    const result = await serializeToString([1n, 2n, 3n], { bigint: "number" });
    expect(result).toBe("[1,2,3]");
  });

  it("converts large BigInt to Number with precision loss", async () => {
    const big = 2n ** 53n + 1n;
    const result = await serializeToString(big, { bigint: "number" });
    expect(result).toBe(String(Number(big)));
  });
});

describe("serializer: function replacer", () => {
  it("transforms values", async () => {
    const replacer = (key: string, value: unknown) =>
      typeof value === "number" ? value * 2 : value;
    const result = await serializeToString({ a: 1, b: 2 }, { replacer });
    expect(result).toBe(JSON.stringify({ a: 1, b: 2 }, replacer));
  });

  it("omits properties when returning undefined", async () => {
    const replacer = (key: string, value: unknown) => (key === "secret" ? undefined : value);
    const result = await serializeToString({ name: "Alice", secret: "xyz" }, { replacer });
    expect(result).toBe(JSON.stringify({ name: "Alice", secret: "xyz" }, replacer));
  });

  it("converts undefined to null in arrays", async () => {
    const replacer = (key: string, value: unknown) => (value === 2 ? undefined : value);
    const result = await serializeToString([1, 2, 3], { replacer });
    expect(result).toBe(JSON.stringify([1, 2, 3], replacer));
  });

  it("handles nested objects", async () => {
    const replacer = (key: string, value: unknown) => (key === "remove" ? undefined : value);
    const input = { a: { b: 1, remove: 2 }, c: { remove: 3, d: 4 } };
    const result = await serializeToString(input, { replacer });
    expect(result).toBe(JSON.stringify(input, replacer));
  });

  it("receives root value with empty key", async () => {
    const keys: string[] = [];
    const replacer = (key: string, value: unknown) => {
      keys.push(key);
      return value;
    };
    await serializeToString({ a: 1 }, { replacer });
    expect(keys[0]).toBe("");
  });

  it("can replace root value entirely", async () => {
    const replacer = (key: string, value: unknown) => (key === "" ? { replaced: true } : value);
    const result = await serializeToString({ original: true }, { replacer });
    expect(result).toBe(JSON.stringify({ original: true }, replacer));
  });
});

describe("serializer: array replacer", () => {
  it("includes only listed keys", async () => {
    const result = await serializeToString({ a: 1, b: 2, c: 3 }, { replacer: ["a", "c"] });
    expect(result).toBe(JSON.stringify({ a: 1, b: 2, c: 3 }, ["a", "c"]));
  });

  it("does not filter array elements", async () => {
    const result = await serializeToString([1, 2, 3], { replacer: ["0", "2"] });
    expect(result).toBe(JSON.stringify([1, 2, 3]));
  });

  it("handles nested objects", async () => {
    const input = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
    const result = await serializeToString(input, { replacer: ["a", "x"] });
    expect(result).toBe(JSON.stringify(input, ["a", "x"]));
  });

  it("accepts numbers in the array", async () => {
    const result = await serializeToString(
      { "1": "one", "2": "two", "3": "three" },
      { replacer: [1, 3] },
    );
    expect(result).toBe(JSON.stringify({ "1": "one", "2": "two", "3": "three" }, [1, 3]));
  });
});

describe("deserializer: reviver", () => {
  it("transforms values", async () => {
    const reviver = (key: string, value: unknown) =>
      typeof value === "number" ? value * 2 : value;
    const [result] = await parseToValues('{"a":1,"b":2}', { reviver });
    expect(result).toEqual(JSON.parse('{"a":1,"b":2}', reviver));
  });

  it("deletes properties when returning undefined", async () => {
    const reviver = (key: string, value: unknown) => (key === "remove" ? undefined : value);
    const [result] = await parseToValues('{"keep":1,"remove":2}', { reviver });
    expect(result).toEqual(JSON.parse('{"keep":1,"remove":2}', reviver));
  });

  it("transforms array elements", async () => {
    const reviver = (key: string, value: unknown) =>
      typeof value === "number" ? value + 10 : value;
    const [result] = await parseToValues("[1,2,3]", { reviver });
    expect(result).toEqual(JSON.parse("[1,2,3]", reviver));
  });

  it("handles nested objects", async () => {
    const reviver = (key: string, value: unknown) =>
      typeof value === "string" ? value.toUpperCase() : value;
    const input = '{"a":{"b":"hello"},"c":"world"}';
    const [result] = await parseToValues(input, { reviver });
    expect(result).toEqual(JSON.parse(input, reviver));
  });

  it("receives root value with empty key", async () => {
    const keys: string[] = [];
    const reviver = (key: string, value: unknown) => {
      keys.push(key);
      return value;
    };
    await parseToValues('{"a":1}', { reviver });
    expect(keys[keys.length - 1]).toBe("");
  });

  it("can replace root value entirely", async () => {
    const reviver = (key: string, value: unknown) => (key === "" ? "replaced" : value);
    const [result] = await parseToValues('{"a":1}', { reviver });
    expect(result).toBe("replaced");
  });

  it("processes bottom-up (children before parents)", async () => {
    const order: string[] = [];
    const reviver = (key: string, value: unknown) => {
      order.push(key);
      return value;
    };
    await parseToValues('{"a":{"b":1},"c":2}', { reviver });
    expect(order).toEqual(["b", "a", "c", ""]);
  });
});
