/**
 * Memory profiling runner.
 *
 * Runs each approach against each test file in a separate child process,
 * collects memory samples via the HTTP profiler server, and produces
 * a consolidated report + chart data.
 *
 * Usage:
 *   # First generate test data:
 *   node bench/memory-profiler/generate-json.ts medium
 *
 *   # Then run the profiler (starts server automatically):
 *   npx tsx bench/memory-profiler/run-profile.ts [preset]
 *
 * Output:
 *   .test-data/profile-results/<timestamp>/
 *     samples/           — raw NDJSON sample files per approach+file
 *     summary.json       — consolidated summaries
 *     chart-data.json    — time-series data ready for charting
 *     report.txt         — human-readable comparison table
 */
import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 3847
const BASE_URL = `http://localhost:${PORT}`

interface SampleLine {
  timestamp: number
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
}

interface SummaryLine {
  summary: true
  approach: string
  file: string
  fileSizeMB: number
  peakHeapUsedMB: number
  baselineHeapUsedMB: number
  deltaHeapUsedMB: number
  totalSamples: number
  elapsedMs: number
}

interface ProfileResult {
  approach: string
  file: string
  samples: SampleLine[]
  summary: SummaryLine
}

async function startServer(): Promise<ChildProcess> {
  const serverPath = join(import.meta.dirname, 'server.ts')
  const child = fork(serverPath, [String(PORT)], {
    execArgv: ['--expose-gc'],
    stdio: 'pipe',
  })

  // Wait for server to start
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10_000)
    child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString()
      if (msg.includes('listening')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    child.stderr?.on('data', (data: Buffer) => {
      console.error('[server stderr]', data.toString())
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error(`Server exited with code ${code}`))
    })
  })

  return child
}

