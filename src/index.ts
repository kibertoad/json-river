// @ts-expect-error compose exists at runtime (Node 22+) but is missing from @types/node
import { compose, type Duplex } from "node:stream";

export { Token, TokenType, StringRole } from "./tokens.ts";
export {
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
} from "./tokens.ts";

export {
  JsonParser,
  UnexpectedCharError,
  PrematureEndError,
  type JsonParserOptions,
} from "./parser.ts";
export { JsonStringifier, type JsonStringifierOptions } from "./stringifier.ts";
export { JsonSerializer, type JsonSerializerOptions } from "./serializer.ts";
export {
  JsonDeserializer,
  JSON_NULL,
  type JsonDeserializerOptions,
} from "./deserializer.ts";

import { JSON_NULL } from "./deserializer.ts";
import { JsonParser, type JsonParserOptions } from "./parser.ts";
import { JsonStringifier, type JsonStringifierOptions } from "./stringifier.ts";
import { JsonSerializer, type JsonSerializerOptions } from "./serializer.ts";
import {
  JsonDeserializer,
  type JsonDeserializerOptions,
} from "./deserializer.ts";

/**
 * Creates a composed Transform: string input → JS value output.
 * Writable side accepts string/Buffer chunks; readable side emits deserialized JS values.
 *
 * Note: root-level `null` values are emitted as the `JSON_NULL` sentinel symbol
 * because Node.js objectMode streams interpret `push(null)` as end-of-stream.
 * Check with `value === JSON_NULL ? null : value`.
 */
export interface ParseOptions
  extends JsonParserOptions,
    JsonDeserializerOptions {}

export function parse(options?: ParseOptions): Duplex {
  return compose(new JsonParser(options), new JsonDeserializer(options));
}

export interface StringifyOptions
  extends JsonStringifierOptions,
    JsonSerializerOptions {}

/**
 * Creates a composed Transform: JS value input → string output.
 * Writable side accepts JS values (objectMode); readable side emits JSON string chunks.
 */
export function stringify(options?: StringifyOptions): Duplex {
  return compose(new JsonSerializer(options), new JsonStringifier(options));
}
