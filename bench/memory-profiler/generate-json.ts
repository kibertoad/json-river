/**
 * Large JSON file generator for memory profiling.
 *
 * Generates JSON files of configurable size with realistic structure:
 * - Single large object with many keys
 * - Array of many small objects (JSONL-friendly)
 * - Deeply nested structure
 * - Large string values
 *
 * Usage:
 *   npx tsx bench/memory-profiler/generate-json.ts [preset] [outputDir]
 *
 * Presets: small (1MB), medium (10MB), large (50MB), xlarge (200MB)
 */
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

interface GeneratorConfig {
  /** Number of objects in the JSONL array */
  objectCount: number
  /** Number of keys per object */
  keysPerObject: number
  /** Size of string values in bytes */
  stringValueSize: number
  /** Nesting depth for deep structure */
  nestingDepth: number
  /** Number of large string objects */
  largeStringCount: number
  /** Size of each large string in bytes */
  largeStringSize: number
}

const PRESETS: Record<string, GeneratorConfig> = {
  small: {
    objectCount: 1_000,
    keysPerObject: 10,
    stringValueSize: 50,
    nestingDepth: 20,
    largeStringCount: 10,
    largeStringSize: 10_000,
  },
  medium: {
    objectCount: 10_000,
    keysPerObject: 15,
    stringValueSize: 50,
    nestingDepth: 50,
    largeStringCount: 50,
    largeStringSize: 50_000,
  },
  large: {
    objectCount: 50_000,
    keysPerObject: 20,
    stringValueSize: 100,
    nestingDepth: 100,
    largeStringCount: 100,
    largeStringSize: 100_000,
  },
  xlarge: {
    objectCount: 200_000,
    keysPerObject: 25,
    stringValueSize: 200,
    nestingDepth: 200,
    largeStringCount: 200,
    largeStringSize: 200_000,
  },
}

function generateRandomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

/**
 * Generate a JSONL file with many small objects.
 */
async function generateJsonl(filepath: string, config: GeneratorConfig): Promise<void> {
  const stream = createWriteStream(filepath)
  const padding = generateRandomString(config.stringValueSize)

  for (let i = 0; i < config.objectCount; i++) {
    const obj: Record<string, unknown> = { id: i }
    for (let k = 0; k < config.keysPerObject - 1; k++) {
      obj[`field_${k}`] = k % 3 === 0 ? i * k : k % 3 === 1 ? (k % 2 === 0) : `${padding}_${i}_${k}`
    }
    const line = JSON.stringify(obj) + '\n'
    if (!stream.write(line)) {
      await new Promise<void>(resolve => stream.once('drain', resolve))
    }
  }

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
}

/**
 * Generate a single large JSON object.
 */
async function generateLargeObject(filepath: string, config: GeneratorConfig): Promise<void> {
  const stream = createWriteStream(filepath)

  stream.write('{')
  for (let i = 0; i < config.objectCount; i++) {
    if (i > 0) stream.write(',')
    const value: Record<string, unknown> = {
      index: i,
      label: generateRandomString(config.stringValueSize),
      active: i % 2 === 0,
      score: Math.random() * 100,
      tags: ['tag_a', 'tag_b', 'tag_c'],
    }
    const entry = `${JSON.stringify(`key_${i}`)}:${JSON.stringify(value)}`
    if (!stream.write(entry)) {
      await new Promise<void>(resolve => stream.once('drain', resolve))
    }
  }
  stream.write('}')

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
}

/**
 * Generate a JSON file with large string values.
 */
async function generateLargeStrings(filepath: string, config: GeneratorConfig): Promise<void> {
  const stream = createWriteStream(filepath)

  stream.write('[')
  for (let i = 0; i < config.largeStringCount; i++) {
    if (i > 0) stream.write(',\n')
    const obj = {
      id: i,
      data: generateRandomString(config.largeStringSize),
    }
    const chunk = JSON.stringify(obj)
    if (!stream.write(chunk)) {
      await new Promise<void>(resolve => stream.once('drain', resolve))
    }
  }
  stream.write(']')

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
}

/**
 * Generate a JSON file with a named array (typical API response pattern).
 * Structure: {"metadata": {...}, "data": [items...], "total": N}
 */
async function generateNamedArray(filepath: string, config: GeneratorConfig): Promise<void> {
  const stream = createWriteStream(filepath)
  const padding = generateRandomString(config.stringValueSize)

  // Opening wrapper + metadata
  const header = JSON.stringify({
    metadata: { generated: new Date().toISOString(), version: 1 },
  }).slice(0, -1) + ',"data":['

  stream.write(header)

  for (let i = 0; i < config.objectCount; i++) {
    if (i > 0) stream.write(',')
    const obj: Record<string, unknown> = { id: i }
    for (let k = 0; k < config.keysPerObject - 1; k++) {
      obj[`field_${k}`] = k % 3 === 0 ? i * k : k % 3 === 1 ? (k % 2 === 0) : `${padding}_${i}_${k}`
    }
    const chunk = JSON.stringify(obj)
    if (!stream.write(chunk)) {
      await new Promise<void>(resolve => stream.once('drain', resolve))
    }
  }

  stream.write(`],"total":${config.objectCount}}`)

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
}

/**
 * Generate a deeply nested JSON structure.
 */
async function generateDeepNesting(filepath: string, config: GeneratorConfig): Promise<void> {
  const stream = createWriteStream(filepath)

  // Build a deeply nested array-of-arrays with values at the leaves
  stream.write('[')
  for (let i = 0; i < 100; i++) {
    if (i > 0) stream.write(',\n')
    let nested = '['.repeat(config.nestingDepth)
    nested += JSON.stringify({ leaf: i, value: generateRandomString(50) })
    nested += ']'.repeat(config.nestingDepth)
    if (!stream.write(nested)) {
      await new Promise<void>(resolve => stream.once('drain', resolve))
    }
  }
  stream.write(']')

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
}

async function main() {
  const preset = process.argv[2] || 'medium'
  const outputDir = process.argv[3] || join(import.meta.dirname, '..', '..', '.test-data')

  const config = PRESETS[preset]
  if (!config) {
    console.error(`Unknown preset: ${preset}. Available: ${Object.keys(PRESETS).join(', ')}`)
    process.exit(1)
  }

  await mkdir(outputDir, { recursive: true })

  console.log(`Generating ${preset} test data in ${outputDir}...`)

  const files = [
    { name: `${preset}-jsonl.ndjson`, generator: generateJsonl, desc: 'JSONL (many small objects)' },
    { name: `${preset}-large-object.json`, generator: generateLargeObject, desc: 'Single large object' },
    { name: `${preset}-large-strings.json`, generator: generateLargeStrings, desc: 'Large string values' },
    { name: `${preset}-deep-nesting.json`, generator: generateDeepNesting, desc: 'Deeply nested structure' },
    { name: `${preset}-named-array.json`, generator: generateNamedArray, desc: 'Named array (API response)' },
  ]

  for (const file of files) {
    const filepath = join(outputDir, file.name)
    const start = performance.now()
    await file.generator(filepath, config)
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)
    const { size } = await import('node:fs').then(fs =>
      fs.promises.stat(filepath),
    )
    const sizeMB = (size / (1024 * 1024)).toFixed(1)
    console.log(`  ${file.desc}: ${filepath} (${sizeMB} MB, ${elapsed}s)`)
  }

  console.log('Done.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
