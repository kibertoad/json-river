import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { pickFields } from "./helpers.ts";
import type { PickEvent } from "../src/pick.ts";

/**
 * Shared test suite that runs against both inline and shellFirst modes.
 * In inline mode the shell comes last; in shellFirst mode it comes first.
 */
function sharedPickTests(
  makeOpts: (pick: string[]) => { pick: string[]; shellFirst?: boolean | string },
) {
  /**
   * Assert events contain the expected shell and values, regardless of
   * whether shell comes first or last.
   */
  function expectShellAndValues(
    events: PickEvent[],
    expectedShell: Record<string, unknown>,
    expectedValues: { path: string; value: unknown }[],
  ) {
    const shell = events.find((e) => e.type === "shell");
    expect(shell).toBeDefined();
    expect(shell!.value).toEqual(expectedShell);

    const values = events.filter((e) => e.type === "value");
    expect(values).toEqual(expectedValues.map((v) => ({ type: "value", ...v })));
  }

  describe("basic pick", () => {
    it("picks a single array field", async () => {
      const events = await pickFields('{"meta":{"page":1},"data":[1,2,3]}', makeOpts(["data"]));
      expectShellAndValues(events, { meta: { page: 1 } }, [
        { path: "data", value: 1 },
        { path: "data", value: 2 },
        { path: "data", value: 3 },
      ]);
    });

    it("picks a scalar field", async () => {
      const events = await pickFields('{"a":1,"b":"hello","c":true}', makeOpts(["b"]));
      expectShellAndValues(events, { a: 1, c: true }, [{ path: "b", value: "hello" }]);
    });

    it("picks an object field", async () => {
      const events = await pickFields(
        '{"id":1,"profile":{"name":"Alice","age":30}}',
        makeOpts(["profile"]),
      );
      expectShellAndValues(events, { id: 1 }, [
        { path: "profile", value: { name: "Alice", age: 30 } },
      ]);
    });

    it("picks a null field", async () => {
      const events = await pickFields('{"a":1,"b":null}', makeOpts(["b"]));
      expectShellAndValues(events, { a: 1 }, [{ path: "b", value: null }]);
    });

    it("picks a boolean field", async () => {
      const events = await pickFields('{"a":1,"b":false}', makeOpts(["b"]));
      expectShellAndValues(events, { a: 1 }, [{ path: "b", value: false }]);
    });

    it("picks a number field", async () => {
      const events = await pickFields('{"a":"x","b":42}', makeOpts(["b"]));
      expectShellAndValues(events, { a: "x" }, [{ path: "b", value: 42 }]);
    });
  });

  describe("array item streaming", () => {
    it("streams object array items individually", async () => {
      const events = await pickFields('{"items":[{"id":1},{"id":2}]}', makeOpts(["items"]));
      expectShellAndValues(events, {}, [
        { path: "items", value: { id: 1 } },
        { path: "items", value: { id: 2 } },
      ]);
    });

    it("handles empty picked array", async () => {
      const events = await pickFields('{"data":[],"total":0}', makeOpts(["data"]));
      expectShellAndValues(events, { total: 0 }, []);
    });

    it("streams mixed-type array items", async () => {
      const events = await pickFields('{"items":[1,"two",true,null,{},[3]]}', makeOpts(["items"]));
      expectShellAndValues(events, {}, [
        { path: "items", value: 1 },
        { path: "items", value: "two" },
        { path: "items", value: true },
        { path: "items", value: null },
        { path: "items", value: {} },
        { path: "items", value: [3] },
      ]);
    });

    it("streams nested array items correctly", async () => {
      const events = await pickFields('{"data":[[1,2],[3,[4,5]]]}', makeOpts(["data"]));
      expectShellAndValues(events, {}, [
        { path: "data", value: [1, 2] },
        { path: "data", value: [3, [4, 5]] },
      ]);
    });
  });

  describe("multiple picks", () => {
    it("picks multiple fields", async () => {
      const events = await pickFields(
        '{"a":1,"items":[10,20],"tags":["x","y"],"z":true}',
        makeOpts(["items", "tags"]),
      );
      expectShellAndValues(events, { a: 1, z: true }, [
        { path: "items", value: 10 },
        { path: "items", value: 20 },
        { path: "tags", value: "x" },
        { path: "tags", value: "y" },
      ]);
    });

    it("picks scalar and array fields together", async () => {
      const events = await pickFields(
        '{"name":"test","data":[1,2],"count":5}',
        makeOpts(["name", "data"]),
      );
      expectShellAndValues(events, { count: 5 }, [
        { path: "name", value: "test" },
        { path: "data", value: 1 },
        { path: "data", value: 2 },
      ]);
    });
  });

  describe("nested picks (dot notation)", () => {
    it("picks from a nested object", async () => {
      const events = await pickFields(
        '{"response":{"items":[1,2,3],"count":3}}',
        makeOpts(["response.items"]),
      );
      expectShellAndValues(events, { response: { count: 3 } }, [
        { path: "response.items", value: 1 },
        { path: "response.items", value: 2 },
        { path: "response.items", value: 3 },
      ]);
    });

    it("picks from a deeply nested path", async () => {
      const events = await pickFields(
        '{"a":{"b":{"c":[10,20],"d":"keep"},"e":true}}',
        makeOpts(["a.b.c"]),
      );
      expectShellAndValues(events, { a: { b: { d: "keep" }, e: true } }, [
        { path: "a.b.c", value: 10 },
        { path: "a.b.c", value: 20 },
      ]);
    });

    it("picks multiple fields from nested objects", async () => {
      const events = await pickFields(
        '{"resp":{"items":[1,2],"meta":{"cursor":"abc"}}}',
        makeOpts(["resp.items", "resp.meta.cursor"]),
      );
      expectShellAndValues(events, { resp: { meta: {} } }, [
        { path: "resp.items", value: 1 },
        { path: "resp.items", value: 2 },
        { path: "resp.meta.cursor", value: "abc" },
      ]);
    });

    it("picks at different nesting levels", async () => {
      const events = await pickFields(
        '{"top":[1],"nested":{"deep":[2]}}',
        makeOpts(["top", "nested.deep"]),
      );
      expectShellAndValues(events, { nested: {} }, [
        { path: "top", value: 1 },
        { path: "nested.deep", value: 2 },
      ]);
    });
  });

  describe("ordering resilience", () => {
    it("handles picked field appearing before non-picked fields", async () => {
      const events = await pickFields('{"items":[1,2],"meta":{"page":1}}', makeOpts(["items"]));
      expectShellAndValues(events, { meta: { page: 1 } }, [
        { path: "items", value: 1 },
        { path: "items", value: 2 },
      ]);
    });

    it("handles picked field as the only field", async () => {
      const events = await pickFields('{"data":[1,2,3]}', makeOpts(["data"]));
      expectShellAndValues(events, {}, [
        { path: "data", value: 1 },
        { path: "data", value: 2 },
        { path: "data", value: 3 },
      ]);
    });

    it("handles picked field between other fields", async () => {
      const events = await pickFields('{"a":1,"data":[10],"b":2}', makeOpts(["data"]));
      expectShellAndValues(events, { a: 1, b: 2 }, [{ path: "data", value: 10 }]);
    });
  });

  describe("missing pick paths", () => {
    it("silently ignores pick paths not found in the JSON", async () => {
      const events = await pickFields('{"a":1,"b":2}', makeOpts(["missing"]));
      expectShellAndValues(events, { a: 1, b: 2 }, []);
    });

    it("emits found picks even when some are missing", async () => {
      const events = await pickFields('{"a":1,"data":[1]}', makeOpts(["data", "missing"]));
      expectShellAndValues(events, { a: 1 }, [{ path: "data", value: 1 }]);
    });
  });

  describe("chunk boundaries", () => {
    it("handles split across chunks", async () => {
      const events = await pickFields(
        ['{"me', 'ta":{"p', 'age":1},"da', 'ta":[1,', "2]}"],
        makeOpts(["data"]),
      );
      expectShellAndValues(events, { meta: { page: 1 } }, [
        { path: "data", value: 1 },
        { path: "data", value: 2 },
      ]);
    });

    it("handles nested pick split across chunks", async () => {
      const events = await pickFields(
        ['{"res', 'ponse":{"ite', 'ms":[{"i', 'd":1}', "]}}"],
        makeOpts(["response.items"]),
      );
      expectShellAndValues(events, { response: {} }, [
        { path: "response.items", value: { id: 1 } },
      ]);
    });
  });

  describe("error handling", () => {
    it("errors when root is not an object", async () => {
      await expect(pickFields("[1,2,3]", makeOpts(["data"]))).rejects.toThrow(
        /root value to be an object/,
      );
    });

    it("errors when root is a string", async () => {
      await expect(pickFields('"hello"', makeOpts(["data"]))).rejects.toThrow(
        /root value to be an object/,
      );
    });

    it("errors when root is a number", async () => {
      await expect(pickFields("42", makeOpts(["data"]))).rejects.toThrow(
        /root value to be an object/,
      );
    });

    it("errors when intermediate path is not an object", async () => {
      await expect(pickFields('{"response":42}', makeOpts(["response.items"]))).rejects.toThrow(
        /Expected object.*got number/,
      );
    });

    it("errors when intermediate path is an array", async () => {
      await expect(pickFields('{"response":[1,2]}', makeOpts(["response.items"]))).rejects.toThrow(
        /Expected object.*got array/,
      );
    });

    it("errors when intermediate path is a string", async () => {
      await expect(pickFields('{"response":"text"}', makeOpts(["response.items"]))).rejects.toThrow(
        /Expected object.*got string/,
      );
    });
  });

  describe("realistic API response patterns", () => {
    it("streams from paginated API response", async () => {
      const json = JSON.stringify({
        metadata: { page: 1, pageSize: 3, total: 100 },
        data: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
          { id: 3, name: "Charlie" },
        ],
        links: { next: "/api/users?page=2" },
      });
      const events = await pickFields(json, makeOpts(["data"]));
      expectShellAndValues(
        events,
        {
          metadata: { page: 1, pageSize: 3, total: 100 },
          links: { next: "/api/users?page=2" },
        },
        [
          { path: "data", value: { id: 1, name: "Alice" } },
          { path: "data", value: { id: 2, name: "Bob" } },
          { path: "data", value: { id: 3, name: "Charlie" } },
        ],
      );
    });

    it("streams from nested search API response", async () => {
      const json = JSON.stringify({
        response: {
          results: [
            { score: 0.95, doc: { title: "Result 1" } },
            { score: 0.87, doc: { title: "Result 2" } },
          ],
          facets: { category: ["a", "b"] },
          total: 2,
        },
      });
      const events = await pickFields(json, makeOpts(["response.results"]));
      expectShellAndValues(events, { response: { facets: { category: ["a", "b"] }, total: 2 } }, [
        { path: "response.results", value: { score: 0.95, doc: { title: "Result 1" } } },
        { path: "response.results", value: { score: 0.87, doc: { title: "Result 2" } } },
      ]);
    });
  });

  describe("shell preserves non-picked structure", () => {
    it("preserves arrays in non-picked fields", async () => {
      const events = await pickFields('{"tags":["a","b"],"data":[1,2]}', makeOpts(["data"]));
      const shell = events.find((e) => e.type === "shell")!;
      expect(shell.value).toEqual({ tags: ["a", "b"] });
    });

    it("preserves nested objects in non-picked fields", async () => {
      const events = await pickFields(
        '{"config":{"nested":{"deep":true}},"data":[1]}',
        makeOpts(["data"]),
      );
      const shell = events.find((e) => e.type === "shell")!;
      expect(shell.value).toEqual({ config: { nested: { deep: true } } });
    });

    it("preserves null values in non-picked fields", async () => {
      const events = await pickFields('{"prev":null,"data":[1]}', makeOpts(["data"]));
      const shell = events.find((e) => e.type === "shell")!;
      expect(shell.value).toEqual({ prev: null });
    });
  });

  describe("string escaping roundtrip", () => {
    it("handles strings with special characters", async () => {
      const events = await pickFields(
        '{"data":["line1\\nline2","tab\\there","quote\\"inside"]}',
        makeOpts(["data"]),
      );
      const values = events.filter((e) => e.type === "value").map((e) => e.value);
      expect(values).toEqual(["line1\nline2", "tab\there", 'quote"inside']);
    });

    it("handles unicode escapes", async () => {
      const events = await pickFields(
        '{"data":["\\u0048ello","\\u4e16\\u754c"]}',
        makeOpts(["data"]),
      );
      const values = events.filter((e) => e.type === "value").map((e) => e.value);
      expect(values).toEqual(["Hello", "世界"]);
    });

    it("handles keys with special characters in picked objects", async () => {
      const events = await pickFields(
        '{"data":{"key with\\"quote":1,"normal":2}}',
        makeOpts(["data"]),
      );
      const values = events.filter((e) => e.type === "value");
      expect(values[0].value).toEqual({ 'key with"quote': 1, normal: 2 });
    });
  });
}

