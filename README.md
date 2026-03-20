# json-river

Streaming versions of `JSON.parse()` and `JSON.stringify()` built on Node.js Transform streams.

Designed for memory efficiency and high performance when processing large JSON data, JSONL streams, or building streaming pipelines.

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
JS values     ──────────> Token stream <──────────────── JS values
```

**Tokens** are the intermediate representation — lightweight discriminated-union objects representing JSON structural elements (object start/end, array start/end, string chunks, numbers, booleans, null, colons, commas).

Each stage is an independent Node.js Transform stream. Compose them freely:

| Pipeline | Use case |
|---|---|
| `Parser → Deserializer` | Parse JSON to JS values |
| `Serializer → Stringifier` | Stringify JS values to JSON |
| `Parser → Stringifier` | Token-level round-trip (reformat, validate) |
| `Serializer → Stringifier → Parser → Deserializer` | Full round-trip |

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

const serializer = new JsonSerializer()
```

Converts JavaScript values into token streams. Follows `JSON.stringify` semantics:
- `undefined` and functions in object values are skipped
- `undefined` and functions in arrays become `null`
- `Infinity`, `NaN` become `null`
- `toJSON()` is called if present
- `BigInt` is converted to `Number`

**Input:** JS values in `writableObjectMode`.
**Output:** Token objects in `readableObjectMode`.

### `JsonDeserializer`

Transform stream: `Token` → JS values

```typescript
import { JsonDeserializer, JSON_NULL } from 'json-river'

const deserializer = new JsonDeserializer()

deserializer.on('data', (value) => {
  // value === JSON_NULL means the JSON document was literally `null`
  const actual = value === JSON_NULL ? null : value
})
```

Reconstructs JavaScript values from token streams. Emits one value per root-level JSON document.

> **Note:** Node.js objectMode streams interpret `push(null)` as end-of-stream. Root-level `null` JSON values are emitted as the `JSON_NULL` sentinel symbol. Check with `value === JSON_NULL ? null : value`.

### `parse(options?)`

Convenience: creates a composed `Duplex` stream equivalent to `Parser → Deserializer`.

```typescript
import { parse } from 'json-river'

const stream = parse({ multi: true })
```

### `stringify(options?)`

Convenience: creates a composed `Duplex` stream equivalent to `Serializer → Stringifier`.

```typescript
import { stringify } from 'json-river'

const stream = stringify({ space: 2 })
```

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
