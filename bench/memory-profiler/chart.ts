/**
 * Memory comparison chart generator.
 *
 * Connects to the profile server, runs each approach against a test file,
 * and generates an HTML chart comparing heap usage over time.
 *
 * Usage:
 *   # Start the server first:
 *   node --expose-gc bench/memory-profiler/server.ts
 *
 *   # Then run this script:
 *   node bench/memory-profiler/chart.ts <filePath> [--multi] [--interval=200] [--output=results]
 *
 * Examples:
 *   node bench/memory-profiler/chart.ts .test-data/medium-jsonl.ndjson --multi
 *   node bench/memory-profiler/chart.ts .test-data/medium-large-object.json
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runProfile, buildChartData } from 'memory-watchmen/profiler/runner'
import { generateChart } from 'memory-watchmen/profiler/chart'
import type { ProfileResult } from 'memory-watchmen'

const BASE_URL = 'http://localhost:3847'

function parseArgs(): { filePath: string; multi: boolean; path: string | undefined; intervalMs: number; output: string; approaches: string[] | undefined } {
  const args = process.argv.slice(2)
  const filePath = args.find(a => !a.startsWith('--'))
  if (!filePath) {
    console.error('Usage: node bench/memory-profiler/chart.ts <filePath> [--multi] [--path=data] [--interval=200] [--output=results] [--approaches=a,b,c]')
    process.exit(1)
  }

  const multi = args.includes('--multi')
  const pathArg = args.find(a => a.startsWith('--path='))
  const path = pathArg ? pathArg.split('=')[1] : undefined
  const intervalArg = args.find(a => a.startsWith('--interval='))
  const intervalMs = intervalArg ? parseInt(intervalArg.split('=')[1], 10) : 200
  const outputArg = args.find(a => a.startsWith('--output='))
  const output = outputArg ? outputArg.split('=')[1] : 'results'
  const approachesArg = args.find(a => a.startsWith('--approaches='))
  const approaches = approachesArg ? approachesArg.split('=')[1].split(',') : undefined

  return { filePath: resolve(filePath), multi, path, intervalMs, output, approaches }
}

async function main() {
  const { filePath, multi, path, intervalMs, output, approaches: requestedApproaches } = parseArgs()

  // Get available approaches
  let approaches: string[]
  try {
    const res = await fetch(`${BASE_URL}/approaches`)
    approaches = await res.json() as string[]
  } catch {
    console.error('Cannot connect to profiler server. Start it first:')
    console.error('  node --expose-gc bench/memory-profiler/server.ts')
    process.exit(1)
  }

  if (requestedApproaches) {
    approaches = approaches.filter(a => requestedApproaches.includes(a))
  }

  console.log(`Profiling: ${filePath}`)
  console.log(`Approaches: ${approaches.join(', ')}`)
  console.log(`Interval: ${intervalMs}ms, Multi: ${multi}${path ? `, Path: ${path}` : ''}\n`)

  const results: ProfileResult[] = []

  for (const approach of approaches) {
    process.stdout.write(`  ${approach}...`)
    try {
      const result = await runProfile(approach, filePath, multi, BASE_URL, intervalMs, path)
      results.push(result)
      console.log(` peak=${result.summary.peakHeapUsedMB}MB delta=${result.summary.deltaHeapUsedMB}MB time=${result.summary.elapsedMs}ms`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(` ERROR: ${message}`)
    }
  }

  if (results.length === 0) {
    console.error('No successful profiles.')
    process.exit(1)
  }

  // Write results into output directory
  const outDir = resolve(output)
  await mkdir(outDir, { recursive: true })

  const html = generateChart(results)
  await writeFile(join(outDir, 'chart.html'), html)

  const summaries = results.map(r => r.summary)
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summaries, null, 2))

  const chartData = buildChartData(results)
  await writeFile(join(outDir, 'chart-data.json'), JSON.stringify(chartData, null, 2))

  // Raw samples per approach
  const samplesDir = join(outDir, 'samples')
  await mkdir(samplesDir, { recursive: true })
  for (const r of results) {
    await writeFile(
      join(samplesDir, `${r.approach}.ndjson`),
      r.samples.map(s => JSON.stringify(s)).join('\n') + '\n',
    )
  }

  console.log(`\nResults written to: ${outDir}/`)
  console.log(`  chart.html       — comparison chart`)
  console.log(`  summary.json     — peak/baseline/delta per approach`)
  console.log(`  chart-data.json  — time-series for external tools`)
  console.log(`  samples/         — raw NDJSON per approach`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
