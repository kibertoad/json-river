# json-river

Streaming versions of `JSON.parse()` and `JSON.stringify()` built on Node.js Transform streams.

## Streaming vs. native JSON

json-river is not a general-purpose replacement for `JSON.parse()` / `JSON.stringify()`. It is a specialized tool for scenarios where streaming matters. Here is when it helps — and when it doesn't.

### When json-river helps:

- **Processing many JSON documents from a stream.** JSONL log files, event streams, message queues, SSE payloads — any source that delivers multiple JSON values over time. With `JSON.parse()` you must split on boundaries yourself, handle values that span chunk boundaries, and manage backpressure manually. json-river handles all of this natively with `{ multi: true }`.

- **Building streaming pipelines.** When JSON data arrives from a network socket, file, or subprocess and needs to flow through transformations before being written elsewhere, json-river slots into Node.js `pipeline()` naturally. Backpressure propagates automatically — a slow consumer pauses the producer.

- **Reformatting or validating JSON without materializing JS objects.** The `Parser → Stringifier` pipeline converts between compact and pretty-printed JSON at the token level, without ever constructing JavaScript values. This works with any JSON shape — a single massive object, a deeply nested tree, anything. Since no JS objects are created, memory usage stays proportional to the I/O buffer size, not the document size.

- **Streaming items from large JSON arrays.** API responses like `{"data": [item1, item2, ...]}`, GeoJSON FeatureCollections, database exports — any JSON file where the interesting data lives inside an array. With `JSON.parse()` the entire array must be materialized before you can process the first item. `parseArray({ path: 'data' })` streams items one at a time — the wrapping object and array are never built, so memory stays bounded regardless of array length.

- **Streaming items while keeping the envelope metadata.** When an API response has both metadata (`total`, `cursor`, pagination links) and a large data array, you often need both — but can't afford to materialize the entire array. `parsePick({ pick: ['data'] })` streams array items individually while separately emitting the "shell" object (everything except the picked fields). Memory stays O(shell + one item) regardless of array size.

- **Controlling memory usage in long-running services.** Servers that accept JSON uploads or process queued JSON payloads benefit from bounded memory. When processing streams of many small documents (JSONL, arrays of records), each document is deserialized, consumed, and discarded individually — only one document lives in memory at a time.

### When json-river doesn't help:

