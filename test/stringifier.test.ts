import { describe, it, expect } from "vitest";
import { TokenType, StringRole, type Token } from "../src/tokens.ts";
import {
  OBJECT_START,
  OBJECT_END,
  ARRAY_START,
  ARRAY_END,
  COLON,
  COMMA,
  TRUE,
  FALSE,
  NULL,
  STRING_START_KEY,
  STRING_START_VALUE,
  STRING_END_KEY,
  STRING_END_VALUE,
} from "../src/tokens.ts";
import { stringifyTokens } from "./helpers.ts";

describe("JsonStringifier", () => {
  describe("compact output", () => {
    it("stringifies empty object", async () => {
      expect(await stringifyTokens([OBJECT_START, OBJECT_END])).toBe("{}");
    });

    it("stringifies empty array", async () => {
      expect(await stringifyTokens([ARRAY_START, ARRAY_END])).toBe("[]");
    });

    it("stringifies simple object", async () => {
      const tokens: Token[] = [
        OBJECT_START,
        STRING_START_KEY,
        { type: TokenType.STRING_CHUNK, role: StringRole.KEY, value: "a" },
        STRING_END_KEY,
        COLON,
        { type: TokenType.NUMBER, value: 1 },
        OBJECT_END,
      ];
      expect(await stringifyTokens(tokens)).toBe('{"a":1}');
    });

    it("stringifies array with multiple values", async () => {
      const tokens: Token[] = [
        ARRAY_START,
        { type: TokenType.NUMBER, value: 1 },
        COMMA,
        { type: TokenType.NUMBER, value: 2 },
        COMMA,
        { type: TokenType.NUMBER, value: 3 },
        ARRAY_END,
      ];
      expect(await stringifyTokens(tokens)).toBe("[1,2,3]");
    });

    it("stringifies all primitive types", async () => {
      expect(await stringifyTokens([TRUE])).toBe("true");
      expect(await stringifyTokens([FALSE])).toBe("false");
      expect(await stringifyTokens([NULL])).toBe("null");
      expect(
        await stringifyTokens([{ type: TokenType.NUMBER, value: 42 }]),
      ).toBe("42");
    });

    it("stringifies string with escapes", async () => {
      const tokens: Token[] = [
        STRING_START_VALUE,
        {
          type: TokenType.STRING_CHUNK,
          role: StringRole.VALUE,
          value: 'hello\n"world"',
        },
        STRING_END_VALUE,
      ];
      expect(await stringifyTokens(tokens)).toBe('"hello\\n\\"world\\""');
    });

    it("escapes control characters", async () => {
      const tokens: Token[] = [
        STRING_START_VALUE,
        {
          type: TokenType.STRING_CHUNK,
          role: StringRole.VALUE,
          value: "\x00\x01\x1f",
        },
        STRING_END_VALUE,
      ];
      const result = await stringifyTokens(tokens);
      expect(result).toBe('"\\u0000\\u0001\\u001f"');
    });
  });

  describe("formatted output", () => {
    it("formats with number spaces", async () => {
      const tokens: Token[] = [
        OBJECT_START,
        STRING_START_KEY,
        { type: TokenType.STRING_CHUNK, role: StringRole.KEY, value: "a" },
        STRING_END_KEY,
        COLON,
        { type: TokenType.NUMBER, value: 1 },
        OBJECT_END,
      ];
      const result = await stringifyTokens(tokens, { space: 2 });
      expect(result).toBe('{\n  "a": 1\n}');
    });

    it("formats nested structures", async () => {
      const tokens: Token[] = [
        OBJECT_START,
        STRING_START_KEY,
        { type: TokenType.STRING_CHUNK, role: StringRole.KEY, value: "arr" },
        STRING_END_KEY,
        COLON,
        ARRAY_START,
        { type: TokenType.NUMBER, value: 1 },
        COMMA,
        { type: TokenType.NUMBER, value: 2 },
        ARRAY_END,
        OBJECT_END,
      ];
      const result = await stringifyTokens(tokens, { space: 2 });
      expect(result).toBe('{\n  "arr": [\n    1,\n    2\n  ]\n}');
    });

    it("formats empty containers compactly", async () => {
      expect(
        await stringifyTokens([OBJECT_START, OBJECT_END], { space: 2 }),
      ).toBe("{}");
      expect(
        await stringifyTokens([ARRAY_START, ARRAY_END], { space: 2 }),
      ).toBe("[]");
    });

    it("formats with string space", async () => {
      const tokens: Token[] = [
        ARRAY_START,
        { type: TokenType.NUMBER, value: 1 },
        ARRAY_END,
      ];
      const result = await stringifyTokens(tokens, { space: "\t" });
      expect(result).toBe("[\n\t1\n]");
    });
  });
});
