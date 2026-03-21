/**
 * Memory profiling HTTP service.
 *
 * Runs JSON processing workloads in-process and exposes memory metrics via HTTP.
 * Each endpoint processes a given JSON file using a specific approach and streams
 * memory samples back as NDJSON.
 *
 * The server collects heap snapshots at regular intervals during processing,
 * enabling time-series analysis of memory usage across different approaches.
 *
 * Usage:
 *   npx tsx bench/memory-profiler/server.ts [port]
 *
 * Endpoints:
 *   POST /profile
 *     Body: { approach, filePath, multi?, sampleIntervalMs? }
 *     Response: NDJSON stream of { timestamp, heapUsed, heapTotal, rss, external }
 *     Final line: { summary: true, peak, baseline, samples, elapsed, approach, file }
 *
 *   GET /approaches
 *     Returns available approach names.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Writable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { JsonParser } from '../../src/parser.ts'
import { JsonStringifier } from '../../src/stringifier.ts'
import { JsonSerializer } from '../../src/serializer.ts'
import { JsonDeserializer } from '../../src/deserializer.ts'
import { JsonArrayItems } from '../../src/array-items.ts'
import { JsonPick, type PickEvent } from '../../src/pick.ts'

// json-stream-es (Web Streams based)
// Use dist bundle — json-stream-es src has extensionless imports incompatible with native Node TS
import {
  JsonParser as JseParser,
  JsonStringifier as JseStringifier,
  JsonDeserializer as JseDeserializer,
} from 'json-stream-es'

interface MemorySample {
  timestamp: number
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
}

interface ProfileRequest {
  approach: string
  filePath: string
  multi?: boolean
  path?: string
  sampleIntervalMs?: number
}

interface ProfileSummary {
  summary: true
  approach: string
  file: string
  fileSizeMB: number
  baseline: MemorySample
  peak: MemorySample
  peakHeapUsedMB: number
  baselineHeapUsedMB: number
  deltaHeapUsedMB: number
  totalSamples: number
  elapsedMs: number
}

function collectMemory(): MemorySample {
  const mem = process.memoryUsage()
  return {
    timestamp: Date.now(),
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
  }
}

function forceGC(): void {
  if (global.gc) {
    global.gc()
    global.gc()
  }
}

// ---- Approaches ----

async function profileNativeJsonParse(filePath: string, multi: boolean, onSample: (s: MemorySample) => void): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf-8')

  // Sample after readFile — raw string is in memory
  onSample(collectMemory())

  if (multi) {
    const lines = content.split('\n').filter(l => l.trim())
    for (const line of lines) {
      JSON.parse(line)
      onSample(collectMemory())
    }
  } else {
    // Sample immediately after parse — both the raw string and parsed object
    // coexist in memory at this point, which is the true peak
    const parsed = JSON.parse(content)
    onSample(collectMemory())
    void parsed
  }
}

async function profileNativeJsonStringify(filePath: string, multi: boolean, onSample: (s: MemorySample) => void): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf-8')
  onSample(collectMemory())

  if (multi) {
    const lines = content.split('\n').filter(l => l.trim())
    for (const line of lines) {
      const obj = JSON.parse(line)
      JSON.stringify(obj)
      onSample(collectMemory())
    }
  } else {
    const obj = JSON.parse(content)
    onSample(collectMemory())
    JSON.stringify(obj)
    onSample(collectMemory())
    void obj
  }
}

async function profileJsonRiverParse(filePath: string, multi: boolean, onSample: (s: MemorySample) => void): Promise<void> {
  let count = 0
  const sampler = new Transform({
    objectMode: true,
    transform(chunk, _enc, cb) {
      count++
      if (count <= 1000 || count % 100 === 0) onSample(collectMemory())
      cb()
    },
  })

  await pipeline(
    createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 }),
    new JsonParser({ multi }),
    new JsonDeserializer(),
    sampler,
  )
}

async function profileJsonRiverReformat(filePath: string, multi: boolean, onSample: (s: MemorySample) => void): Promise<void> {
  let count = 0

  // Parser → Stringifier: tokens flow through, no JS values materialized
  await pipeline(
    createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 }),
    new JsonParser({ multi }),
    new JsonStringifier(),
    new Writable({
      write(_chunk, _enc, cb) {
        count++
        if (count <= 1000 || count % 500 === 0) onSample(collectMemory())
        cb()
      },
    }),
  )
}

async function profileJsonRiverParseStringify(filePath: string, multi: boolean, onSample: (s: MemorySample) => void): Promise<void> {
  // Parser → Deserializer → Serializer → Stringifier: full value round-trip
  let count = 0
  const deserializer = new JsonDeserializer()
  const serializer = new JsonSerializer()

  // Bridge: objectMode deserializer → objectMode serializer
  // Deserializer emits values, serializer accepts values
  deserializer.on('data', (value: unknown) => {
    serializer.write(value)
    count++
    if (count <= 1000 || count % 100 === 0) onSample(collectMemory())
  })
  deserializer.on('end', () => serializer.end())

  await Promise.all([
    pipeline(
      createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 }),
      new JsonParser({ multi }),
      deserializer,
    ),
    pipeline(
      serializer,
      new JsonStringifier(),
      new Writable({ write(_chunk, _enc, cb) { cb() } }),
    ),
  ])
}

// ---- json-stream-es approaches ----

function fileToWebStream(filePath: string): ReadableStream<string> {
  const nodeStream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 })
  return new ReadableStream<string>({
    start(controller) {
      nodeStream.on('data', (chunk: string) => controller.enqueue(chunk))
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (err) => controller.error(err))
    },
    cancel() {
      nodeStream.destroy()
    },
  })
}

async function profileJsonStreamEsParse(filePath: string, multi: boolean, onSample: (s: MemorySample) => void): Promise<void> {
  const reader = fileToWebStream(filePath)
    .pipeThrough(new JseParser({ multi }))
    .pipeThrough(new JseDeserializer())
    .getReader()

  let count = 0
  while (true) {
    const { done } = await reader.read()
    if (done) break
    count++
    if (count <= 1000 || count % 100 === 0) onSample(collectMemory())
  }
}

async function profileJsonStreamEsReformat(filePath: string, multi: boolean, onSample: (s: MemorySample) => void): Promise<void> {
  const reader = fileToWebStream(filePath)
    .pipeThrough(new JseParser({ multi }))
    .pipeThrough(new JseStringifier())
    .getReader()

  let count = 0
  while (true) {
    const { done } = await reader.read()
    if (done) break
    count++
    if (count <= 1000 || count % 500 === 0) onSample(collectMemory())
  }
}

async function profileNativeJsonParseIterate(filePath: string, _multi: boolean, onSample: (s: MemorySample) => void, path?: string): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf-8')
  onSample(collectMemory())
  const parsed = JSON.parse(content)
  onSample(collectMemory())
  const arrayKey = path || 'data'
  const items = parsed[arrayKey]
  if (!Array.isArray(items)) {
    throw new Error(`Value at "${arrayKey}" is not an array`)
  }
  for (let i = 0; i < items.length; i++) {
    void items[i]
    if (i % 100 === 0) onSample(collectMemory())
  }
}

async function profileJsonRiverPick(filePath: string, _multi: boolean, onSample: (s: MemorySample) => void, path?: string): Promise<void> {
  let count = 0
  const sampler = new Transform({
    objectMode: true,
    transform(chunk, _enc, cb) {
      count++
      if (count <= 1000 || count % 100 === 0) onSample(collectMemory())
      cb()
    },
  })

  await pipeline(
    createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 }),
    new JsonParser(),
    new JsonArrayItems({ path }),
    new JsonDeserializer(),
    sampler,
  )
}

async function profileJsonRiverPickShellLast(filePath: string, _multi: boolean, onSample: (s: MemorySample) => void, path?: string): Promise<void> {
  let count = 0
  const pick = new JsonPick({ pick: [path || 'data'] })

  await pipeline(
    createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 }),
    new JsonParser(),
    pick,
    new Writable({
      objectMode: true,
      write(_event: PickEvent, _enc, cb) {
        count++
        if (count <= 1000 || count % 100 === 0) onSample(collectMemory())
        cb()
      },
    }),
  )
}

async function profileJsonRiverPickShellFirst(filePath: string, _multi: boolean, onSample: (s: MemorySample) => void, path?: string): Promise<void> {
  let count = 0
  const pick = new JsonPick({ pick: [path || 'data'], shellFirst: true })

  await pipeline(
    createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 }),
    new JsonParser(),
    pick,
    new Writable({
      objectMode: true,
      write(_event: PickEvent, _enc, cb) {
        count++
        if (count <= 1000 || count % 100 === 0) onSample(collectMemory())
        cb()
      },
    }),
  )
}

type ApproachFn = (filePath: string, multi: boolean, onSample: (s: MemorySample) => void, path?: string) => Promise<void>

const APPROACHES: Record<string, ApproachFn> = {
  'native-json-parse': profileNativeJsonParse,
  'native-json-stringify': profileNativeJsonStringify,
  'native-json-parse-iterate': profileNativeJsonParseIterate,
  'json-river-parse-inefficient-baseline': profileJsonRiverParse,
  'json-river-reformat': profileJsonRiverReformat,
  'json-river-parse-stringify': profileJsonRiverParseStringify,
  'json-river-pick-skip-shell': profileJsonRiverPick,
  'json-river-pick-shell-last': profileJsonRiverPickShellLast,
  'json-river-pick-shell-first': profileJsonRiverPickShellFirst,
  'json-stream-es-parse': profileJsonStreamEsParse,
  'json-stream-es-reformat': profileJsonStreamEsReformat,
}

// ---- HTTP Server ----

async function handleProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await new Promise<string>((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

  let request: ProfileRequest
  try {
    request = JSON.parse(body)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const { approach, filePath, multi = false, path, sampleIntervalMs = 20 } = request

  const fn = APPROACHES[approach]
  if (!fn) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Unknown approach: ${approach}. Available: ${Object.keys(APPROACHES).join(', ')}` }))
    return
  }

  let fileSizeMB: number
  try {
    const s = await stat(filePath)
    fileSizeMB = s.size / (1024 * 1024)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `File not found: ${filePath}` }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
  })

  const samples: MemorySample[] = []
  let peakSample: MemorySample | null = null

  const onSample = (sample: MemorySample) => {
    samples.push(sample)
    if (!peakSample || sample.heapUsed > peakSample.heapUsed) {
      peakSample = sample
    }
    res.write(JSON.stringify(sample) + '\n')
  }

  // Also sample on a timer for approaches that don't call onSample frequently
  let timerStopped = false
  const timerLoop = (async () => {
    while (!timerStopped) {
      await sleep(sampleIntervalMs)
      if (!timerStopped) onSample(collectMemory())
    }
  })()

  forceGC()
  const baseline = collectMemory()
  onSample(baseline)

  const start = performance.now()

  try {
    await fn(filePath, multi, onSample, path)
  } catch (err: any) {
    timerStopped = true
    res.write(JSON.stringify({ error: err.message }) + '\n')
    res.end()
    return
  }

  const elapsed = performance.now() - start

  timerStopped = true
  await timerLoop

  // Final sample immediately after work ends (before GC) to capture true end-of-work memory
  onSample(collectMemory())
  forceGC()
  onSample(collectMemory())

  const summary: ProfileSummary = {
    summary: true,
    approach,
    file: filePath,
    fileSizeMB: Math.round(fileSizeMB * 10) / 10,
    baseline,
    peak: peakSample!,
    peakHeapUsedMB: Math.round((peakSample!.heapUsed / (1024 * 1024)) * 10) / 10,
    baselineHeapUsedMB: Math.round((baseline.heapUsed / (1024 * 1024)) * 10) / 10,
    deltaHeapUsedMB: Math.round(((peakSample!.heapUsed - baseline.heapUsed) / (1024 * 1024)) * 10) / 10,
    totalSamples: samples.length,
    elapsedMs: Math.round(elapsed),
  }

  res.write(JSON.stringify(summary) + '\n')
  res.end()
}

const port = parseInt(process.argv[2] || '3847', 10)

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/approaches') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(Object.keys(APPROACHES)))
    return
  }

  if (req.method === 'POST' && req.url === '/profile') {
    try {
      await handleProfile(req, res)
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
      }
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(port, () => {
  console.log(`Memory profiler server listening on http://localhost:${port}`)
  console.log(`Available approaches: ${Object.keys(APPROACHES).join(', ')}`)
  console.log()
  console.log('Usage:')
  console.log(`  curl -X POST http://localhost:${port}/profile \\`)
  console.log(`    -H "Content-Type: application/json" \\`)
  console.log(`    -d '{"approach":"json-river-parse","filePath":".test-data/medium-jsonl.ndjson","multi":true}'`)
})