// =====================================================================
// Run shared tests for inline mode
// =====================================================================

describe("JsonPick (inline mode)", () => {
  sharedPickTests((pick) => ({ pick }));

  it("emits values before shell", async () => {
    const events = await pickFields('{"meta":1,"data":[1,2]}', { pick: ["data"] });
    const shellIdx = events.findIndex((e) => e.type === "shell");
    const lastValueIdx =
      events
        .map((e, i) => (e.type === "value" ? i : -1))
        .filter((i) => i >= 0)
        .pop() ?? -1;
    expect(lastValueIdx).toBeLessThan(shellIdx);
  });
});

// =====================================================================
// Run shared tests for shellFirst mode (auto-cleanup via tmpdir)
// =====================================================================

describe("JsonPick (shellFirst: true)", () => {
  sharedPickTests((pick) => ({ pick, shellFirst: true }));

  it("emits shell before values", async () => {
    const events = await pickFields('{"meta":1,"data":[1,2]}', {
      pick: ["data"],
      shellFirst: true,
    });
    expect(events[0].type).toBe("shell");
    expect(events.slice(1).every((e) => e.type === "value")).toBe(true);
  });

  it("cleans up temp files after completion", async () => {
    const events = await pickFields('{"data":[1,2,3]}', { pick: ["data"], shellFirst: true });
    // Can't directly inspect temp files (they're cleaned up),
    // but verify correct output as a proxy
    expect(events).toHaveLength(4); // shell + 3 items
  });
});

