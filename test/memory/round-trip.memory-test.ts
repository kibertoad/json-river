/**
 * Memory leak test for the full serialize → stringify → parse → deserialize pipeline.
 *
 * Exercises every component under sustained backpressure. Verifies that the
 * full round-trip pipeline does not accumulate memory over time.
 *
 * This test catches:
 *  - Token object accumulation between serializer and stringifier
 *  - String buffer growth between stringifier and parser
 *  - Deserialized value retention in the deserializer
 *  - Backpressure propagation failures across the 4-stage pipeline
 */
import { describe, it, expect } from "vitest";
import {
  Readable,
  Writable,
  Transform,
  type TransformCallback,
} from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonParser } from "../../src/parser.ts";
import { JsonStringifier } from "../../src/stringifier.ts";
import { JsonSerializer } from "../../src/serializer.ts";
import { JsonDeserializer } from "../../src/deserializer.ts";
import { forceGC, monitorHeap, formatHeapResult } from "memory-watchmen";

const PADDING = "x".repeat(900);

function createValueSource(opts: { stopped: { value: boolean } }): Readable {
  let seq = 0;
  return new Readable({
    objectMode: true,
    read() {
      if (opts.stopped.value) {
        this.push(null);
        return;
      }
      for (let i = 0; i < 50; i++) {
        const value = {
          id: seq++,
          padding: PADDING,
          nested: { arr: [1, 2, 3] },
        };
        if (!this.push(value)) break;
      }
    },
  });
}

/**
 * Inserts newlines between serialized JSON documents so the parser can
 * handle them in multi mode.
 */
class NewlineDelimiter extends Transform {
  #first = true;

  constructor() {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.#first) {
      this.#first = false;
    } else {
      this.push("\n");
    }
    this.push(chunk);
    callback();
  }
}

describe("round-trip memory", () => {
  it("heap must stabilize during full round-trip pipeline", async () => {
    const stopped = { value: false };
    const source = createValueSource({ stopped });

    let consumed = 0;
    const slowConsumer = new Writable({
      objectMode: true,
      async write(_value, _enc, callback) {
        consumed++;
        if (consumed % 200 === 0) {
          await sleep(200);
        }
        callback();
      },
    });

    const pipelinePromise = pipeline(
      source,
      new JsonSerializer(),
      new JsonStringifier(),
      new NewlineDelimiter(),
      new JsonParser({ multi: true }),
      new JsonDeserializer(),
      slowConsumer,
    ).catch(() => {});

    forceGC();
    await sleep(3000);

    const result = await monitorHeap({
      sampleCount: 15,
      sampleIntervalMs: 1500,
    });

    stopped.value = true;
    source.destroy();
    await pipelinePromise;

    expect(
      result.passed,
      formatHeapResult(result, `round-trip pipeline, consumed ${consumed}`),
    ).toBe(true);
  });
});
