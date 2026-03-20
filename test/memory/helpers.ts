import { setTimeout as sleep } from "node:timers/promises";

/**
 * Double GC — Node may need multiple passes for closures, weak refs, etc.
 * Pattern from undici tls-cert-leak.js.
 */
export function forceGC(): void {
  global.gc!();
  global.gc!();
}

export interface HeapMonitorOptions {
  /** Number of monitoring samples to collect (default: 15) */
  sampleCount?: number;
  /** Milliseconds between samples (default: 1500) */
  sampleIntervalMs?: number;
  /** Max consecutive growth samples before declaring monotonic leak (default: 10) */
  maxConsecutiveGrowth?: number;
  /** Max MB of envelope drift between first and last third (default: 15) */
  maxEnvelopeGrowthMB?: number;
}

export interface HeapMonitorResult {
  samples: number[];
  samplesMB: number[];
  consecutiveGrowth: number;
  stabilized: boolean;
  envelopeGrowthMB: number;
  monotonicLeak: boolean;
  envelopeLeak: boolean;
  passed: boolean;
}

/**
 * Monitor heap usage over time and apply dual-assertion checks.
 *
 * Two complementary checks (borrowed from kafka-plt):
 * 1. Monotonic growth: heap grew every sample for N+ consecutive checks → tight leak
 * 2. Envelope growth: first-third avg vs last-third avg → step-wise/burst leaks
 */
export async function monitorHeap(
  options?: HeapMonitorOptions,
): Promise<HeapMonitorResult> {
  const sampleCount = options?.sampleCount ?? 15;
  const sampleIntervalMs = options?.sampleIntervalMs ?? 1500;
  const maxConsecutiveGrowth = options?.maxConsecutiveGrowth ?? 10;
  const maxEnvelopeGrowthMB = options?.maxEnvelopeGrowthMB ?? 15;

  const samples: number[] = [];

  // Baseline — not counted toward growth detection
  forceGC();
  samples.push(process.memoryUsage().heapUsed);

  let consecutiveGrowth = 0;
  let stabilized = false;

  for (let i = 0; i < sampleCount; i++) {
    await sleep(sampleIntervalMs);

    forceGC();
    const heap = process.memoryUsage().heapUsed;
    samples.push(heap);

    const prevHeap = samples[samples.length - 2]!;
    if (heap <= prevHeap) {
      stabilized = true;
      consecutiveGrowth = 0;
    } else {
      consecutiveGrowth++;
    }
  }

  // Envelope growth: compare first-third avg to last-third avg
  const thirdLen = Math.floor(samples.length / 3);
  const firstThird = samples.slice(1, 1 + thirdLen);
  const lastThird = samples.slice(-thirdLen);
  const avgFirst = firstThird.reduce((a, b) => a + b, 0) / firstThird.length;
  const avgLast = lastThird.reduce((a, b) => a + b, 0) / lastThird.length;
  const envelopeGrowthMB = (avgLast - avgFirst) / (1024 * 1024);

  const monotonicLeak =
    !stabilized && consecutiveGrowth >= maxConsecutiveGrowth;
  const envelopeLeak = envelopeGrowthMB > maxEnvelopeGrowthMB;

  return {
    samples,
    samplesMB: samples.map((s) => Math.round((s / (1024 * 1024)) * 10) / 10),
    consecutiveGrowth,
    stabilized,
    envelopeGrowthMB,
    monotonicLeak,
    envelopeLeak,
    passed: !monotonicLeak && !envelopeLeak,
  };
}

export function formatHeapResult(
  result: HeapMonitorResult,
  context?: string,
): string {
  const parts: string[] = [];
  if (result.monotonicLeak) parts.push("heap grew monotonically");
  if (result.envelopeLeak)
    parts.push(`envelope grew ${result.envelopeGrowthMB.toFixed(1)} MB`);
  return (
    "Possible memory leak" +
    (context ? ` (${context})` : "") +
    ": " +
    parts.join("; ") +
    `. Samples (MB): [${result.samplesMB.join(", ")}].`
  );
}
