/**
 * Memory stress tests for edge cases: large strings, deep nesting, massive arrays.
 *
 * These tests verify that the parser properly flushes intermediate state and
 * does not retain references to already-emitted data. Each test processes
 * a volume of data much larger than acceptable heap growth.
 */
import { describe, it, expect } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { JsonParser } from '../../src/parser.ts'
import { JsonDeserializer } from '../../src/deserializer.ts'
import { forceGC, monitorHeap, formatHeapResult } from './helpers.ts'

describe('large values memory', () => {
  it('large strings: parser flushes chunks and does not retain full string', async () => {
    // Each object has a 100KB string value. Process 200 objects (~20MB total).
    // If the parser retains string data, heap will grow linearly.
    const largeString = 'A'.repeat(100_000)
    const stopped = { value: false }
    let seq = 0

    const source = new Readable({
      read() {
        if (stopped.value) { this.push(null); return }
        for (let i = 0; i < 5; i++) {
          const line = JSON.stringify({ id: seq++, data: largeString }) + '\n'
          if (!this.push(line)) break
        }
      },
    })

    let consumed = 0
    const consumer = new Writable({
      objectMode: true,
      async write(_value, _enc, callback) {
        consumed++
        if (consumed % 20 === 0) await sleep(100)
        callback()
      },
    })

    const pipelinePromise = pipeline(
      source,
      new JsonParser({ multi: true }),
      new JsonDeserializer(),
      consumer,
    ).catch(() => {})

    forceGC()
    await sleep(3000)

    const result = await monitorHeap({ sampleCount: 12, sampleIntervalMs: 1500 })

    stopped.value = true
    source.destroy()
    await pipelinePromise

    expect(result.passed, formatHeapResult(result, `large strings, consumed ${consumed}`)).toBe(true)
  })

  it('deep nesting: parser stack does not leak across documents', async () => {
    // Each document is a 50-level deep nested array containing a single number.
    // Process many documents and verify the parser stack is properly unwound.
    const depth = 50
    const template = '['.repeat(depth) + '1' + ']'.repeat(depth)
    const stopped = { value: false }

    const source = new Readable({
      read() {
        if (stopped.value) { this.push(null); return }
        for (let i = 0; i < 100; i++) {
          if (!this.push(template + '\n')) break
        }
      },
    })

    let consumed = 0
    const consumer = new Writable({
      objectMode: true,
      async write(_value, _enc, callback) {
        consumed++
        if (consumed % 500 === 0) await sleep(100)
        callback()
      },
    })

    const pipelinePromise = pipeline(
      source,
      new JsonParser({ multi: true }),
      new JsonDeserializer(),
      consumer,
    ).catch(() => {})

    forceGC()
    await sleep(3000)

    const result = await monitorHeap({ sampleCount: 12, sampleIntervalMs: 1500 })

    stopped.value = true
    source.destroy()
    await pipelinePromise

    expect(result.passed, formatHeapResult(result, `deep nesting, consumed ${consumed}`)).toBe(true)
  })

  it('many small documents: no per-document overhead accumulates', async () => {
    // Tiny documents — tests that per-value overhead (state objects, closures) is constant.
    const stopped = { value: false }
    let seq = 0

    const source = new Readable({
      read() {
        if (stopped.value) { this.push(null); return }
        for (let i = 0; i < 500; i++) {
          if (!this.push(`${seq++}\n`)) break
        }
      },
    })

    let consumed = 0
    const consumer = new Writable({
      objectMode: true,
      async write(_value, _enc, callback) {
        consumed++
        if (consumed % 5000 === 0) await sleep(100)
        callback()
      },
    })

    const pipelinePromise = pipeline(
      source,
      new JsonParser({ multi: true }),
      new JsonDeserializer(),
      consumer,
    ).catch(() => {})

    forceGC()
    await sleep(2000)

    const result = await monitorHeap({ sampleCount: 12, sampleIntervalMs: 1000 })

    stopped.value = true
    source.destroy()
    await pipelinePromise

    expect(result.passed, formatHeapResult(result, `many small docs, consumed ${consumed}`)).toBe(true)
  })

  it('wide objects: many keys per object do not leak across documents', async () => {
    // Objects with 100 keys each. Verifies the deserializer releases object references.
    const stopped = { value: false }
    let seq = 0

    function buildWideObject(): string {
      const obj: Record<string, number> = {}
      for (let i = 0; i < 100; i++) {
        obj[`key_${i}`] = seq++
      }
      return JSON.stringify(obj)
    }

    const source = new Readable({
      read() {
        if (stopped.value) { this.push(null); return }
        for (let i = 0; i < 20; i++) {
          if (!this.push(buildWideObject() + '\n')) break
        }
      },
    })

    let consumed = 0
    const consumer = new Writable({
      objectMode: true,
      async write(_value, _enc, callback) {
        consumed++
        if (consumed % 100 === 0) await sleep(100)
        callback()
      },
    })

    const pipelinePromise = pipeline(
      source,
      new JsonParser({ multi: true }),
      new JsonDeserializer(),
      consumer,
    ).catch(() => {})

    forceGC()
    await sleep(3000)

    const result = await monitorHeap({ sampleCount: 12, sampleIntervalMs: 1500 })

    stopped.value = true
    source.destroy()
    await pipelinePromise

    expect(result.passed, formatHeapResult(result, `wide objects, consumed ${consumed}`)).toBe(true)
  })
})
