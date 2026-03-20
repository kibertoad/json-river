/**
 * Memory leak test for the parser under sustained backpressure.
 *
 * Streams a continuous JSONL feed through JsonParser → JsonDeserializer with a
 * slow consumer to create backpressure, then monitors heap over time.
 *
 * This test catches:
 *  - Retained references to parsed tokens or deserialized values
 *  - Growing state accumulation in the parser state machine
 *  - String accumulation not flushed at chunk boundaries
 *  - Internal buffer growth in Transform streams under backpressure
 */
import { describe, it, expect } from "vitest";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonParser } from "../../src/parser.ts";
import { JsonDeserializer } from "../../src/deserializer.ts";
import { forceGC, monitorHeap, formatHeapResult } from "./helpers.ts";

// ~1 KB payload per message — large enough to surface buffer growth over heap noise
const PADDING = "x".repeat(900);

function createJsonLineSource(opts: { stopped: { value: boolean } }): Readable {
  let seq = 0;
  return new Readable({
    read() {
      if (opts.stopped.value) {
        this.push(null);
        return;
      }
      // Emit batches to avoid tight loop overhead
      for (let i = 0; i < 100; i++) {
        const line = JSON.stringify({ id: seq++, padding: PADDING }) + "\n";
        if (!this.push(line)) break;
      }
    },
  });
}

describe("parser memory", () => {
  it("heap must stabilize under sustained backpressure", async () => {
    const stopped = { value: false };
    const source = createJsonLineSource({ stopped });
    const parser = new JsonParser({ multi: true });
    const deserializer = new JsonDeserializer();

    let consumed = 0;
    const slowConsumer = new Writable({
      objectMode: true,
      async write(_value, _enc, callback) {
        consumed++;
        // Slow consumer: ~200ms pause every 500 values to sustain backpressure
        if (consumed % 500 === 0) {
          await sleep(200);
        }
        callback();
      },
    });

    const pipelinePromise = pipeline(
      source,
      parser,
      deserializer,
      slowConsumer,
    ).catch(() => {});

    // Warm-up: let the pipeline enter steady-state backpressure
    forceGC();
    await sleep(3000);

    // Monitor heap
    const result = await monitorHeap({
      sampleCount: 15,
      sampleIntervalMs: 1500,
    });

    // Cleanup
    stopped.value = true;
    source.destroy();
    await pipelinePromise;

    expect(
      result.passed,
      formatHeapResult(result, `parser backpressure, consumed ${consumed}`),
    ).toBe(true);
  });
});