async function runProfile(approach: string, filePath: string, multi: boolean, path?: string): Promise<ProfileResult> {
  const res = await fetch(`${BASE_URL}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approach, filePath, multi, path, sampleIntervalMs: 200 }),
  })

  if (!res.ok) {
    throw new Error(`Profile request failed: ${res.status} ${await res.text()}`)
  }

  const text = await res.text()
  const lines = text.trim().split('\n').map(l => JSON.parse(l))

  const samples: SampleLine[] = []
  let summary: SummaryLine | undefined

  for (const line of lines) {
    if (line.summary) {
      summary = line
    } else if (line.error) {
      throw new Error(`Profile error: ${line.error}`)
    } else {
      samples.push(line)
    }
  }

  if (!summary) throw new Error('No summary received')

  return { approach, file: filePath, samples, summary }
}

function formatTable(results: ProfileResult[]): string {
  const rows = results.map(r => ({
    Approach: r.summary.approach,
    File: r.summary.file.split('/').pop() || r.summary.file,
    'Size (MB)': r.summary.fileSizeMB.toFixed(1),
    'Baseline (MB)': r.summary.baselineHeapUsedMB.toFixed(1),
    'Peak (MB)': r.summary.peakHeapUsedMB.toFixed(1),
    'Delta (MB)': r.summary.deltaHeapUsedMB.toFixed(1),
    'Time (ms)': String(r.summary.elapsedMs),
    Samples: String(r.summary.totalSamples),
  }))

  // Calculate column widths
  const headers = Object.keys(rows[0])
  const widths = headers.map(h =>
    Math.max(h.length, ...rows.map(r => String(r[h as keyof typeof r]).length)),
  )

  const sep = widths.map(w => '-'.repeat(w + 2)).join('+')
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('|')
  const dataLines = rows.map(r =>
    headers.map((h, i) => ` ${String(r[h as keyof typeof r]).padEnd(widths[i])} `).join('|'),
  )

  return [sep, headerLine, sep, ...dataLines, sep].join('\n')
}

function buildChartData(results: ProfileResult[]): object {
  // Normalize timestamps to relative (starting from 0)
  return results.map(r => {
    const t0 = r.samples[0]?.timestamp ?? 0
    return {
      approach: r.summary.approach,
      file: r.summary.file.split('/').pop(),
      fileSizeMB: r.summary.fileSizeMB,
      elapsedMs: r.summary.elapsedMs,
      series: r.samples.map(s => ({
        t: s.timestamp - t0,
        heapUsedMB: Math.round((s.heapUsed / (1024 * 1024)) * 10) / 10,
        rssMB: Math.round((s.rss / (1024 * 1024)) * 10) / 10,
      })),
    }
  })
}

async function main() {
  const preset = process.argv[2] || 'medium'
  const testDataDir = join(import.meta.dirname, '..', '..', '.test-data')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outputDir = join(testDataDir, 'profile-results', timestamp)

  await mkdir(join(outputDir, 'samples'), { recursive: true })

  // Check test data exists
  let files: string[]
  try {
    const entries = await readdir(testDataDir)
    files = entries.filter(f => f.startsWith(preset) && (f.endsWith('.json') || f.endsWith('.ndjson')))
  } catch {
    console.error(`No test data found. Run first: node bench/memory-profiler/generate-json.ts ${preset}`)
    process.exit(1)
  }

  if (files.length === 0) {
    console.error(`No ${preset} test data found. Run: node bench/memory-profiler/generate-json.ts ${preset}`)
    process.exit(1)
  }

  console.log(`Starting memory profiler server...`)
  const server = await startServer()

  const generalApproaches = ['native-json-parse', 'native-json-stringify', 'json-river-parse-inefficient-baseline', 'json-river-parse-inefficient-baseline-stringify', 'json-stream-es-parse']
  const namedArrayApproaches = ['native-json-parse', 'json-river-parse-inefficient-baseline', 'json-river-pick-skip-shell', 'json-river-pick-shell-last', 'json-river-pick-shell-first']
  const results: ProfileResult[] = []

  try {
    for (const file of files) {
      const filePath = join(testDataDir, file)
      const multi = file.endsWith('.ndjson')
      const isNamedArray = file.includes('named-array')
      const approaches = isNamedArray ? namedArrayApproaches : generalApproaches
      const path = isNamedArray ? 'data' : undefined

      for (const approach of approaches) {
        // Skip stringify on non-JSONL files (requires full parse first, too slow for large objects)
        if (approach === 'native-json-stringify' && !multi) continue
        // Skip reformat on large single objects — not a meaningful use case there
        if (approach.includes('reformat') && file.includes('large-object')) continue

        console.log(`  Profiling: ${approach} + ${file}...`)

        try {
          const result = await runProfile(approach, filePath, multi, path)
          results.push(result)

          // Save raw samples
          const sampleFile = join(outputDir, 'samples', `${approach}_${file.replace(/\./g, '_')}.ndjson`)
          await writeFile(sampleFile, result.samples.map(s => JSON.stringify(s)).join('\n'))

          console.log(`    Peak: ${result.summary.peakHeapUsedMB} MB, Delta: ${result.summary.deltaHeapUsedMB} MB, Time: ${result.summary.elapsedMs}ms`)
        } catch (err: any) {
          console.error(`    Error: ${err.message}`)
        }

        // Brief pause between profiles to let GC settle
        await sleep(1000)
      }
    }

    // Write consolidated output
    const summaryPath = join(outputDir, 'summary.json')
    await writeFile(summaryPath, JSON.stringify(results.map(r => r.summary), null, 2))

    const chartDataPath = join(outputDir, 'chart-data.json')
    await writeFile(chartDataPath, JSON.stringify(buildChartData(results), null, 2))

    const reportPath = join(outputDir, 'report.txt')
    const report = formatTable(results)
    await writeFile(reportPath, report)

    console.log('\n' + report)
    console.log(`\nResults saved to: ${outputDir}`)
    console.log(`  summary.json    — consolidated summaries`)
    console.log(`  chart-data.json — time-series data for charting`)
    console.log(`  report.txt      — comparison table`)
    console.log(`  samples/        — raw NDJSON per run`)
  } finally {
    server.kill()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