- **Your JSON is small and already fully buffered in a string.** `JSON.parse()` and `JSON.stringify()` are implemented in C++ inside V8 and are significantly faster than any JavaScript-based streaming parser. For a config file, an API response, or any payload you already have as a string, native JSON is the right choice. See the [size guidelines](#rough-size-guidelines) below for when to start considering streaming.

- **You need the entire parsed object anyway.** If you pipe through the `Deserializer`, it reconstructs the full JS object in memory — and actually uses *more* memory than `JSON.parse()`, not less. V8's native JSON parser uses an optimized C++ single-pass path that produces compact object representations. The streaming Deserializer builds objects incrementally with many intermediate allocations (see [benchmarks](#memory-benchmarks)). Streaming saves memory only when you can process and discard documents *individually* (JSONL, `JsonArrayItems`, `JsonPick`, iterating array items) or when you stay at the token level (`Parser → Stringifier`).

- **You're in a browser or need Web Streams (WHATWG).** json-river is built on Node.js Transform streams. For browser environments, consider [json-stream-es](https://github.com/cdauth/json-stream-es) which uses the WHATWG Streams API.

- **Throughput is the only concern.** On a per-operation basis, `JSON.parse()` / `JSON.stringify()` will always be faster than a streaming parser for data that is already buffered. Streaming wins on *memory*, not *CPU time*.

### Rough size guidelines

These are rules of thumb, not hard cutoffs — actual impact depends on concurrency, available heap, and whether you need the full parsed object:

| Document size | Recommendation |
|---|---|
| Under 5 MB | Parsing all at once is usually simplest and totally fine. |
| 5–10 MB | Still usually fine to parse whole, unless you do this frequently or concurrently. |
| 10–100 MB | Streaming is often the safer default. |
| 100 MB+ | Stream unless you specifically need the full structure in memory. |

## Features

- **Streaming parser** — parse JSON incrementally without loading the entire document into memory
- **Streaming stringifier** — convert token streams back to JSON text with optional formatting
- **Streaming serializer** — convert JS values into token streams
- **Streaming deserializer** — reconstruct JS values from token streams
- **Array item streaming** — stream items from JSON arrays (root-level or nested) one at a time via `parseArray()`
- **Pick streaming** — stream selected fields from JSON objects while materializing the rest as a "shell" via `parsePick()`, with optional shell-first ordering via filesystem offloading
- **JSONL / multi-document support** — parse newline-delimited JSON streams
- **Backpressure** — native Node.js stream backpressure throughout the pipeline
- **Memory-efficient** — explicit stack (not linked-list state), eager string flushing at chunk boundaries, frozen singleton tokens
- **Zero runtime dependencies**

## Install

```bash
npm install json-river
```

Requires Node.js >= 22.0.0.

## Quick Start

### Parse a JSON stream

```typescript
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { JsonParser, JsonDeserializer } from 'json-river'

const parser = new JsonParser()
const deserializer = new JsonDeserializer()

deserializer.on('data', (value) => {
  console.log('Parsed value:', value)
})

await pipeline(
  createReadStream('data.json'),
  parser,
  deserializer
)
```

### Parse JSONL (newline-delimited JSON)

```typescript
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { JsonParser, JsonDeserializer } from 'json-river'

const parser = new JsonParser({ multi: true })
const deserializer = new JsonDeserializer()

deserializer.on('data', (value) => {
  console.log('Document:', value)
})

await pipeline(
  createReadStream('data.ndjson'),
  parser,
  deserializer
)
```

### Stream items from a JSON array

Many JSON files contain a single large array — a database export, a log dump, a bulk API response. With `JSON.parse()` the entire array must live in memory at once. `parseArray()` streams items one at a time, so only one item is ever in memory:

```typescript
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { parseArray } from 'json-river'

// data.json contains: [{"id": 1, ...}, {"id": 2, ...}, ...]
const stream = parseArray()

await pipeline(
  createReadStream('data.json'),
  stream,
  async function* (source) {
    for await (const item of source) {
      await processItem(item) // each item individually, then GC'd
    }
  }
)
```

When the array is nested inside an object, use the `path` option to point at it. The wrapping object is consumed without being materialized — only individual items are emitted:

```typescript
// response.json contains:
// {
//   "metadata": {"page": 1, "total": 50000},
//   "data": [{"id": 1, ...}, {"id": 2, ...}, ...],
//   "links": {"next": "/api/items?page=2"}
// }

const stream = parseArray({ path: 'data' })

await pipeline(
  createReadStream('response.json'),
  stream,
  async function* (source) {
    for await (const item of source) {
      await processItem(item)
    }
  }
)

// Paths can be nested with dot notation:
// {"results": {"items": [...]}} → path: 'results.items'
// {"a": {"b": {"c": [...]}}}   → path: 'a.b.c'
```

For full control over the pipeline, compose the individual transforms:

```typescript
import { JsonParser, JsonArrayItems, JsonDeserializer } from 'json-river'

await pipeline(
  createReadStream('response.json'),
  new JsonParser(),
  new JsonArrayItems({ path: 'data' }),
  new JsonDeserializer(),
  async function* (source) {
    for await (const item of source) {
      await db.insert(item)
    }
  }
)
```

### Pick fields from a JSON object

When a JSON object has both metadata and a large data array, `parseArray()` discards the envelope — you only get the array items. `parsePick()` gives you both: the "shell" (everything except the picked fields) and each picked array item streamed individually.

```typescript
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { parsePick } from 'json-river'

// response.json contains:
// {
//   "metadata": {"page": 1, "total": 50000},
//   "data": [{"id": 1, ...}, {"id": 2, ...}, ...],
//   "links": {"next": "/api/items?page=2"}
// }

const stream = parsePick({ pick: ['data'] })

await pipeline(
  createReadStream('response.json'),
  stream,
  async function* (source) {
    for await (const event of source) {
      if (event.type === 'shell') {
        console.log('Metadata:', event.value.metadata)
        console.log('Links:', event.value.links)
      } else {
        // event.type === 'value', event.path === 'data'
        await db.insert(event.value)
      }
    }
  }
)
```

**Pick supports dot-notation** for nested fields and multiple picks:

```typescript
// Pick multiple fields, including nested ones
const stream = parsePick({
  pick: ['response.results', 'response.facets'],
})
// Shell: { response: { total: 2 } }
// Values: each item from response.results, then response.facets
```

**Shell-first mode:** By default, picked values are emitted inline as encountered and the shell comes last. If you need the shell metadata *before* processing items, enable filesystem offloading:

```typescript
// Shell emitted first — picked tokens are offloaded to temp files
// and re-parsed after the shell is built
const stream = parsePick({ pick: ['data'], shellFirst: true })

// Or offload to a specific directory (files are NOT auto-cleaned):
const stream = parsePick({ pick: ['data'], shellFirst: '/tmp/offload' })
```

| `shellFirst` | Shell order | Disk I/O | Cleanup | Memory |
|---|---|---|---|---|
| `false` (default) | Last | None | N/A | O(shell + one item) |
| `true` | First | OS tmpdir | Automatic | O(shell + one item) |
| `"/path"` | First | Custom dir | Caller owns files | O(shell + one item) |

### Stringify JS values to JSON

```typescript
import { pipeline } from 'node:stream/promises'
import { JsonSerializer, JsonStringifier } from 'json-river'

const serializer = new JsonSerializer()
const stringifier = new JsonStringifier({ space: 2 })

const p = pipeline(serializer, stringifier, process.stdout)

serializer.write({ name: 'Alice', age: 30 })
serializer.write({ name: 'Bob', age: 25 })
serializer.end()

await p
```

### Reformat JSON without parsing to JS values

```typescript
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { JsonParser, JsonStringifier } from 'json-river'

// Reformat compact JSON to pretty-printed — no JS objects are ever created
await pipeline(
  createReadStream('compact.json'),
  new JsonParser(),
  new JsonStringifier({ space: 2 }),
  createWriteStream('pretty.json')
)
```

### Convenience functions

```typescript
import { parse, parseArray, parsePick, stringify } from 'json-river'

// parse() returns a Duplex: write strings, read JS values
const parser = parse({ multi: true })
parser.write('{"a":1}\n{"b":2}\n')
parser.end()

for await (const value of parser) {
  console.log(value) // {a: 1}, then {b: 2}
}

// parseArray() returns a Duplex: write strings, read individual array items
const arrayStream = parseArray({ path: 'data' })
arrayStream.end('{"data": [1, 2, 3]}')

for await (const item of arrayStream) {
  console.log(item) // 1, then 2, then 3
}

// parsePick() returns a Duplex: write strings, read pick events
const pickStream = parsePick({ pick: ['data'] })
pickStream.end('{"meta": 1, "data": [1, 2, 3]}')

for await (const event of pickStream) {
  console.log(event)
  // { type: 'value', path: 'data', value: 1 }
  // { type: 'value', path: 'data', value: 2 }
  // { type: 'value', path: 'data', value: 3 }
  // { type: 'shell', value: { meta: 1 } }
}

// stringify() returns a Duplex: write JS values, read JSON strings
const stringifier = stringify({ space: 2 })
stringifier.write({ hello: 'world' })
stringifier.end()

for await (const chunk of stringifier) {
  process.stdout.write(chunk)
}
```

## Architecture

json-river processes JSON through a four-stage token pipeline:

```
                  Parser                     Stringifier
String chunks ──────────> Token stream ──────────────────> String chunks

                  Serializer                 Deserializer
JS values     ──────────> Token stream ──────────────────> JS values
```

**Tokens** are the intermediate representation — lightweight discriminated-union objects representing JSON structural elements (object start/end, array start/end, string chunks, numbers, booleans, null, colons, commas).

Each stage is an independent Node.js Transform stream. Compose them freely:

| Pipeline | Use case |
|---|---|
| `Parser → Deserializer` | Parse JSON text to JS values |
| `Serializer → Stringifier` | Stringify JS values to JSON text |
| `Parser → Stringifier` | Reformat / validate JSON without materializing JS objects |
| `Parser → ArrayItems → Deserializer` | Stream individual items from a JSON array |
| `Parser → Pick` | Stream selected fields + shell from a JSON object |
| `Parser → custom Transform → Stringifier` | Token-level transformations (filter keys, redact values) |

## API Reference

### `JsonParser`

Transform stream: `string | Buffer` → `Token`

```typescript
import { JsonParser } from 'json-river'

const parser = new JsonParser(options?)
```

**Options:**
- `multi?: boolean` — Allow multiple root-level JSON values (JSONL / JSON-seq). Default: `false`.

**Input:** String or Buffer chunks containing JSON text.
**Output:** Token objects in `readableObjectMode`.

The parser handles:
- Arbitrary chunk boundaries (strings, numbers, keywords can span chunks)
- UTF-8 multi-byte characters across chunk boundaries (via `StringDecoder`)
- All JSON escape sequences including `\uXXXX`
- Strict JSON validation (rejects trailing commas, leading zeros, etc.)

**Errors:**
- `UnexpectedCharError` — invalid character at a given position
- `PrematureEndError` — input ended mid-value

Errors are emitted as `'error'` events on the parser stream. In a `pipeline()`, they automatically propagate and reject the returned promise:

```typescript
try {
  await pipeline(
    createReadStream('data.json'),
    new JsonParser(),
    new JsonDeserializer(),
    new Writable({ objectMode: true, write(chunk, _enc, cb) { cb() } })
  )
} catch (err) {
  if (err instanceof UnexpectedCharError) {
    console.error(`Invalid JSON at position ${err.position}: ${err.message}`)
  }
}
```

### `JsonStringifier`

Transform stream: `Token` → `string`

```typescript
import { JsonStringifier } from 'json-river'

const stringifier = new JsonStringifier(options?)
```

**Options:**
- `space?: string | number` — Indentation, like `JSON.stringify`'s third argument. Default: none (compact output).

**Input:** Token objects in `writableObjectMode`.
**Output:** JSON string chunks.

### `JsonSerializer`

Transform stream: JS values → `Token`

```typescript
import { JsonSerializer } from 'json-river'

const serializer = new JsonSerializer(options?)
```

**Options:**
- `bigint?: "error" | "number"` — How to handle `BigInt` values. Default: `"error"`.
  - `"error"` — throw a `TypeError`, matching `JSON.stringify` behavior.
  - `"number"` — convert to `Number` via `Number(value)`. Values beyond `Number.MAX_SAFE_INTEGER` will lose precision silently.
- `replacer?: ((key: string, value: unknown) => unknown) | (string | number)[]` — Matches `JSON.stringify`'s second argument.
  - **Function** — called for every value (including the root with key `""`). Return `undefined` to omit a property from objects; in arrays, `undefined` becomes `null`.
  - **Array** — only these object keys are included. Array elements are unaffected.

Converts JavaScript values into token streams. Follows `JSON.stringify` semantics:
- `undefined` and functions in object values are skipped
- `undefined` and functions in arrays become `null`
- `Infinity`, `NaN` become `null`
- `toJSON()` is called if present
- `BigInt` throws `TypeError` by default (matching `JSON.stringify`). Use `{ bigint: "number" }` to convert instead.

**Input:** JS values in `writableObjectMode`.
**Output:** Token objects in `readableObjectMode`.

### `JsonDeserializer`

Transform stream: `Token` → JS values

```typescript
import { JsonDeserializer, JSON_NULL } from 'json-river'

const deserializer = new JsonDeserializer(options?)

deserializer.on('data', (value) => {
  // value === JSON_NULL means the JSON document was literally `null`
  const actual = value === JSON_NULL ? null : value
})
```

**Options:**
- `reviver?: (key: string, value: unknown) => unknown` — Matches `JSON.parse`'s second argument. Called for every key/value pair, innermost first (bottom-up). Return the value to keep, or `undefined` to delete the property from its parent object.

Reconstructs JavaScript values from token streams. Emits one value per root-level JSON document.

> **Note:** Node.js objectMode streams interpret `push(null)` as end-of-stream. Root-level `null` JSON values are emitted as the `JSON_NULL` sentinel symbol. Check with `value === JSON_NULL ? null : value`.

### `JsonArrayItems`

Transform stream: `Token` → `Token`

Sits between `JsonParser` and `JsonDeserializer` in a pipeline. Consumes the tokens for the wrapping structure (the array delimiters and any enclosing object), and re-emits only the tokens belonging to each array item. To the downstream `JsonDeserializer`, each item looks like an independent root-level value, so items are deserialized and emitted one at a time instead of being accumulated into a single array.

```typescript
import { JsonArrayItems } from 'json-river'

const arrayItems = new JsonArrayItems(options?)
```

**Options:**
- `path?: string` — Dot-separated path to the target array. Default: `undefined` (root must be an array).

| `path` value | Expected JSON shape |
|---|---|
| `undefined` | `[item, item, ...]` |
| `"data"` | `{"data": [item, item, ...]}` |
| `"results.items"` | `{"results": {"items": [item, item, ...]}}` |

Non-matching keys at each level of the path are skipped automatically — the object can contain any number of other properties before or after the target array.

**Errors:**
- If the value at the path is not an array (e.g. a number or object), an error is emitted
- If a key in the path is not found in its parent object, an error is emitted
- If the JSON structure doesn't match the expected shape (e.g. root is an object when no path is given), an error is emitted

### `JsonPick`

Transform stream: `Token` → `PickEvent`

Sits after `JsonParser` in a pipeline. Splits a JSON object into a "shell" (all non-picked fields) and individually streamed picked values. If a picked value is an array, each item is emitted as a separate event.

```typescript
import { JsonPick } from 'json-river'

const pick = new JsonPick(options)
```

**Options:**
- `pick: string[]` — Dot-separated paths to fields to stream separately. Required, at least one.
- `shellFirst?: boolean | string` — Controls emission order and offloading:
  - `false` (default) — picked values emitted inline, shell emitted last. No disk I/O.
  - `true` — shell emitted first. Picked tokens are offloaded to temp files in the OS tmpdir and auto-cleaned.
  - `string` — shell emitted first. Picked tokens are offloaded to files in the given directory. Files are **not** auto-cleaned — the caller owns the directory.

**Output events (`PickEvent`):**
- `{ type: "shell", value: Record<string, unknown> }` — the object with picked fields omitted
- `{ type: "value", path: string, value: unknown }` — one per picked value (or one per array item if the picked value is an array)

**Dot-notation** navigates into nested objects:

| `pick` value | Picked from |
|---|---|
| `["data"]` | Root-level `data` field |
| `["response.items"]` | `items` inside the `response` object |
| `["data", "meta.cursor"]` | Multiple fields at different depths |

Intermediate objects on the pick path remain in the shell with the picked key removed. For example, picking `["response.items"]` from `{"response": {"items": [...], "count": 5}}` produces a shell of `{"response": {"count": 5}}`.

**Memory:** O(shell + max single picked item) in all modes. The shell-first mode additionally uses O(picked data) on disk.

### `parsePick(options)`

Convenience: creates a composed `Duplex` stream equivalent to `Parser → Pick`. Write JSON text in, read `PickEvent` objects out.

```typescript
import { parsePick } from 'json-river'

const stream = parsePick({ pick: ['data'], shellFirst: true })
```

Accepts all `JsonPick` and `JsonParser` options (`pick`, `shellFirst`).

### `parse(options?)`

Convenience: creates a composed `Duplex` stream equivalent to `Parser → Deserializer`.

```typescript
import { parse } from 'json-river'

const stream = parse({ multi: true })
```

Accepts all `JsonParser` and `JsonDeserializer` options (`multi`, `reviver`).

### `parseArray(options?)`

Convenience: creates a composed `Duplex` stream equivalent to `Parser → ArrayItems → Deserializer`. Write JSON text in, read individual array items out as JS values.

```typescript
import { parseArray } from 'json-river'

const stream = parseArray({ path: 'data' })
stream.end('{"data": [1, 2, 3]}')

for await (const item of stream) {
  console.log(item) // 1, then 2, then 3
}
```

**Options:**
- `path?: string` — Passed to `JsonArrayItems`. Dot-separated path to the target array.
- `reviver?: (key: string, value: unknown) => unknown` — Passed to `JsonDeserializer`. Applied to each item independently.

### `stringify(options?)`

Convenience: creates a composed `Duplex` stream equivalent to `Serializer → Stringifier`.

```typescript
import { stringify } from 'json-river'

const stream = stringify({ space: 2 })
```

Accepts all `JsonSerializer` and `JsonStringifier` options (`space`, `replacer`, `bigint`).

### Token Types

```typescript
import { TokenType, StringRole, type Token } from 'json-river'

TokenType.OBJECT_START   // '{'
TokenType.OBJECT_END     // '}'
TokenType.ARRAY_START    // '['
TokenType.ARRAY_END      // ']'
TokenType.STRING_START   // opening quote (has `role: StringRole.KEY | StringRole.VALUE`)
TokenType.STRING_CHUNK   // string content (has `role` and `value: string`)
TokenType.STRING_END     // closing quote (has `role`)
TokenType.NUMBER         // number (has `value: number`)
TokenType.TRUE           // true
TokenType.FALSE          // false
TokenType.NULL           // null
TokenType.COLON          // ':'
TokenType.COMMA          // ','
```

**Singleton tokens** are pre-allocated frozen objects for structural tokens that carry no data:

```typescript
import {
  OBJECT_START, OBJECT_END,
  ARRAY_START, ARRAY_END,
  COLON, COMMA,
  TRUE, FALSE, NULL,
  STRING_START_KEY, STRING_START_VALUE,
  STRING_END_KEY, STRING_END_VALUE,
} from 'json-river'
```

## Design Decisions

### vs. native `JSON.parse()` / `JSON.stringify()`

Native JSON methods are implemented in V8's C++ layer and will always be faster for data that fits in memory. json-river's advantage is *memory*, not *throughput*:

| Scenario | Native JSON | json-river |
|---|---|---|
| Config file / API response | Best choice — fast, simple | Unnecessary overhead |
| JSONL log file (many small docs) | Must load file, split lines, handle boundaries | Streams doc by doc with backpressure |
| Single large object, need it all in memory | `JSON.parse()` — fast, compact in V8's C++ path | **Worse** — `Deserializer` builds incrementally with more allocations (see [benchmarks](#memory-benchmarks)) |
| Large array (root or nested in object) | `JSON.parse()` materializes entire array + wrapper | `ArrayItems` streams items one at a time — bounded memory |
| Large array + need envelope metadata | `JSON.parse()` materializes everything | `JsonPick` streams items while emitting the shell separately |
| Single large object, reformatting only | Parse to JS, then re-stringify — 2x memory | Token-level pipeline — no JS objects created |
| Stream of JSON from network/subprocess | Buffer everything, then parse | Process incrementally as data arrives |

### vs. json-stream-es

json-river was designed with lessons learned from [json-stream-es](https://github.com/cdauth/json-stream-es):

| Concern | json-stream-es | json-river |
|---|---|---|
| Stream API | Web Streams (WHATWG) | Node.js Transform streams |
| Backpressure | Web Streams built-in | Node.js built-in |
| Parser state | Linked-list parent states | Explicit stack array |
| String buffering | Accumulates in state object | Eager flush at chunk boundaries |
| Token allocation | New object per token | Frozen singletons for structural tokens |
| Number format | Preserves raw format via `rawValue` | Stores parsed `Number` (no `rawValue`) |
| UTF-8 handling | N/A (Web Streams use strings) | `StringDecoder` for chunk boundary safety |

Choose json-stream-es if you need Web Streams compatibility (browsers, Deno, Cloudflare Workers). Choose json-river if you're on Node.js and want native stream integration.

### Memory efficiency

- **Explicit stack array** — The parser uses a flat `number[]` stack instead of linked parent state objects. This gives the GC a clear picture and avoids long reference chains.
- **Eager string flushing** — At each input chunk boundary, accumulated string content is emitted as a `STRING_CHUNK` token and the buffer is cleared. This bounds memory usage for large string values.
- **Frozen singleton tokens** — Structural tokens (`{`, `}`, `[`, `]`, `:`, `,`, `true`, `false`, `null`, string start/end) are pre-allocated and frozen. Zero allocation per structural token.
- **CharCode-based parsing** — The parser uses numeric char code comparisons instead of string comparisons for the hot path.

## Scripts

```bash
# Run unit tests
npm test

# Run memory leak tests (requires --expose-gc)
npm run test:memory

# Run performance benchmarks (vs. native JSON and json-stream-es)
npm run bench

# Generate test data for memory profiling
npm run generate-data [small|medium|large|xlarge]

# Run memory profiler (HTTP service + collector)
npm run profile [small|medium|large|xlarge]

# Start memory profiler server standalone
npm run profile:server

# Generate comparison chart (requires profile:server running)
npm run profile:chart -- <filePath> [--multi] [--path=data] [--approaches=a,b] [--output=results]
```

## Memory Profiler

The `bench/memory-profiler/` directory contains a comprehensive memory analysis tool:

### Data Generator

```bash
node bench/memory-profiler/generate-json.ts [preset] [outputDir]
```

Generates five types of test files per preset:
- **JSONL** — many small objects (newline-delimited)
- **Large object** — single object with many keys
- **Large strings** — objects with large string values
- **Deep nesting** — deeply nested array structures
- **Named array** — API response pattern: `{"metadata": {...}, "data": [...], "total": N}`

Presets: `small` (~1 MB), `medium` (~10 MB), `large` (~50 MB), `xlarge` (~200 MB).

### HTTP Profiler Server

```bash
node --expose-gc bench/memory-profiler/server.ts [port]
```

Runs JSON processing workloads in-process and streams memory samples as NDJSON:

```bash
curl -X POST http://localhost:3847/profile \
  -H "Content-Type: application/json" \
  -d '{"approach":"json-river-parse","filePath":".test-data/medium-jsonl.ndjson","multi":true}'
```

Each response line is a memory sample `{ timestamp, heapUsed, heapTotal, rss, external }`, with a final summary line containing peak/baseline/delta statistics.

**Available approaches:**
- `native-json-parse` — `JSON.parse()` (reads entire file into memory)
- `native-json-stringify` — `JSON.parse()` + `JSON.stringify()` per document
- `native-json-parse-iterate` — `JSON.parse()` + iterate array items (for named-array comparison)
- `json-river-parse-inefficient-baseline` — `JsonParser → JsonDeserializer` (full streaming deserialization — **baseline/testing only**, uses more memory than native `JSON.parse()`)
- `json-river-parse-stringify` — `JsonParser → JsonDeserializer → JsonSerializer → JsonStringifier`
- `json-river-reformat` — `JsonParser → JsonStringifier` (tokens only, no JS values materialized)
- `json-river-pick-skip-shell` — `JsonParser → JsonArrayItems → JsonDeserializer` (stream items, discard envelope)
- `json-river-pick-shell-last` — `JsonParser → JsonPick` (stream items + shell emitted last)
- `json-river-pick-shell-first` — `JsonParser → JsonPick({ shellFirst: true })` (shell first, dual pass via disk)
- `json-stream-es-parse` — `JseParser → JseDeserializer` (Web Streams)
- `json-stream-es-reformat` — `JseParser → JseStringifier` (Web Streams)

### Profile Runner

```bash
node bench/memory-profiler/run-profile.ts [preset]
```

Automatically starts the profiler server, runs all approaches against all test files for the given preset, and produces:
- `summary.json` — consolidated peak/baseline/delta per run
- `chart-data.json` — time-series `{ t, heapUsedMB, rssMB }` per run (ready for charting)
- `report.txt` — human-readable comparison table
- `samples/` — raw NDJSON per run

### Chart Generator

```bash
# Start the server in one terminal:
node --expose-gc bench/memory-profiler/server.ts

# In another terminal, generate a chart:
node bench/memory-profiler/chart.ts .test-data/large-jsonl.ndjson --multi --output=results

# Chart for named-array (API response pattern) — compare pick modes:
node bench/memory-profiler/chart.ts .test-data/large-named-array.json --path=data --approaches=native-json-parse,json-river-parse-inefficient-baseline,json-river-pick-skip-shell,json-river-pick-shell-last,json-river-pick-shell-first --output=results
```

Connects to the profiler server, runs every registered approach against the given file, and writes results into the output directory:
- `chart.html` — self-contained HTML comparison chart (heap usage over time)
- `summary.json` — peak/baseline/delta per approach
- `chart-data.json` — time-series data for external charting tools
- `samples/` — raw NDJSON per approach

## Memory Benchmarks

Measured on a 45.5 MB named-array file (`{"metadata": {...}, "data": [50,000 items], "total": N}`) using the memory profiler:

| Approach | What you get | Peak Heap | Delta | Time |
|---|---|---|---|---|
| `native-json-parse` | Full object via `JSON.parse()` | 148 MB | 137 MB | 218 ms |
| `json-river-parse-inefficient-baseline` | Full object via streaming (baseline only) | 848 MB | 837 MB | 1,621 ms |
| `json-river-pick-skip-shell` | Streamed items, envelope discarded | 63 MB | 57 MB | 1,815 ms |
| `json-river-pick-shell-last` | Streamed items + shell (shell last) | 60 MB | 53 MB | 1,419 ms |
| `json-river-pick-shell-first` | Streamed items + shell (shell first) | 64 MB | 57 MB | 3,420 ms |

**Key takeaways:**

- **Streaming the full object is worse than `JSON.parse()`, not better.** `json-river-parse-inefficient-baseline` peaked at 848 MB — nearly 6x higher than native. V8's `JSON.parse()` uses an optimized C++ single-pass path that produces compact object representations. The streaming Deserializer builds objects incrementally with many intermediate allocations. This approach exists solely as a benchmark baseline to demonstrate *why* streaming into a full object is counterproductive — **it should never be used in production**. If you need the entire object, use `JSON.parse()`.

- **Streaming wins when you don't materialize everything.** All three pick modes use ~60% less memory than native by processing items individually. Only the shell (tiny metadata) stays in memory.

- **Shell-last is the fastest streaming mode.** Zero buffering, zero disk I/O — values are deserialized and emitted inline during a single pass.

- **Shell-first costs ~2x wall time.** Picked tokens are re-stringified to temp files during pass 1, then re-parsed in pass 2. The memory profile is nearly identical to shell-last — the extra time is purely I/O overhead.

- **Use shell-first only when you need metadata before processing items** (pagination cursors, auth context, schema info). Otherwise default to shell-last.

## License

MIT
