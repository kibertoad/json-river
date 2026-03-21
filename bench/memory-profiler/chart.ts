/**
 * Memory comparison chart generator.
 *
 * Connects to the profile server, runs each approach against a test file,
 * collects time-series memory snapshots, and generates an HTML chart
 * comparing heap usage over time across all approaches.
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

const DEFAULT_PORT = 3847
const BASE_URL = `http://localhost:${DEFAULT_PORT}`

interface Sample {
  timestamp: number
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
}

interface Summary {
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

interface RunResult {
  approach: string
  samples: Sample[]
  summary: Summary
}

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

async function runApproach(approach: string, filePath: string, multi: boolean, intervalMs: number, path?: string): Promise<RunResult> {
  const res = await fetch(`${BASE_URL}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approach, filePath, multi, path, sampleIntervalMs: intervalMs }),
  })

  if (!res.ok) {
    throw new Error(`Profile request failed: ${res.status} ${await res.text()}`)
  }

  const text = await res.text()
  const lines = text.trim().split('\n').map(l => JSON.parse(l))

  const samples: Sample[] = []
  let summary: Summary | undefined

  for (const line of lines) {
    if (line.summary) summary = line
    else if (!line.error) samples.push(line)
  }

  if (!summary) throw new Error(`No summary for ${approach}`)

  return { approach, samples, summary }
}

function generateHtml(results: RunResult[], filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop()

  // Normalize timestamps to relative milliseconds
  const series = results.map(r => {
    const t0 = r.samples[0]?.timestamp ?? 0
    return {
      label: r.approach,
      peakMB: r.summary.peakHeapUsedMB,
      deltaMB: r.summary.deltaHeapUsedMB,
      elapsedMs: r.summary.elapsedMs,
      points: r.samples.map(s => ({
        t: s.timestamp - t0,
        heapMB: Math.round((s.heapUsed / (1024 * 1024)) * 100) / 100,
        rssMB: Math.round((s.rss / (1024 * 1024)) * 100) / 100,
      })),
    }
  })

  const colors = [
    '#2563eb', // blue
    '#dc2626', // red
    '#16a34a', // green
    '#9333ea', // purple
    '#ea580c', // orange
  ]

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Memory Profile: ${fileName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: #64748b; margin-bottom: 24px; }
  .chart-container { background: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 24px; }
  canvas { width: 100%; height: 400px; }
  .legend { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 16px; }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 0.875rem; }
  .legend-color { width: 16px; height: 3px; border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; font-size: 0.875rem; color: #475569; }
  td { font-size: 0.875rem; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
</style>
</head>
<body>
<h1>Memory Profile Comparison</h1>
<p class="subtitle">File: ${fileName} (${results[0]?.summary.fileSizeMB ?? '?'} MB)</p>

<div class="chart-container">
  <canvas id="heapChart"></canvas>
  <div class="legend" id="legend"></div>
</div>

<table>
  <thead>
    <tr>
      <th>Approach</th>
      <th>Baseline (MB)</th>
      <th>Peak (MB)</th>
      <th>Delta (MB)</th>
      <th>Duration (ms)</th>
      <th>Samples</th>
    </tr>
  </thead>
  <tbody>
    ${results.map(r => `<tr>
      <td>${r.approach}</td>
      <td>${r.summary.baselineHeapUsedMB.toFixed(1)}</td>
      <td>${r.summary.peakHeapUsedMB.toFixed(1)}</td>
      <td>${r.summary.deltaHeapUsedMB.toFixed(1)}</td>
      <td>${r.summary.elapsedMs}</td>
      <td>${r.summary.totalSamples}</td>
    </tr>`).join('\n    ')}
  </tbody>
</table>

<script>
const series = ${JSON.stringify(series)};
const colors = ${JSON.stringify(colors)};

const canvas = document.getElementById('heapChart');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;

function draw() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 20, right: 20, bottom: 40, left: 60 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Find ranges
  let maxT = 0, minMB = Infinity, maxMB = 0;
  for (const s of series) {
    for (const p of s.points) {
      if (p.t > maxT) maxT = p.t;
      if (p.heapMB < minMB) minMB = p.heapMB;
      if (p.heapMB > maxMB) maxMB = p.heapMB;
    }
  }
  // Add padding
  const rangeMB = maxMB - minMB || 1;
  minMB = Math.max(0, minMB - rangeMB * 0.1);
  maxMB = maxMB + rangeMB * 0.1;
  maxT = maxT || 1000;

  const scaleX = (t) => pad.left + (t / maxT) * plotW;
  const scaleY = (mb) => pad.top + plotH - ((mb - minMB) / (maxMB - minMB)) * plotH;

  // Background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const mb = minMB + (maxMB - minMB) * (i / yTicks);
    const y = scaleY(mb);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(mb.toFixed(1) + ' MB', pad.left - 8, y + 4);
  }

  const xTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const t = maxT * (i / xTicks);
    const x = scaleX(t);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, h - pad.bottom);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText((t / 1000).toFixed(1) + 's', x, h - pad.bottom + 16);
  }

  // Draw series
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const color = colors[i % colors.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let j = 0; j < s.points.length; j++) {
      const p = s.points[j];
      const x = scaleX(p.t);
      const y = scaleY(p.heapMB);
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Legend
  const legendEl = document.getElementById('legend');
  legendEl.innerHTML = series.map((s, i) =>
    '<div class="legend-item">' +
    '<div class="legend-color" style="background:' + colors[i % colors.length] + '"></div>' +
    '<span>' + s.label + ' (peak: ' + s.peakMB.toFixed(1) + ' MB, delta: ' + s.deltaMB.toFixed(1) + ' MB)</span>' +
    '</div>'
  ).join('');
}

draw();
window.addEventListener('resize', draw);
</script>
</body>
</html>`;
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

  const results: RunResult[] = []

  for (const approach of approaches) {
    process.stdout.write(`  ${approach}...`)
    try {
      const result = await runApproach(approach, filePath, multi, intervalMs, path)
      results.push(result)
      console.log(` peak=${result.summary.peakHeapUsedMB}MB delta=${result.summary.deltaHeapUsedMB}MB time=${result.summary.elapsedMs}ms`)
    } catch (err: any) {
      console.log(` ERROR: ${err.message}`)
    }
  }

  if (results.length === 0) {
    console.error('No successful profiles.')
    process.exit(1)
  }

  // Write results into output directory
  const outDir = resolve(output)
  await mkdir(outDir, { recursive: true })

  const html = generateHtml(results, filePath)
  await writeFile(join(outDir, 'chart.html'), html)

  const summaries = results.map(r => r.summary)
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summaries, null, 2))

  // Time-series data for external charting tools
  const chartData = results.map(r => {
    const t0 = r.samples[0]?.timestamp ?? 0
    return {
      approach: r.approach,
      series: r.samples.map(s => ({
        t: s.timestamp - t0,
        heapUsedMB: Math.round((s.heapUsed / (1024 * 1024)) * 100) / 100,
        rssMB: Math.round((s.rss / (1024 * 1024)) * 100) / 100,
      })),
    }
  })
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
