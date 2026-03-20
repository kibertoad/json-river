import { bench, describe } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { JsonParser } from '../src/parser.ts'
import { JsonDeserializer } from '../src/deserializer.ts'

// json-stream-es uses Web Streams (WHATWG)
import { JsonParser as JsonStreamEsParser } from 'json-stream-es/src/json-parser'
import { JsonDeserializer as JsonStreamEsDeserializer } from 'json-stream-es/src/json-deserializer'

// ---- Test data ----

function generateSmallObjects(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({ id: i, name: `user_${i}`, active: i % 2 === 0 }),
  ).join('\n')
}

function generateLargeObject(): string {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < 1000; i++) {
    obj[`key_${i}`] = { value: i, label: `item ${i}`, tags: ['a', 'b', 'c'] }
  }
  return JSON.stringify(obj)
}

function generateDeepNesting(depth: number): string {
  return '['.repeat(depth) + '1' + ']'.repeat(depth)
}

const SMALL_OBJECTS_JSONL = generateSmallObjects(1000)
const LARGE_OBJECT_JSON = generateLargeObject()
const DEEP_NESTING_JSON = generateDeepNesting(100)
const SIMPLE_JSON = '{"name":"Alice","age":30,"active":true,"scores":[95,87,92]}'

// ---- Helpers ----

async function parseWithJsonRiver(json: string, multi = false): Promise<void> {
  await pipeline(
    Readable.from([json]),
    new JsonParser({ multi }),
    new JsonDeserializer(),
    new Writable({ objectMode: true, write(_chunk, _enc, cb) { cb() } }),
  )
}

async function parseWithJsonStreamEs(json: string, multi = false): Promise<void> {
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(json)
      controller.close()
    },
  })

  const reader = stream
    .pipeThrough(new JsonStreamEsParser({ multi }))
    .pipeThrough(new JsonStreamEsDeserializer())
    .getReader()

  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

// ---- Benchmarks ----

describe('parse — simple object', () => {
  bench('native JSON.parse', () => {
    JSON.parse(SIMPLE_JSON)
  })

  bench('json-river', async () => {
    await parseWithJsonRiver(SIMPLE_JSON)
  })

  bench('json-stream-es', async () => {
    await parseWithJsonStreamEs(SIMPLE_JSON)
  })
})

describe('parse — large object (1000 keys)', () => {
  bench('native JSON.parse', () => {
    JSON.parse(LARGE_OBJECT_JSON)
  })

  bench('json-river', async () => {
    await parseWithJsonRiver(LARGE_OBJECT_JSON)
  })

  bench('json-stream-es', async () => {
    await parseWithJsonStreamEs(LARGE_OBJECT_JSON)
  })
})

describe('parse — 1000 JSONL documents', () => {
  bench('native JSON.parse (split + parse each)', () => {
    for (const line of SMALL_OBJECTS_JSONL.split('\n')) {
      JSON.parse(line)
    }
  })

  bench('json-river (multi mode)', async () => {
    await parseWithJsonRiver(SMALL_OBJECTS_JSONL, true)
  })

  bench('json-stream-es (multi mode)', async () => {
    await parseWithJsonStreamEs(SMALL_OBJECTS_JSONL, true)
  })
})

describe('parse — deeply nested (100 levels)', () => {
  bench('native JSON.parse', () => {
    JSON.parse(DEEP_NESTING_JSON)
  })

  bench('json-river', async () => {
    await parseWithJsonRiver(DEEP_NESTING_JSON)
  })

  bench('json-stream-es', async () => {
    await parseWithJsonStreamEs(DEEP_NESTING_JSON)
  })
})
