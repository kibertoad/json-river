import { bench, describe } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { JsonParser } from '../src/parser.ts'
import { JsonStringifier } from '../src/stringifier.ts'
import { JsonSerializer } from '../src/serializer.ts'
import { JsonDeserializer } from '../src/deserializer.ts'

// json-stream-es
import { JsonParser as JsonStreamEsParser } from 'json-stream-es/src/json-parser'
import { JsonStringifier as JsonStreamEsStringifier } from 'json-stream-es/src/json-stringifier'
import { JsonSerializer as JsonStreamEsSerializer } from 'json-stream-es/src/json-serializer'
import { JsonDeserializer as JsonStreamEsDeserializer } from 'json-stream-es/src/json-deserializer'

// ---- Test data ----

function generateLargeObject() {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < 500; i++) {
    obj[`key_${i}`] = { value: i, label: `item ${i}`, nested: { arr: [1, 2, 3] } }
  }
  return obj
}

const LARGE_OBJECT = generateLargeObject()
const LARGE_JSON = JSON.stringify(LARGE_OBJECT)

const SMALL_OBJECTS = Array.from({ length: 500 }, (_, i) => ({
  id: i, name: `user_${i}`, active: i % 2 === 0, scores: [95, 87, 92],
}))
const SMALL_OBJECTS_JSONL = SMALL_OBJECTS.map(o => JSON.stringify(o)).join('\n')

// ---- Helpers ----

async function tokenRoundTripJsonRiver(json: string, multi = false): Promise<void> {
  await pipeline(
    Readable.from([json]),
    new JsonParser({ multi }),
    new JsonStringifier(),
    new Writable({ write(_chunk, _enc, cb) { cb() } }),
  )
}

async function tokenRoundTripJsonStreamEs(json: string, multi = false): Promise<void> {
  const source = new ReadableStream<string>({
    start(controller) { controller.enqueue(json); controller.close() },
  })
  const reader = source
    .pipeThrough(new JsonStreamEsParser({ multi }))
    .pipeThrough(new JsonStreamEsStringifier())
    .getReader()
  while (true) { const { done } = await reader.read(); if (done) break }
}

async function fullRoundTripJsonRiver(values: unknown[]): Promise<void> {
  const serializer = new JsonSerializer()
  const p = pipeline(
    serializer,
    new JsonStringifier(),
    new JsonParser({ multi: true }),
    new JsonDeserializer(),
    new Writable({ objectMode: true, write(_chunk, _enc, cb) { cb() } }),
  )
  for (const v of values) serializer.write(v)
  serializer.end()
  await p
}

async function fullRoundTripJsonStreamEs(values: unknown[]): Promise<void> {
  const source = new ReadableStream({
    start(controller) { for (const v of values) controller.enqueue(v); controller.close() },
  })
  const reader = source
    .pipeThrough(new JsonStreamEsSerializer(undefined, { delimiter: '\n' }))
    .pipeThrough(new JsonStreamEsStringifier())
    .pipeThrough(new JsonStreamEsParser({ multi: true }))
    .pipeThrough(new JsonStreamEsDeserializer())
    .getReader()
  while (true) { const { done } = await reader.read(); if (done) break }
}

// ---- Benchmarks ----

describe('round-trip — parse+stringify large object', () => {
  bench('native JSON', () => {
    JSON.parse(JSON.stringify(LARGE_OBJECT))
  })

  bench('json-river (token pass-through)', async () => {
    await tokenRoundTripJsonRiver(LARGE_JSON)
  })

  bench('json-stream-es (token pass-through)', async () => {
    await tokenRoundTripJsonStreamEs(LARGE_JSON)
  })
})

describe('round-trip — full pipeline 500 objects', () => {
  bench('native JSON (loop)', () => {
    for (const obj of SMALL_OBJECTS) JSON.parse(JSON.stringify(obj))
  })

  bench('json-river (serialize→stringify→parse→deserialize)', async () => {
    await fullRoundTripJsonRiver(SMALL_OBJECTS)
  })

  bench('json-stream-es (full pipeline)', async () => {
    await fullRoundTripJsonStreamEs(SMALL_OBJECTS)
  })
})

describe('round-trip — parse+stringify JSONL stream', () => {
  bench('native JSON (split→parse→stringify→join)', () => {
    SMALL_OBJECTS_JSONL.split('\n').map(line => JSON.stringify(JSON.parse(line))).join('\n')
  })

  bench('json-river (multi mode)', async () => {
    await tokenRoundTripJsonRiver(SMALL_OBJECTS_JSONL, true)
  })

  bench('json-stream-es (multi mode)', async () => {
    await tokenRoundTripJsonStreamEs(SMALL_OBJECTS_JSONL, true)
  })
})
