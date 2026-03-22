import type { Token } from "../src/tokens.ts";
import { JsonParser, type JsonParserOptions } from "../src/parser.ts";
import { JsonStringifier, type JsonStringifierOptions } from "../src/stringifier.ts";
import { JsonSerializer, type JsonSerializerOptions } from "../src/serializer.ts";
import { JsonDeserializer, JSON_NULL, type JsonDeserializerOptions } from "../src/deserializer.ts";
import { JsonArrayItems, type JsonArrayItemsOptions } from "../src/array-items.ts";
import { JsonPick, type JsonPickOptions, type PickEvent } from "../src/pick.ts";

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
  options?: JsonParserOptions & JsonDeserializerOptions,
): Promise<unknown[]> {
  const parser = new JsonParser(options);
  const deserializer = new JsonDeserializer(options);
  const values: unknown[] = [];

  return new Promise((resolve, reject) => {
    parser.pipe(deserializer);
    deserializer.on("data", (value: unknown) => values.push(value === JSON_NULL ? null : value));
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
  options?: JsonStringifierOptions & JsonSerializerOptions,
): Promise<string> {
  const serializer = new JsonSerializer(options);
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
 * Parse JSON string(s) through JsonArrayItems, returning individual array items.
 */
export function parseArrayItems(
  input: string | string[],
  options?: JsonParserOptions & JsonDeserializerOptions & JsonArrayItemsOptions,
): Promise<unknown[]> {
  const parser = new JsonParser(options);
  const arrayItems = new JsonArrayItems(options);
  const deserializer = new JsonDeserializer(options);
  const values: unknown[] = [];

  return new Promise((resolve, reject) => {
    parser.pipe(arrayItems).pipe(deserializer);
    deserializer.on("data", (value: unknown) => values.push(value === JSON_NULL ? null : value));
    deserializer.on("end", () => resolve(values));
    deserializer.on("error", reject);
    arrayItems.on("error", reject);
    parser.on("error", reject);

    const chunks = typeof input === "string" ? [input] : input;
    for (const chunk of chunks) {
      parser.write(chunk);
    }
    parser.end();
  });
}

/**
 * Parse JSON string(s) through JsonPick, returning pick events.
 */
export function pickFields(
  input: string | string[],
  options: JsonPickOptions,
): Promise<PickEvent[]> {
  const parser = new JsonParser();
  const pick = new JsonPick(options);
  const events: PickEvent[] = [];

  return new Promise((resolve, reject) => {
    parser.pipe(pick);
    pick.on("data", (event: PickEvent) => events.push(event));
    pick.on("end", () => resolve(events));
    pick.on("error", reject);
    parser.on("error", reject);

    const chunks = typeof input === "string" ? [input] : input;
    for (const chunk of chunks) {
      parser.write(chunk);
    }
    parser.end();
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
