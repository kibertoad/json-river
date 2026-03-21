# json-river

Streaming versions of `JSON.parse()` and `JSON.stringify()` built on Node.js Transform streams.

## Streaming vs. native JSON

json-river is not a general-purpose replacement for `JSON.parse()` / `JSON.stringify()`. It is a specialized tool for scenarios where streaming matters. Here is when it helps — and when it doesn't.

### When json-river helps:

- **Processing many JSON documents from a stream.** JSONL log files, event streams, message queues, SSE payloads — any source that delivers multiple JSON values over time. With `JSON.parse()` you must split on boundaries yourself, handle values that span chunk boundaries, and manage backpressure manually. json-river handles all of this natively with `{ multi: true }`.

- **Building streaming pipelines.** When JSON data arrives from a network socket, file, or subprocess and needs to flow through transformations before being written elsewhere, json-river slots into Node.js `pipeline()` naturally. Backpressure propagates automatically — a slow consumer pauses the producer.

- **Reformatting or validating JSON without materializing JS objects.** The `Parser → Stringifier` pipeline converts between compact and pretty-printed JSON at the token level, without ever constructing JavaScript values. This works with any JSON shape — a single massive object, a deeply nested tree, anything. Since no JS objects are created, memory usage stays proportional to the I/O buffer size, not the document size.

- **Controlling memory usage in long-running services.** Servers that accept JSON uploads or process queued JSON payloads benefit from bounded memory. When processing streams of many small documents (JSONL, arrays of records), each document is deserialized, consumed, and discarded individually — only one document lives in memory at a time.

### When json-river doesn't help:

- **Your JSON is small and already fully buffered in a string.** `JSON.parse()` and `JSON.stringify()` are implemented in C++ inside V8 and are significantly faster than any JavaScript-based streaming parser. For a config file, an API response, or any payload you already have as a string, native JSON is the right choice. See the [size guidelines](#rough-size-guidelines) below for when to start considering streaming.

- **You need the entire parsed object anyway.** If you pipe through the `Deserializer`, it reconstructs the full JS object in memory. For a single large document (one big object or one big array consumed as a whole), the end result is the same as `JSON.parse()` — the full object graph lives in memory. Streaming saves memory only when you can process and discard documents *individually* (JSONL, iterating array items) or when you stay at the token level (`Parser → Stringifier`).

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
import { parse, stringify } from 'json-river'

// parse() returns a Duplex: write strings, read JS values
const parser = parse({ multi: true })
parser.write('{"a":1}\n{"b":2}\n')
parser.end()

for await (const value of parser) {
  console.log(value)
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

### `parse(options?)`

Convenience: creates a composed `Duplex` stream equivalent to `Parser → Deserializer`.

```typescript
import { parse } from 'json-river'

const stream = parse({ multi: true })
```

Accepts all `JsonParser` and `JsonDeserializer` options (`multi`, `reviver`).

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
| Single large object, need it all in memory | Same end result — full object in heap | No memory advantage (Deserializer builds the full object) |
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
# Run unit tests (144 tests)
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
npm run profile:chart -- <filePath> [--multi] [--output=results]
```

## Memory Profiler

The `bench/memory-profiler/` directory contains a comprehensive memory analysis tool:

### Data Generator

```bash
node bench/memory-profiler/generate-json.ts [preset] [outputDir]
```

Generates four types of test files per preset:
- **JSONL** — many small objects (newline-delimited)
- **Large object** — single object with many keys
- **Large strings** — objects with large string values
- **Deep nesting** — deeply nested array structures

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
- `json-river-parse` — `JsonParser → JsonDeserializer` stream pipeline
- `json-river-parse-stringify` — `JsonParser → JsonDeserializer → JsonSerializer → JsonStringifier`
- `json-river-reformat` — `JsonParser → JsonStringifier` (tokens only, no JS values materialized)
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
```

Connects to the profiler server, runs every registered approach against the given file, and writes results into the output directory:
- `chart.html` — self-contained HTML comparison chart (heap usage over time)
- `summary.json` — peak/baseline/delta per approach
- `chart-data.json` — time-series data for external charting tools
- `samples/` — raw NDJSON per approach

## License

MIT
