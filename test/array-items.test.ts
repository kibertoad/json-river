import { describe, it, expect } from "vitest";
import { parseArrayItems } from "./helpers.ts";

describe("JsonArrayItems", () => {
  describe("root-level array", () => {
    it("streams items from number array", async () => {
      expect(await parseArrayItems("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("streams items from object array", async () => {
      expect(await parseArrayItems('[{"a":1},{"b":2}]')).toEqual([
        { a: 1 },
        { b: 2 },
      ]);
    });

    it("streams items from string array", async () => {
      expect(await parseArrayItems('["hello","world"]')).toEqual([
        "hello",
        "world",
      ]);
    });

    it("streams items with mixed types", async () => {
      expect(await parseArrayItems('[1,"two",true,null,{},[]]')).toEqual([
        1,
        "two",
        true,
        null,
        {},
        [],
      ]);
    });

    it("handles empty array", async () => {
      expect(await parseArrayItems("[]")).toEqual([]);
    });

    it("handles single item", async () => {
      expect(await parseArrayItems("[42]")).toEqual([42]);
    });

    it("handles nested objects in items", async () => {
      expect(
        await parseArrayItems('[{"a":{"b":[1,2]}},{"c":3}]'),
      ).toEqual([{ a: { b: [1, 2] } }, { c: 3 }]);
    });

    it("handles nested arrays in items", async () => {
      expect(await parseArrayItems("[[1,[2,3]],[4]]")).toEqual([
        [1, [2, 3]],
        [4],
      ]);
    });
  });

  describe("named array (path option)", () => {
    it("streams items from simple path", async () => {
      expect(
        await parseArrayItems('{"data":[1,2,3]}', { path: "data" }),
      ).toEqual([1, 2, 3]);
    });

    it("streams items from object array at path", async () => {
      expect(
        await parseArrayItems('{"data":[{"a":1},{"b":2}]}', { path: "data" }),
      ).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it("handles empty array at path", async () => {
      expect(
        await parseArrayItems('{"data":[]}', { path: "data" }),
      ).toEqual([]);
    });

    it("ignores other keys before target", async () => {
      expect(
        await parseArrayItems('{"other":1,"data":[1,2]}', { path: "data" }),
      ).toEqual([1, 2]);
    });

    it("ignores other keys after target", async () => {
      expect(
        await parseArrayItems('{"data":[1,2],"total":2}', { path: "data" }),
      ).toEqual([1, 2]);
    });

    it("skips complex values for non-matching keys", async () => {
      expect(
        await parseArrayItems(
          '{"meta":{"nested":{"deep":true},"list":[1,2]},"data":[3,4]}',
          { path: "data" },
        ),
      ).toEqual([3, 4]);
    });

    it("skips string values for non-matching keys", async () => {
      expect(
        await parseArrayItems('{"name":"test","data":[1]}', { path: "data" }),
      ).toEqual([1]);
    });

    it("skips boolean values for non-matching keys", async () => {
      expect(
        await parseArrayItems('{"active":true,"data":[1]}', { path: "data" }),
      ).toEqual([1]);
    });

    it("skips null values for non-matching keys", async () => {
      expect(
        await parseArrayItems('{"prev":null,"data":[1]}', { path: "data" }),
      ).toEqual([1]);
    });

    it("skips array values for non-matching keys", async () => {
      expect(
        await parseArrayItems('{"tags":["a","b"],"data":[1]}', {
          path: "data",
        }),
      ).toEqual([1]);
    });
  });

  describe("nested path", () => {
    it("streams items from two-level path", async () => {
      expect(
        await parseArrayItems('{"results":{"items":[1,2,3]}}', {
          path: "results.items",
        }),
      ).toEqual([1, 2, 3]);
    });

    it("streams items from three-level path", async () => {
      expect(
        await parseArrayItems('{"a":{"b":{"c":[10,20]}}}', {
          path: "a.b.c",
        }),
      ).toEqual([10, 20]);
    });

    it("skips non-matching keys at each level", async () => {
      expect(
        await parseArrayItems(
          '{"results":{"count":5,"items":[1,2],"extra":true}}',
          { path: "results.items" },
        ),
      ).toEqual([1, 2]);
    });

    it("skips complex sibling values at nested level", async () => {
      expect(
        await parseArrayItems(
          '{"results":{"other":{"nested":true},"items":[1]}}',
          { path: "results.items" },
        ),
      ).toEqual([1]);
    });
  });

  describe("chunk boundaries", () => {
    it("handles split across chunks (root array)", async () => {
      expect(await parseArrayItems(["[1,", "2,3", "]"])).toEqual([1, 2, 3]);
    });

    it("handles split across chunks (named array)", async () => {
      expect(
        await parseArrayItems(['{"da', 'ta":', "[1,2", "]}"], {
          path: "data",
        }),
      ).toEqual([1, 2]);
    });

    it("handles object items split across chunks", async () => {
      expect(
        await parseArrayItems(['[{"a":', "1},{", '"b":2}]']),
      ).toEqual([{ a: 1 }, { b: 2 }]);
    });
  });

  describe("reviver support", () => {
    it("applies reviver to array items", async () => {
      const reviver = (_key: string, value: unknown) =>
        typeof value === "number" ? value * 2 : value;
      expect(
        await parseArrayItems('[{"n":1},{"n":2}]', { reviver }),
      ).toEqual([{ n: 2 }, { n: 4 }]);
    });
  });

  describe("error handling", () => {
    it("errors when root is object but expected array (no path)", async () => {
      await expect(parseArrayItems('{"a":1}')).rejects.toThrow(
        /Expected array.*got object/,
      );
    });

    it("errors when root is number (no path)", async () => {
      await expect(parseArrayItems("42")).rejects.toThrow(
        /Expected array.*got number/,
      );
    });

    it("errors when root is string (no path)", async () => {
      await expect(parseArrayItems('"hello"')).rejects.toThrow(
        /Expected array.*got string/,
      );
    });

    it("errors when root is boolean (no path)", async () => {
      await expect(parseArrayItems("true")).rejects.toThrow(
        /Expected array.*got boolean/,
      );
    });

    it("errors when root is null (no path)", async () => {
      await expect(parseArrayItems("null")).rejects.toThrow(
        /Expected array.*got null/,
      );
    });

    it("errors when root is array but expected object (with path)", async () => {
      await expect(
        parseArrayItems("[1,2,3]", { path: "data" }),
      ).rejects.toThrow(/Expected object.*got array/);
    });

    it("errors when key not found", async () => {
      await expect(
        parseArrayItems('{"other":1}', { path: "data" }),
      ).rejects.toThrow(/Key "data" not found/);
    });

    it("errors when key not found in empty object", async () => {
      await expect(
        parseArrayItems("{}", { path: "data" }),
      ).rejects.toThrow(/Key "data" not found/);
    });

    it("errors when value at path is not array", async () => {
      await expect(
        parseArrayItems('{"data":42}', { path: "data" }),
      ).rejects.toThrow(/Expected array.*got number/);
    });

    it("errors when value at path is object instead of array", async () => {
      await expect(
        parseArrayItems('{"data":{"nested":true}}', { path: "data" }),
      ).rejects.toThrow(/Expected array.*got object/);
    });

    it("errors when nested key not found", async () => {
      await expect(
        parseArrayItems('{"results":{}}', { path: "results.items" }),
      ).rejects.toThrow(/Key "items" not found/);
    });

    it("errors when intermediate path value is not object", async () => {
      await expect(
        parseArrayItems('{"results":42}', { path: "results.items" }),
      ).rejects.toThrow(/Expected object.*got number/);
    });
  });

  describe("realistic API response patterns", () => {
    it("streams from typical paginated response", async () => {
      const json = JSON.stringify({
        metadata: { page: 1, pageSize: 3, total: 100 },
        data: [
          { id: 1, name: "Alice", email: "alice@example.com" },
          { id: 2, name: "Bob", email: "bob@example.com" },
          { id: 3, name: "Charlie", email: "charlie@example.com" },
        ],
        links: { next: "/api/users?page=2" },
      });

      const items = await parseArrayItems(json, { path: "data" });
      expect(items).toHaveLength(3);
      expect(items[0]).toEqual({
        id: 1,
        name: "Alice",
        email: "alice@example.com",
      });
    });

    it("streams from GeoJSON-like FeatureCollection", async () => {
      const json = JSON.stringify({
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } },
          { type: "Feature", geometry: { type: "Point", coordinates: [1, 1] } },
        ],
      });

      const items = await parseArrayItems(json, { path: "features" });
      expect(items).toHaveLength(2);
      expect((items[0] as { type: string }).type).toBe("Feature");
    });

    it("streams from nested API response", async () => {
      const json = JSON.stringify({
        response: {
          results: [
            { score: 0.95, document: { title: "Result 1" } },
            { score: 0.87, document: { title: "Result 2" } },
          ],
          facets: { category: ["a", "b"] },
        },
      });

      const items = await parseArrayItems(json, {
        path: "response.results",
      });
      expect(items).toHaveLength(2);
    });
  });
});
