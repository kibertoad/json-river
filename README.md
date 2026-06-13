# json-river

Streaming versions of `JSON.parse()` and `JSON.stringify()` built on Node.js Transform streams. Zero runtime dependencies.

```bash
npm install json-river
```

Requires Node.js >= 22.0.0.

## When to use it

json-river is not a replacement for `JSON.parse()`. It is a specialized tool for scenarios where streaming matters — bounded memory, backpressure, and incremental processing. Native JSON is faster for data that already fits in a string.

| Scenario | Use json-river? |
|---|---|
| Config file, small API response | No — `JSON.parse()` is faster and simpler |
| JSONL log file, event stream, message queue | Yes — streams doc by doc with backpressure |
| Large JSON array (database export, bulk API) | Yes — `parseArray()` streams items one at a time |
| API response with metadata + large data array | Yes — `parsePick()` streams items while keeping the envelope |
| Reformatting / validating JSON | Yes — token-level pipeline, no JS objects created |
| Need the entire parsed object in memory | No — streaming Deserializer uses *more* memory than `JSON.parse()` |
| Browser or Web Streams needed | No — use [json-stream-es](https://github.com/cdauth/json-stream-es) instead |

**Size guidelines** (rules of thumb, not hard cutoffs):

| Document size | Recommendation |
|---|---|
| Under 5 MB | `JSON.parse()` is usually simplest and totally fine |
| 5–50 MB | Streaming is worth considering, especially under concurrency |
| 50 MB+ | Stream unless you specifically need the full structure in memory |

## Memory Benchmarks

All measurements use 45.5 MB test files with 50,000 items, sampled via the [memory profiler](PROFILING.md).

**Columns:**
- **Heap delta** — difference between peak heap usage and the pre-work baseline, i.e. how much heap the workload itself added. Lower is better.
- **Wall time** — end-to-end elapsed time. Streaming trades throughput for bounded memory, so higher times are expected.

### JSONL processing (many small documents)

Test file: 50,000 newline-delimited JSON objects (45.5 MB).

| Approach | Pipeline | Heap delta | Wall time |
|---|---|---|---|
| `JSON.parse()` | `readFile` + `JSON.parse()` | 142 MB | 294 ms |
| `JSON.parse()` + `stringify()` | Per-document parse + stringify | 168 MB | 329 ms |
| json-river parse | `Parser` + `Deserializer` | 54 MB | 1,648 ms |
| json-river reformat | `Parser` + `Stringifier` (tokens only) | 63 MB | 3,411 ms |
| json-river round-trip | `Parser` + `Deserializer` + `Serializer` + `Stringifier` | 57 MB | 4,586 ms |
| json-stream-es parse | Web Streams `Parser` + `Deserializer` | 74 MB | 23,766 ms |
| json-stream-es reformat | Web Streams `Parser` + `Stringifier` | 78 MB | 30,067 ms |

- **json-river uses ~60% less memory than `JSON.parse()`** for multi-document streams, because native JSON must read the entire file into a string first.
- **json-river is ~7x faster than json-stream-es** on Node.js, due to native Transform streams and optimized token allocation.

### Large array inside an object

Test file: `{"metadata": {...}, "data": [50,000 items], "total": N}` (45.5 MB).

| Approach | What you get | Heap delta | Wall time |
|---|---|---|---|
| `JSON.parse()` | Full object in memory | 91 MB | 147 ms |
| json-river parse (baseline) | Full object via streaming | 953 MB | 2,837 ms |
| json-river pick (skip shell) | Streamed items, envelope discarded | 57 MB | 2,265 ms |
| json-river pick (shell last) | Streamed items + shell | 53 MB | 1,758 ms |
| json-river pick (shell first) | Shell first, then streamed items | 57 MB | 5,281 ms |

### Key takeaways

- **Streaming the full object is worse than `JSON.parse()`.** V8's `JSON.parse()` uses an optimized C++ single-pass path. The streaming Deserializer builds objects incrementally with more allocations. If you need the entire object, use `JSON.parse()`.

- **Streaming wins when you don't materialize everything.** All pick modes use ~40% less memory than native by processing items individually.

- **Shell-last is the fastest streaming mode.** Zero buffering, zero disk I/O — values are emitted inline during a single pass.

- **Shell-first costs ~3x wall time** due to disk I/O overhead. Use it only when you need metadata before processing items.

- **For JSONL, streaming is strictly better on memory.** Native JSON must buffer the entire file as a string; streaming processes chunks as they arrive.

## Getting Started

### Parse JSONL (newline-delimited JSON)

The most common use case — processing a stream of many small JSON documents:

```typescript
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { parse } from 'json-river'

const stream = parse({ multi: true })

stream.on('data', (value) => {
  console.log('Document:', value)
})

await pipeline(createReadStream('data.ndjson'), stream)
```

### Stream items from a JSON array

Process items one at a time from a large array — only one item lives in memory:

```typescript
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { parseArray } from 'json-river'

// data.json: [{"id": 1, ...}, {"id": 2, ...}, ...]
await pipeline(
  createReadStream('data.json'),
  parseArray(),
  async function* (source) {
    for await (const item of source) {
      await processItem(item)
    }
  }
)
```

When the array is nested inside an object, use `path`:

```typescript
// response.json: {"metadata": {...}, "data": [item1, item2, ...]}
await pipeline(
  createReadStream('response.json'),
  parseArray({ path: 'data' }),
  async function* (source) {
    for await (const item of source) {
      await processItem(item)
    }
  }
)

// Paths can be nested: 'results.items', 'a.b.c'
```

### Stream items while keeping the envelope

When you need both metadata and array items without materializing the full object:

```typescript
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { parsePick } from 'json-river'

// response.json:
// {"metadata": {"page": 1, "total": 50000}, "data": [...], "links": {"next": "..."}}

await pipeline(
  createReadStream('response.json'),
  parsePick({ pick: ['data'] }),
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

By default, items are emitted as they're encountered and the shell comes last. If you need the shell *before* items (e.g. for pagination cursors), use `shellFirst`:

```typescript
const stream = parsePick({ pick: ['data'], shellFirst: true })
```

| `shellFirst` | Shell order | Disk I/O | Memory |
|---|---|---|---|
| `false` (default) | Last | None | O(shell + one item) |
| `true` | First | OS tmpdir (auto-cleaned) | O(shell + one item) |
| `"/path"` | First | Custom dir (caller cleans) | O(shell + one item) |

### Stringify JS values to JSON

```typescript
import { pipeline } from 'node:stream/promises'
import { stringify } from 'json-river'

const stream = stringify({ space: 2 })

const p = pipeline(stream, process.stdout)
stream.write({ name: 'Alice', age: 30 })
stream.write({ name: 'Bob', age: 25 })
stream.end()
await p
```

### Reformat JSON without parsing to JS values

Token-level pipeline — no JS objects are ever created, memory stays proportional to I/O buffer size:

```typescript
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { JsonParser, JsonStringifier } from 'json-river'

await pipeline(
  createReadStream('compact.json'),
  new JsonParser(),
  new JsonStringifier({ space: 2 }),
  createWriteStream('pretty.json')
)
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

### Convenience functions

These cover the most common use cases. Each returns a `Duplex` stream — write JSON text in (or JS values for `stringify`), read results out.

#### `parse(options?)`

`Parser → Deserializer`. Write JSON text, read JS values.

```typescript
import { parse } from 'json-river'

const stream = parse({ multi: true })
```

Options: `multi`, `reviver`.

#### `parseArray(options?)`

`Parser → ArrayItems → Deserializer`. Write JSON text, read individual array items.

```typescript
import { parseArray } from 'json-river'

const stream = parseArray({ path: 'data' })
```

Options: `path`, `reviver`.

#### `parsePick(options)`

`Parser → Pick`. Write JSON text, read `PickEvent` objects.

```typescript
import { parsePick } from 'json-river'

const stream = parsePick({ pick: ['data'], shellFirst: true })
```

Options: `pick`, `shellFirst`.

#### `stringify(options?)`

`Serializer → Stringifier`. Write JS values, read JSON text.

```typescript
import { stringify } from 'json-river'

const stream = stringify({ space: 2 })
```

Options: `space`, `replacer`, `bigint`.

### Transform streams

For full control, compose the individual transforms in a `pipeline()`.

#### `JsonParser`

Transform: `string | Buffer` → `Token`

```typescript
const parser = new JsonParser(options?)
```

**Options:**
- `multi?: boolean` — Allow multiple root-level JSON values (JSONL / JSON-seq). Default: `false`.

Handles arbitrary chunk boundaries, UTF-8 multi-byte characters across chunks (via `StringDecoder`), all JSON escape sequences including `\uXXXX`, and strict validation.

**Errors:**
- `UnexpectedCharError` — invalid character at a given position
- `PrematureEndError` — input ended mid-value

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

#### `JsonStringifier`

Transform: `Token` → `string`

```typescript
const stringifier = new JsonStringifier(options?)
```

**Options:**
- `space?: string | number` — Indentation, like `JSON.stringify`'s third argument. Default: none (compact).

#### `JsonSerializer`

Transform: JS values → `Token`

```typescript
const serializer = new JsonSerializer(options?)
```

**Options:**
- `bigint?: "error" | "number"` — How to handle `BigInt` values. Default: `"error"` (throws `TypeError`, matching `JSON.stringify`). `"number"` converts via `Number(value)` — values beyond `Number.MAX_SAFE_INTEGER` lose precision.
- `replacer?: ((key: string, value: unknown) => unknown) | (string | number)[]` — Matches `JSON.stringify`'s second argument.

Follows `JSON.stringify` semantics: `undefined`/functions in object values are skipped, in arrays become `null`; `Infinity`/`NaN` become `null`; `toJSON()` is called if present.

#### `JsonDeserializer`

Transform: `Token` → JS values

```typescript
import { JsonDeserializer, JSON_NULL } from 'json-river'

const deserializer = new JsonDeserializer(options?)

deserializer.on('data', (value) => {
  const actual = value === JSON_NULL ? null : value
})
```

**Options:**
- `reviver?: (key: string, value: unknown) => unknown` — Matches `JSON.parse`'s second argument. Called bottom-up for every key/value pair.

Emits one value per root-level JSON document. Root-level `null` is emitted as the `JSON_NULL` sentinel (because Node.js objectMode treats `push(null)` as end-of-stream).

#### `JsonArrayItems`

Transform: `Token` → `Token`

Sits between `JsonParser` and `JsonDeserializer`. Consumes wrapping structure tokens and re-emits only each array item's tokens, so the downstream `JsonDeserializer` processes items one at a time.

```typescript
const arrayItems = new JsonArrayItems(options?)
```

**Options:**
- `path?: string` — Dot-separated path to the target array. Default: `undefined` (root must be an array).

| `path` value | Expected JSON shape |
|---|---|
| `undefined` | `[item, item, ...]` |
| `"data"` | `{"data": [item, item, ...]}` |
| `"results.items"` | `{"results": {"items": [item, item, ...]}}` |

#### `JsonPick`

Transform: `Token` → `PickEvent`

Sits after `JsonParser`. Splits a JSON object into a "shell" (all non-picked fields) and individually streamed picked values. If a picked value is an array, each item is emitted separately.

```typescript
const pick = new JsonPick(options)
```

**Options:**
- `pick: string[]` — Dot-separated paths to fields to stream separately. Required.
- `shellFirst?: boolean | string` — Controls emission order:
  - `false` (default) — picked values inline, shell last. No disk I/O.
  - `true` — shell first. Picked tokens offloaded to OS tmpdir (auto-cleaned).
  - `string` — shell first. Offloaded to given directory (caller cleans).

**Output events (`PickEvent`):**
- `{ type: "shell", value: Record<string, unknown> }` — object with picked fields omitted
- `{ type: "value", path: string, value: unknown }` — one per picked value (or per array item)

**Dot-notation** navigates nested objects:

| `pick` value | Picked from |
|---|---|
| `["data"]` | Root-level `data` field |
| `["response.items"]` | `items` inside `response` |
| `["data", "meta.cursor"]` | Multiple fields at different depths |

Intermediate objects stay in the shell with the picked key removed.

**Memory:** O(shell + max single picked item) in all modes.

### Token Types

```typescript
import { TokenType, StringRole, type Token } from 'json-river'

TokenType.OBJECT_START   // '{'
TokenType.OBJECT_END     // '}'
TokenType.ARRAY_START    // '['
TokenType.ARRAY_END      // ']'
TokenType.STRING_START   // opening quote (has role: StringRole.KEY | StringRole.VALUE)
TokenType.STRING_CHUNK   // string content (has role and value: string)
TokenType.STRING_END     // closing quote (has role)
TokenType.NUMBER         // number (has value: number)
TokenType.TRUE           // true
TokenType.FALSE          // false
TokenType.NULL           // null
TokenType.COLON          // ':'
TokenType.COMMA          // ','
```

**Singleton tokens** — pre-allocated frozen objects for structural tokens (zero allocation per token):

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

Native JSON is implemented in V8's C++ layer and will always be faster for buffered data. json-river's advantage is *memory*, not *throughput*:

| Scenario | Native JSON | json-river |
|---|---|---|
| Config file / API response | Best choice — fast, simple | Unnecessary overhead |
| JSONL log file (many small docs) | Must load file, split lines, handle boundaries | Streams doc by doc with backpressure |
| Single large object, need it all | `JSON.parse()` — fast, compact in V8's C++ path | **Worse** — incremental allocations |
| Large array, process items | Materializes entire array + wrapper | Streams items one at a time |
| Large array + envelope metadata | Materializes everything | Streams items, emits shell separately |
| Reformatting only | Parse to JS, re-stringify — 2x memory | Token pipeline — no JS objects |
| JSON from network/subprocess | Buffer everything, then parse | Process incrementally as data arrives |

### vs. json-stream-es

| Concern | json-stream-es | json-river |
|---|---|---|
| Stream API | Web Streams (WHATWG) | Node.js Transform streams |
| Backpressure | Web Streams built-in | Node.js built-in |
| Parser state | Linked-list parent states | Explicit stack array |
| String buffering | Accumulates in state object | Eager flush at chunk boundaries |
| Token allocation | New object per token | Frozen singletons for structural tokens |
| Number format | Preserves raw via `rawValue` | Stores parsed `Number` |
| UTF-8 handling | N/A (Web Streams use strings) | `StringDecoder` for chunk boundary safety |

Choose json-stream-es for Web Streams (browsers, Deno, Cloudflare Workers). Choose json-river for Node.js.

### Memory efficiency internals

- **Explicit stack array** — flat `number[]` stack instead of linked parent state objects
- **Eager string flushing** — string content emitted at chunk boundaries, buffer cleared immediately
- **Frozen singleton tokens** — zero allocation per structural token
- **CharCode-based parsing** — numeric comparisons on the hot path

## Scripts

```bash
pnpm test                  # Unit tests
pnpm run test:memory       # Memory leak tests (requires --expose-gc)
pnpm run bench             # Performance benchmarks (vs. native JSON and json-stream-es)
pnpm run profile:compare   # Memory comparison — pick modes (see PROFILING.md)
```

See [PROFILING.md](PROFILING.md) for the full profiling toolkit.

## License

MIT