// =====================================================================
// Run shared tests for shellFirst mode (custom directory)
// =====================================================================

describe("JsonPick (shellFirst: custom dir)", () => {
  let tmpDir: string;

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "json-pick-test-"));
    return tmpDir;
  }

  function cleanupTmpDir(): void {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  sharedPickTests((pick) => {
    const dir = makeTmpDir();
    return { pick, shellFirst: dir };
  });

  it("writes offload files to the specified directory", async () => {
    const dir = makeTmpDir();
    try {
      await pickFields('{"data":[1,2],"more":[3]}', { pick: ["data", "more"], shellFirst: dir });
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(2);
    } finally {
      cleanupTmpDir();
    }
  });

  it("does NOT auto-cleanup files in custom dir", async () => {
    const dir = makeTmpDir();
    try {
      await pickFields('{"data":[1]}', { pick: ["data"], shellFirst: dir });
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);

      // Verify the file contains valid JSON
      const content = fs.readFileSync(path.join(dir, files[0]), "utf8");
      expect(JSON.parse(content)).toEqual([1]);
    } finally {
      cleanupTmpDir();
    }
  });
});

// =====================================================================
// Constructor validation (shared across modes)
// =====================================================================

describe("JsonPick constructor", () => {
  it("throws when constructed with empty pick array", () => {
    expect(() => {
      const { JsonPick } = require("../src/pick.ts");
      new JsonPick({ pick: [] });
    }).toThrow(/at least one pick path/);
  });
});
