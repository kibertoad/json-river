/**
 * Memory profiling runner.
 *
 * Runs each approach against each test file via the memory-watchmen profiler,
 * collects memory samples, and produces a consolidated report + chart data.
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
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runProfiles, startServer } from 'memory-watchmen/profiler/runner'

async function main() {
  const preset = process.argv[2] || 'medium'
  const testDataDir = join(import.meta.dirname, '..', '..', '.test-data')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outputDir = join(testDataDir, 'profile-results', timestamp)

  // Check test data exists
  let fileNames: string[]
  try {
    const entries = await readdir(testDataDir)
    fileNames = entries.filter(f => f.startsWith(preset) && (f.endsWith('.json') || f.endsWith('.ndjson')))
  } catch {
    console.error(`No test data found. Run first: node bench/memory-profiler/generate-json.ts ${preset}`)
    process.exit(1)
  }

  if (fileNames.length === 0) {
    console.error(`No ${preset} test data found. Run: node bench/memory-profiler/generate-json.ts ${preset}`)
    process.exit(1)
  }

  const generalApproaches = ['native-json-parse', 'native-json-stringify', 'json-river-parse-inefficient-baseline', 'json-river-parse-inefficient-baseline-stringify', 'json-stream-es-parse']
  const namedArrayApproaches = ['native-json-parse', 'json-river-parse-inefficient-baseline', 'json-river-pick-skip-shell', 'json-river-pick-shell-last', 'json-river-pick-shell-first']

  // Build file descriptors with approach filtering
  const files: { path: string; multi?: boolean; jsonPath?: string }[] = []
  const approachSet = new Set<string>()

  for (const fileName of fileNames) {
    const filePath = join(testDataDir, fileName)
    const multi = fileName.endsWith('.ndjson')
    const isNamedArray = fileName.includes('named-array')
    const approaches = isNamedArray ? namedArrayApproaches : generalApproaches
    const jsonPath = isNamedArray ? 'data' : undefined

    files.push({ path: filePath, multi, jsonPath })
    for (const a of approaches) {
      // Skip stringify on non-JSONL files (requires full parse first, too slow for large objects)
      if (a === 'native-json-stringify' && !multi) continue
      // Skip reformat on large single objects — not a meaningful use case there
      if (a.includes('reformat') && fileName.includes('large-object')) continue
      approachSet.add(a)
    }
  }

  console.log('Starting memory profiler server...')
  const serverPath = join(import.meta.dirname, 'server.ts')
  const server = await startServer(serverPath)

  try {
    const results = await runProfiles({
      approaches: [...approachSet],
      files,
      outputDir,
      sampleIntervalMs: 200,
    })

    console.log(`\nResults saved to: ${outputDir}`)
    console.log(`  summary.json    — consolidated summaries`)
    console.log(`  chart-data.json — time-series data for charting`)
    console.log(`  report.txt      — comparison table`)
    console.log(`  samples/        — raw NDJSON per run`)

    return results
  } finally {
    server.kill()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
