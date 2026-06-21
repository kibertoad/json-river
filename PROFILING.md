# Memory Profiling

json-river includes a memory profiling toolkit for measuring heap usage across different JSON processing approaches. It is built on [memory-watchmen](https://github.com/kibertoad/memory-watchmen) and lives in `bench/memory-profiler/`.

## How it works

The profiler runs JSON processing workloads inside a dedicated child process (with `--expose-gc`) and samples `process.memoryUsage()` at regular intervals. Each workload ("approach") processes a test file using a specific pipeline — native `JSON.parse()`, streaming parser, token-level reformat, etc. — while memory snapshots are collected both on a timer and after each processed item.

The sampling flow:

1. Force GC (double pass) and record a **baseline** sample
2. Start the workload and a timer-based sampler (default: every 200 ms)
3. The workload itself also calls `onSample()` after processing each item
4. When the workload finishes, take a final sample, force GC, take one more
5. Emit a **summary** line with peak heap, baseline, delta, elapsed time, and sample count

All communication happens over HTTP as NDJSON (one JSON object per line). This isolates each profiling run in its own request and lets you stream results in real time.

## Scripts

### Generate test data

```bash
pnpm run generate-data [small|medium|large|xlarge]
```

Creates five types of test files per preset in `.test-data/`:

| File type | Shape | Purpose |
|---|---|---|
| JSONL (`.ndjson`) | Many small objects, newline-delimited | Multi-document streaming |
| Large object | Single object with many keys | Single-document parse overhead |
| Large strings | Objects with 100 KB+ string values | String buffer flushing |
| Deep nesting | 100 documents with N-level nested arrays | Parser stack unwinding |
| Named array | `{"metadata": {...}, "data": [...], "total": N}` | API response / pick modes |

Presets: `small` (~1 MB), `medium` (~10 MB), `large` (~50 MB), `xlarge` (~200 MB).

### Run a comparison

```bash
pnpm run profile:compare                   # picks preset (named-array, pick modes)
pnpm run profile:compare -- --preset=jsonl  # jsonl preset (streaming approaches)
pnpm run profile:compare -- --save          # save results as new baseline
```

Starts the profiler server, runs a predefined set of approaches against a test file, and prints results alongside the previous baseline (if any). Presets:

| Preset | File | Approaches |
|---|---|---|
| `picks` (default) | `large-named-array.json` (45.5 MB) | native-json-parse, json-river-parse-inefficient-baseline, pick-skip-shell, pick-shell-last, pick-shell-first |
| `jsonl` | `large-jsonl.ndjson` (45.5 MB) | native-json-parse, native-json-stringify, json-river parse/reformat/round-trip, json-stream-es parse/reformat |

You can also specify a custom file and approach list:

```bash
pnpm run profile:compare -- --approaches=native-json-parse,json-river-reformat .test-data/medium-jsonl.ndjson --multi
```

### Start the profiler server standalone

```bash
pnpm run profile:server
```

Starts the HTTP profiler on port 3847. Useful for ad-hoc profiling or the chart generator.

Endpoints:
- `POST /profile` — run a workload and stream NDJSON samples
- `GET /approaches` — list available approach names

Example:

```bash
curl -X POST http://localhost:3847/profile \
  -H "Content-Type: application/json" \
  -d '{"approach":"json-river-reformat","filePath":".test-data/medium-jsonl.ndjson","multi":true}'
```

### Generate an HTML chart

```bash
pnpm run profile:chart -- <filePath> [--multi] [--path=data] [--approaches=a,b,c] [--output=results]
```

Requires the profiler server running in another terminal. Runs each approach against the given file and writes results to the output directory:

- `chart.html` — self-contained HTML page with a canvas-based heap usage timeline and summary table
- `summary.json` — peak/baseline/delta per approach
- `chart-data.json` — time-series `{ t, heapUsedMB, rssMB }` per approach
- `samples/` — raw NDJSON per approach

Example:

```bash
# Terminal 1:
pnpm run profile:server

# Terminal 2:
pnpm run profile:chart -- .test-data/large-named-array.json --path=data \
  --approaches=native-json-parse,json-river-pick-shell-last --output=results
```

### Run the full profiler suite

```bash
pnpm run profile [small|medium|large|xlarge]
```

Runs all approaches against all test files for the given preset. Produces timestamped output in `.test-data/profile-results/`.

## Available approaches

| Approach | Pipeline | What it measures |
|---|---|---|
| `native-json-parse` | `readFile` + `JSON.parse()` | V8 baseline — file + parsed object in memory simultaneously |
| `native-json-stringify` | `JSON.parse()` + `JSON.stringify()` per doc | Native round-trip overhead |
| `native-json-parse-iterate` | `JSON.parse()` + iterate `data[]` | Native array access for named-array comparison |
| `json-river-parse-inefficient-baseline` | `JsonParser` + `JsonDeserializer` | Full streaming deserialization — **benchmark baseline only** |
| `json-river-reformat` | `JsonParser` + `JsonStringifier` | Token-level pass-through, no JS objects created |
| `json-river-parse-stringify` | Full round-trip through all 4 stages | Serializer + deserializer overhead |
| `json-river-pick-skip-shell` | `JsonParser` + `JsonArrayItems` + `JsonDeserializer` | Stream array items, discard envelope |
| `json-river-pick-shell-last` | `JsonParser` + `JsonPick` | Stream items + shell (shell emitted last) |
| `json-river-pick-shell-first` | `JsonParser` + `JsonPick({ shellFirst: true })` | Stream items + shell (shell first, dual-pass via disk) |
| `json-stream-es-parse` | `JseParser` + `JseDeserializer` (Web Streams) | Web Streams comparison baseline |
| `json-stream-es-reformat` | `JseParser` + `JseStringifier` (Web Streams) | Web Streams token-level comparison |

## Memory leak tests

Separate from profiling, the project includes memory leak tests that verify heap stability under sustained load:

```bash
pnpm run test:memory
```

These use `memory-watchmen`'s dual-metric leak detection:

1. **Monotonic growth** — heap grew every sample for 10+ consecutive checks (tight leak)
2. **Envelope growth** — average heap in the first third vs. last third of samples exceeds 15 MB (step-wise leak)

Three test suites:
- **Parser backpressure** — sustained JSONL stream with a slow consumer
- **Large values** — large strings, deep nesting, many small docs, wide objects
- **Round-trip pipeline** — full 4-stage pipeline under backpressure
