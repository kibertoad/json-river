/**
 * Run memory comparison and print results alongside previous baseline.
 *
 * Usage:
 *   node --expose-gc bench/memory-profiler/compare-picks.ts [options] [file]
 *
 * Options:
 *   --multi              Treat file as JSONL (newline-delimited)
 *   --path=<jsonpath>    JSON path to target array (default: "data" for named-array)
 *   --approaches=a,b,c   Comma-separated list of approaches to run
 *   --save               Overwrite the saved baseline with current results
 *   --preset=<name>      Use a built-in preset: "picks" (default) or "jsonl"
 *
 * Presets:
 *   picks   .test-data/large-named-array.json with pick-relevant approaches
 *   jsonl   .test-data/large-jsonl.ndjson with general streaming approaches
 *
 * Examples:
 *   node --expose-gc bench/memory-profiler/compare-picks.ts
 *   node --expose-gc bench/memory-profiler/compare-picks.ts --preset=jsonl
 *   node --expose-gc bench/memory-profiler/compare-picks.ts --approaches=native-json-parse,json-river-reformat .test-data/large-jsonl.ndjson --multi
 */
import { join, resolve } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { runProfile, startServer, formatTable } from 'memory-watchmen/profiler/runner'
import { generateChart } from 'memory-watchmen/profiler/chart'
import type { ProfileResult, ProfileSummary } from 'memory-watchmen'

const PRESETS: Record<string, { file: string; multi: boolean; path?: string; approaches: string[] }> = {
  picks: {
    file: '.test-data/large-named-array.json',
    multi: false,
    path: 'data',
    approaches: [
      'native-json-parse',
      'json-river-parse-inefficient-baseline',
      'json-river-pick-skip-shell',
      'json-river-pick-shell-last',
      'json-river-pick-shell-first',
    ],
  },
  jsonl: {
    file: '.test-data/large-jsonl.ndjson',
    multi: true,
    approaches: [
      'native-json-parse',
      'native-json-stringify',
      'json-river-parse-inefficient-baseline',
      'json-river-reformat',
      'json-river-parse-stringify',
      'json-stream-es-parse',
      'json-stream-es-reformat',
    ],
  },
}

function parseArgs() {
  const args = process.argv.slice(2)

  const presetArg = args.find((a) => a.startsWith('--preset='))
  const presetName = presetArg ? presetArg.split('=')[1] : 'picks'
  const preset = PRESETS[presetName]
  if (!preset) {
    console.error(`Unknown preset: ${presetName}. Available: ${Object.keys(PRESETS).join(', ')}`)
    process.exit(1)
  }

  const fileArg = args.find((a) => !a.startsWith('--'))
  const filePath = resolve(fileArg || preset.file)

  const multi = args.includes('--multi') || (!fileArg && preset.multi)

  const pathArg = args.find((a) => a.startsWith('--path='))
  const path = pathArg ? pathArg.split('=')[1] : (!fileArg ? preset.path : undefined)

  const approachesArg = args.find((a) => a.startsWith('--approaches='))
  const approaches = approachesArg ? approachesArg.split('=')[1].split(',') : preset.approaches

  const save = args.includes('--save')

  return { filePath, multi, path, approaches, save, presetName }
}

function baselineDir(presetName: string): string {
  return join(import.meta.dirname, '..', '..', '.test-data', `${presetName}-comparison`)
}

async function loadBaseline(presetName: string): Promise<ProfileSummary[] | null> {
  try {
    const raw = await readFile(join(baselineDir(presetName), 'summary.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function printComparison(results: ProfileResult[], baseline: ProfileSummary[] | null) {
  console.log('\n=== Current Results ===\n')
  console.log(formatTable(results))

  if (!baseline) {
    console.log('\nNo previous baseline found.')
    return
  }

  console.log('\n=== Comparison vs Baseline ===\n')

  const header = [
    'Approach'.padEnd(45),
    'Peak (old)'.padStart(12),
    'Peak (new)'.padStart(12),
    'Delta (old)'.padStart(12),
    'Delta (new)'.padStart(12),
    'Time (old)'.padStart(12),
    'Time (new)'.padStart(12),
  ].join(' | ')

  const sep = '-'.repeat(header.length)

  console.log(sep)
  console.log(header)
  console.log(sep)

  for (const result of results) {
    const old = baseline.find((b) => b.approach === result.approach)
    const oldPeak = old ? `${old.peakHeapUsedMB} MB` : 'N/A'
    const oldDelta = old ? `${old.deltaHeapUsedMB} MB` : 'N/A'
    const oldTime = old ? `${old.elapsedMs}ms` : 'N/A'

    console.log(
      [
        result.approach.padEnd(45),
        oldPeak.padStart(12),
        `${result.summary.peakHeapUsedMB} MB`.padStart(12),
        oldDelta.padStart(12),
        `${result.summary.deltaHeapUsedMB} MB`.padStart(12),
        oldTime.padStart(12),
        `${result.summary.elapsedMs}ms`.padStart(12),
      ].join(' | '),
    )
  }

  console.log(sep)
}

async function main() {
  const { filePath, multi, path, approaches, save, presetName } = parseArgs()

  console.log(`Preset: ${presetName}`)
  console.log(`File: ${filePath}`)
  console.log(`Multi: ${multi}${path ? `, Path: ${path}` : ''}`)
  console.log(`Approaches: ${approaches.join(', ')}`)
  console.log()

  const serverPath = join(import.meta.dirname, 'server.ts')
  const server = await startServer(serverPath)

  const results: ProfileResult[] = []

  try {
    for (const approach of approaches) {
      process.stdout.write(`  ${approach}...`)
      const result = await runProfile(approach, filePath, multi, undefined, 200, path)
      results.push(result)
      console.log(
        ` peak=${result.summary.peakHeapUsedMB}MB delta=${result.summary.deltaHeapUsedMB}MB time=${result.summary.elapsedMs}ms`,
      )
    }
  } finally {
    server.kill()
  }

  const baseline = await loadBaseline(presetName)
  printComparison(results, baseline)

  if (save) {
    const dir = baselineDir(presetName)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'summary.json'), JSON.stringify(results.map((r) => r.summary), null, 2))

    const html = generateChart(results, { title: `${presetName} comparison` })
    await writeFile(join(dir, 'chart.html'), html)

    console.log(`\nBaseline saved to ${dir}`)
  } else {
    console.log('\nRun with --save to update the baseline.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
