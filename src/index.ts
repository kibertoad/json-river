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
export { JsonDeserializer, JSON_NULL, type JsonDeserializerOptions } from "./deserializer.ts";
export { JsonArrayItems, type JsonArrayItemsOptions } from "./array-items.ts";
export { JsonPick, type JsonPickOptions, type PickEvent } from "./pick.ts";

import { JSON_NULL } from "./deserializer.ts";
import { JsonParser, type JsonParserOptions } from "./parser.ts";
import { JsonStringifier, type JsonStringifierOptions } from "./stringifier.ts";
import { JsonSerializer, type JsonSerializerOptions } from "./serializer.ts";
import { JsonDeserializer, type JsonDeserializerOptions } from "./deserializer.ts";
import { JsonArrayItems, type JsonArrayItemsOptions } from "./array-items.ts";
import { JsonPick, type JsonPickOptions } from "./pick.ts";

/**
 * Creates a composed Transform: string input → JS value output.
 * Writable side accepts string/Buffer chunks; readable side emits deserialized JS values.
 *
 * Note: root-level `null` values are emitted as the `JSON_NULL` sentinel symbol
 * because Node.js objectMode streams interpret `push(null)` as end-of-stream.
 * Check with `value === JSON_NULL ? null : value`.
 */
export interface ParseOptions extends JsonParserOptions, JsonDeserializerOptions {}

export function parse(options?: ParseOptions): Duplex {
  return compose(new JsonParser(options), new JsonDeserializer(options));
}

export interface StringifyOptions extends JsonStringifierOptions, JsonSerializerOptions {}

/**
 * Creates a composed Transform: JS value input → string output.
 * Writable side accepts JS values (objectMode); readable side emits JSON string chunks.
 */
export function stringify(options?: StringifyOptions): Duplex {
  return compose(new JsonSerializer(options), new JsonStringifier(options));
}

/**
 * Creates a composed Transform: string input → individual array items as JS values.
 *
 * Streams items from a JSON array one at a time, without materializing the
 * entire array in memory. Supports both root-level arrays and arrays nested
 * within an object via the `path` option.
 *
 * ```typescript
 * // Root-level array: [item1, item2, ...]
 * const stream = parseArray()
 *
 * // Named array: {"data": [item1, item2, ...]}
 * const stream = parseArray({ path: 'data' })
 *
 * // Nested: {"results": {"items": [item1, ...]}}
 * const stream = parseArray({ path: 'results.items' })
 * ```
 *
 * Note: root-level `null` items are emitted as the `JSON_NULL` sentinel symbol
 * because Node.js objectMode streams interpret `push(null)` as end-of-stream.
 * Check with `value === JSON_NULL ? null : value`.
 */
export interface ParseArrayOptions extends JsonDeserializerOptions, JsonArrayItemsOptions {}

export function parseArray(options?: ParseArrayOptions): Duplex {
  return compose(new JsonParser(), new JsonArrayItems(options), new JsonDeserializer(options));
}

/**
 * Creates a composed Transform: string input → pick events output.
 *
 * Picks fields out of a JSON object for separate streaming, materializing
 * everything else into a "shell" object.
 *
 * **Inline mode (default):** picked values emitted as encountered, shell
 * emitted last. Zero buffering, zero disk I/O. O(shell + one item) memory.
 *
 * **Shell-first mode (`shellFirst: true | string`):** shell emitted first,
 * then picked values. Uses filesystem offloading — picked tokens are
 * re-stringified to temp files during pass 1, then re-parsed in pass 2.
 * Pass `true` for auto-cleanup via OS tmpdir, or a directory path to
 * retain the files (caller manages cleanup).
 *
 * ```typescript
 * // Inline — values first, shell last
 * const stream = parsePick({ pick: ['data'] })
 *
 * // Shell-first — shell first, then values (auto-cleanup)
 * const stream = parsePick({ pick: ['data'], shellFirst: true })
 *
 * // Shell-first — retain offload files in a custom directory
 * const stream = parsePick({ pick: ['data'], shellFirst: '/tmp/my-offload' })
 * ```
 */
export interface ParsePickOptions extends JsonPickOptions, JsonParserOptions {}

export function parsePick(options: ParsePickOptions): Duplex {
  return compose(new JsonParser(options), new JsonPick(options));
}
