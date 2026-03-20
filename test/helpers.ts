import type { Token } from "../src/tokens.ts";
import { JsonParser, type JsonParserOptions } from "../src/parser.ts";
import {
  JsonStringifier,
  type JsonStringifierOptions,
} from "../src/stringifier.ts";
import { JsonSerializer } from "../src/serializer.ts";
import { JsonDeserializer, JSON_NULL } from "../src/deserializer.ts";

/**
 * Parse a JSON string (or array of string chunks) into tokens.
 */
export function collectTokens(
  input: string | string[],
  options?: JsonParserOptions,
): Promise<Token[]> {
  const parser = new JsonParser(options);
  const tokens: Token[] = [];

  return new Promise((resolve, reject) => {
    parser.on("data", (token: Token) => tokens.push(token));
    parser.on("end", () => resolve(tokens));
    parser.on("error", reject);

    const chunks = typeof input === "string" ? [input] : input;
    for (const chunk of chunks) {
      parser.write(chunk);
    }
    parser.end();
  });
}

/**
 * Parse JSON string(s) all the way to deserialized JS values.
 */
export function parseToValues(
  input: string | string[],
  options?: JsonParserOptions,
): Promise<unknown[]> {
  const parser = new JsonParser(options);
  const deserializer = new JsonDeserializer();
  const values: unknown[] = [];

  return new Promise((resolve, reject) => {
    parser.pipe(deserializer);
    deserializer.on("data", (value: unknown) =>
      values.push(value === JSON_NULL ? null : value),
    );
    deserializer.on("end", () => resolve(values));
    deserializer.on("error", reject);
    parser.on("error", reject);

    const chunks = typeof input === "string" ? [input] : input;
    for (const chunk of chunks) {
      parser.write(chunk);
    }
    parser.end();
  });
}

/**
 * Serialize a JS value through Serializer → Stringifier and return the JSON string.
 */
export function serializeToString(
  value: unknown,
  options?: JsonStringifierOptions,
): Promise<string> {
  const serializer = new JsonSerializer();
  const stringifier = new JsonStringifier(options);
  let result = "";

  return new Promise((resolve, reject) => {
    serializer.pipe(stringifier);
    stringifier.on("data", (chunk: string) => {
      result += chunk;
    });
    stringifier.on("end", () => resolve(result));
    stringifier.on("error", reject);
    serializer.on("error", reject);

    serializer.write(value);
    serializer.end();
  });
}

/**
 * Stringify tokens back to a JSON string.
 */
export function stringifyTokens(
  tokens: Token[],
  options?: JsonStringifierOptions,
): Promise<string> {
  const stringifier = new JsonStringifier(options);
  let result = "";

  return new Promise((resolve, reject) => {
    stringifier.on("data", (chunk: string) => {
      result += chunk;
    });
    stringifier.on("end", () => resolve(result));
    stringifier.on("error", reject);

    for (const token of tokens) {
      stringifier.write(token);
    }
    stringifier.end();
  });
}
