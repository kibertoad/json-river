/**
 * Memory profiling HTTP service.
 *
 * Registers json-river and json-stream-es workload approaches with
 * memory-watchmen's generic profiler server.
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
import { createReadStream } from 'node:fs'
import { Writable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { collectMemorySample } from 'memory-watchmen'
import { createProfileServer } from 'memory-watchmen/profiler'
import type { ApproachFn } from 'memory-watchmen'
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

// ---- Approaches ----

const profileNativeJsonParse: ApproachFn = async (filePath, multi, onSample) => {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf-8')

  onSample(collectMemorySample())

  if (multi) {
    const lines = content.split('\n').filter(l => l.trim())
    for (const line of lines) {
      JSON.parse(line)
      onSample(collectMemorySample())
    }
  } else {
    const parsed = JSON.parse(content)
    onSample(collectMemorySample())
    void parsed
  }
}

const profileNativeJsonStringify: ApproachFn = async (filePath, multi, onSample) => {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf-8')
  onSample(collectMemorySample())

  if (multi) {
    const lines = content.split('\n').filter(l => l.trim())
    for (const line of lines) {
      const obj = JSON.parse(line)
      JSON.stringify(obj)
      onSample(collectMemorySample())
    }
  } else {
    const obj = JSON.parse(content)
    onSample(collectMemorySample())
    JSON.stringify(obj)
    onSample(collectMemorySample())
    void obj
  }
}

const profileJsonRiverParse: ApproachFn = async (filePath, multi, onSample) => {
  let count = 0
  const sampler = new Transform({
    objectMode: true,
    transform(chunk, _enc, cb) {
      count++
      if (count <= 1000 || count % 100 === 0) onSample(collectMemorySample())
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

const profileJsonRiverReformat: ApproachFn = async (filePath, multi, onSample) => {
  let count = 0

  await pipeline(
    createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 }),
    new JsonParser({ multi }),
    new JsonStringifier(),
    new Writable({
      write(_chunk, _enc, cb) {
        count++
        if (count <= 1000 || count % 500 === 0) onSample(collectMemorySample())
        cb()
      },
    }),
  )
}

const profileJsonRiverParseStringify: ApproachFn = async (filePath, multi, onSample) => {
  let count = 0
  const deserializer = new JsonDeserializer()
  const serializer = new JsonSerializer()

  deserializer.on('data', (value: unknown) => {
    serializer.write(value)
    count++
    if (count <= 1000 || count % 100 === 0) onSample(collectMemorySample())
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

const profileJsonStreamEsParse: ApproachFn = async (filePath, multi, onSample) => {
  const reader = fileToWebStream(filePath)
    .pipeThrough(new JseParser({ multi }))
    .pipeThrough(new JseDeserializer())
    .getReader()

  let count = 0
  while (true) {
    const { done } = await reader.read()
    if (done) break
    count++
    if (count <= 1000 || count % 100 === 0) onSample(collectMemorySample())
  }
}

const profileJsonStreamEsReformat: ApproachFn = async (filePath, multi, onSample) => {
  const reader = fileToWebStream(filePath)
    .pipeThrough(new JseParser({ multi }))
    .pipeThrough(new JseStringifier())
    .getReader()

  let count = 0
  while (true) {
    const { done } = await reader.read()
    if (done) break
    count++
    if (count <= 1000 || count % 500 === 0) onSample(collectMemorySample())
  }
}

const profileNativeJsonParseIterate: ApproachFn = async (filePath, _multi, onSample, path?) => {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf-8')
  onSample(collectMemorySample())
  const parsed = JSON.parse(content)
  onSample(collectMemorySample())
  const arrayKey = path || 'data'
  const items = parsed[arrayKey]
  if (!Array.isArray(items)) {
    throw new Error(`Value at "${arrayKey}" is not an array`)
  }
  for (let i = 0; i < items.length; i++) {
    void items[i]
    if (i % 100 === 0) onSample(collectMemorySample())
  }
}

const profileJsonRiverPick: ApproachFn = async (filePath, _multi, onSample, path?) => {
  let count = 0
  const sampler = new Transform({
    objectMode: true,
    transform(chunk, _enc, cb) {
      count++
      if (count <= 1000 || count % 100 === 0) onSample(collectMemorySample())
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

const profileJsonRiverPickShellLast: ApproachFn = async (filePath, _multi, onSample, path?) => {
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
        if (count <= 1000 || count % 100 === 0) onSample(collectMemorySample())
        cb()
      },
    }),
  )
}

const profileJsonRiverPickShellFirst: ApproachFn = async (filePath, _multi, onSample, path?) => {
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
        if (count <= 1000 || count % 100 === 0) onSample(collectMemorySample())
        cb()
      },
    }),
  )
}

// ---- Server ----

const approaches = new Map<string, ApproachFn>([
  ['native-json-parse', profileNativeJsonParse],
  ['native-json-stringify', profileNativeJsonStringify],
  ['native-json-parse-iterate', profileNativeJsonParseIterate],
  ['json-river-parse-inefficient-baseline', profileJsonRiverParse],
  ['json-river-reformat', profileJsonRiverReformat],
  ['json-river-parse-stringify', profileJsonRiverParseStringify],
  ['json-river-pick-skip-shell', profileJsonRiverPick],
  ['json-river-pick-shell-last', profileJsonRiverPickShellLast],
  ['json-river-pick-shell-first', profileJsonRiverPickShellFirst],
  ['json-stream-es-parse', profileJsonStreamEsParse],
  ['json-stream-es-reformat', profileJsonStreamEsReformat],
])

const port = parseInt(process.argv[2] || '3847', 10)

createProfileServer({ approaches, port })
