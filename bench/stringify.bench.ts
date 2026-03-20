import { bench, describe } from 'vitest'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { JsonSerializer } from '../src/serializer.ts'
import { JsonStringifier } from '../src/stringifier.ts'

// json-stream-es
import { JsonSerializer as JsonStreamEsSerializer, serializeJsonValue } from 'json-stream-es/src/json-serializer'
import { JsonStringifier as JsonStreamEsStringifier } from 'json-stream-es/src/json-stringifier'

// ---- Test data ----

const SMALL_OBJECT = { id: 0, name: 'user_0', active: true }

function generateLargeObject() {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < 1000; i++) {
    obj[`key_${i}`] = { value: i, label: `item ${i}`, tags: ['a', 'b', 'c'] }
  }
  return obj
}

function generateDeepNesting(depth: number): unknown {
  let result: unknown = 1
  for (let i = 0; i < depth; i++) result = [result]
  return result
}

const LARGE_OBJECT = generateLargeObject()
const DEEP_OBJECT = generateDeepNesting(100)
const SMALL_OBJECTS = Array.from({ length: 1000 }, (_, i) => ({
  id: i, name: `user_${i}`, active: i % 2 === 0, scores: [95, 87, 92],
}))

// ---- Helpers ----

async function stringifyWithJsonRiver(value: unknown): Promise<void> {
  const serializer = new JsonSerializer()
  const stringifier = new JsonStringifier()
  const sink = new Writable({ write(_chunk, _enc, cb) { cb() } })

  const p = pipeline(serializer, stringifier, sink)
  serializer.write(value)
  serializer.end()
  await p
}

async function stringifyManyWithJsonRiver(values: unknown[]): Promise<void> {
  const serializer = new JsonSerializer()
  const stringifier = new JsonStringifier()
  const sink = new Writable({ write(_chunk, _enc, cb) { cb() } })

  const p = pipeline(serializer, stringifier, sink)
  for (const v of values) serializer.write(v)
  serializer.end()
  await p
}

async function stringifyWithJsonStreamEs(value: unknown): Promise<void> {
  const reader = serializeJsonValue(value)
    .pipeThrough(new JsonStreamEsStringifier())
    .getReader()

  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

async function stringifyManyWithJsonStreamEs(values: unknown[]): Promise<void> {
  const source = new ReadableStream({
    start(controller) {
      for (const v of values) controller.enqueue(v)
      controller.close()
    },
  })

  const reader = source
    .pipeThrough(new JsonStreamEsSerializer())
    .pipeThrough(new JsonStreamEsStringifier())
    .getReader()

  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

// ---- Benchmarks ----

describe('stringify — simple object', () => {
  bench('native JSON.stringify', () => {
    JSON.stringify(SMALL_OBJECT)
  })

  bench('json-river', async () => {
    await stringifyWithJsonRiver(SMALL_OBJECT)
  })

  bench('json-stream-es', async () => {
    await stringifyWithJsonStreamEs(SMALL_OBJECT)
  })
})

describe('stringify — large object (1000 keys)', () => {
  bench('native JSON.stringify', () => {
    JSON.stringify(LARGE_OBJECT)
  })

  bench('json-river', async () => {
    await stringifyWithJsonRiver(LARGE_OBJECT)
  })

  bench('json-stream-es', async () => {
    await stringifyWithJsonStreamEs(LARGE_OBJECT)
  })
})

describe('stringify — 1000 small objects', () => {
  bench('native JSON.stringify (loop)', () => {
    for (const obj of SMALL_OBJECTS) JSON.stringify(obj)
  })

  bench('json-river (stream)', async () => {
    await stringifyManyWithJsonRiver(SMALL_OBJECTS)
  })

  bench('json-stream-es (stream)', async () => {
    await stringifyManyWithJsonStreamEs(SMALL_OBJECTS)
  })
})

describe('stringify — deeply nested (100 levels)', () => {
  bench('native JSON.stringify', () => {
    JSON.stringify(DEEP_OBJECT)
  })

  bench('json-river', async () => {
    await stringifyWithJsonRiver(DEEP_OBJECT)
  })

  bench('json-stream-es', async () => {
    await stringifyWithJsonStreamEs(DEEP_OBJECT)
  })
})
