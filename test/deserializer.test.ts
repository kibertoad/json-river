import { describe, it, expect } from "vitest";
import { parseToValues } from "./helpers.ts";

describe("JsonDeserializer", () => {
  describe("simple values", () => {
    it("deserializes number", async () => {
      expect(await parseToValues("42")).toEqual([42]);
    });

    it("deserializes string", async () => {
      expect(await parseToValues('"hello"')).toEqual(["hello"]);
    });

    it("deserializes true", async () => {
      expect(await parseToValues("true")).toEqual([true]);
    });

    it("deserializes false", async () => {
      expect(await parseToValues("false")).toEqual([false]);
    });

    it("deserializes null", async () => {
      expect(await parseToValues("null")).toEqual([null]);
    });
  });

  describe("objects", () => {
    it("deserializes empty object", async () => {
      expect(await parseToValues("{}")).toEqual([{}]);
    });

    it("deserializes simple object", async () => {
      expect(await parseToValues('{"a":1,"b":"two"}')).toEqual([{ a: 1, b: "two" }]);
    });

    it("deserializes nested object", async () => {
      const [result] = await parseToValues('{"outer":{"inner":true}}');
      expect(result).toEqual({ outer: { inner: true } });
    });
  });

  describe("arrays", () => {
    it("deserializes empty array", async () => {
      expect(await parseToValues("[]")).toEqual([[]]);
    });

    it("deserializes simple array", async () => {
      expect(await parseToValues("[1,2,3]")).toEqual([[1, 2, 3]]);
    });

    it("deserializes nested array", async () => {
      expect(await parseToValues("[[1,[2]],3]")).toEqual([[[1, [2]], 3]]);
    });

    it("deserializes mixed array", async () => {
      expect(await parseToValues('[1,"two",true,null,{},[]]')).toEqual([
        [1, "two", true, null, {}, []],
      ]);
    });
  });

  describe("complex structures", () => {
    it("deserializes deeply nested", async () => {
      const [result] = await parseToValues('{"a":{"b":{"c":{"d":[1,2,3]}}}}');
      expect(result).toEqual({ a: { b: { c: { d: [1, 2, 3] } } } });
    });

    it("handles string escapes", async () => {
      const [result] = await parseToValues('{"key":"hello\\nworld"}');
      expect(result).toEqual({ key: "hello\nworld" });
    });

    it("handles unicode escapes", async () => {
      const [result] = await parseToValues('{"emoji":"\\u0041"}');
      expect(result).toEqual({ emoji: "A" });
    });
  });

  describe("multi-document", () => {
    it("deserializes multiple values", async () => {
      const values = await parseToValues('1\n"two"\ntrue', { multi: true });
      expect(values).toEqual([1, "two", true]);
    });

    it("deserializes JSONL", async () => {
      const values = await parseToValues('{"a":1}\n{"b":2}\n{"c":3}', {
        multi: true,
      });
      expect(values).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });
  });

  describe("chunk boundary handling", () => {
    it("handles strings split across chunks", async () => {
      const values = await parseToValues(['{"ke', 'y":"val', 'ue"}']);
      expect(values).toEqual([{ key: "value" }]);
    });

    it("handles values split across chunks", async () => {
      const values = await parseToValues(["[1,", "2,3", "]"]);
      expect(values).toEqual([[1, 2, 3]]);
    });
  });

  describe("JSON.parse equivalence", () => {
    const testCases = [
      "42",
      "-3.14",
      "1e10",
      '"hello"',
      '"hello\\nworld"',
      '""',
      "true",
      "false",
      "null",
      "{}",
      "[]",
      '{"a":1}',
      "[1,2,3]",
      '{"nested":{"arr":[1,null,true,"str"]}}',
      '[{"a":1},{"b":2}]',
      '{"empty_obj":{},"empty_arr":[]}',
    ];

    for (const json of testCases) {
      it(`matches JSON.parse for: ${json.slice(0, 40)}`, async () => {
        const [result] = await parseToValues(json);
        expect(result).toEqual(JSON.parse(json));
      });
    }
  });
});
