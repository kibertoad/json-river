import { Transform, type TransformCallback } from 'node:stream'
import {
  type Token,
  TokenType,
  StringRole,
  OBJECT_START,
  OBJECT_END,
  ARRAY_START,
  ARRAY_END,
  COLON,
  COMMA,
  TRUE,
  FALSE,
  NULL,
  STRING_START_KEY,
  STRING_START_VALUE,
  STRING_END_KEY,
  STRING_END_VALUE,
} from './tokens.ts'

// Internal sentinel — write(null) would throw ERR_STREAM_NULL_VALUES
const NULL_SENTINEL = Symbol('json-river.serializer.null')

export class JsonSerializer extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: true })
  }

  // Override write to intercept null (which Node treats as end-of-stream signal)
  override write(chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    if (chunk === null) chunk = NULL_SENTINEL
    return super.write(chunk as any, encodingOrCallback as any, callback as any)
  }

  #serializeValue(value: unknown): void {
    if (value === null || value === undefined) {
      this.push(NULL)
      return
    }

    switch (typeof value) {
      case 'boolean':
        this.push(value ? TRUE : FALSE)
        return
      case 'number':
        if (!isFinite(value)) {
          this.push(NULL)
        } else {
          this.push({ type: TokenType.NUMBER, value } as Token)
        }
        return
      case 'string':
        this.push(STRING_START_VALUE)
        if (value.length > 0) {
          this.push({ type: TokenType.STRING_CHUNK, role: StringRole.VALUE, value } as Token)
        }
        this.push(STRING_END_VALUE)
        return
      case 'bigint':
        this.push({ type: TokenType.NUMBER, value: Number(value) } as Token)
        return
    }

    if (Array.isArray(value)) {
      this.push(ARRAY_START)
      for (let i = 0; i < value.length; i++) {
        if (i > 0) this.push(COMMA)
        const item = value[i]
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          this.push(NULL)
        } else {
          this.#serializeValue(item)
        }
      }
      this.push(ARRAY_END)
      return
    }

    if (typeof value === 'object') {
      // Handle toJSON()
      if ('toJSON' in value && typeof (value as Record<string, unknown>).toJSON === 'function') {
        this.#serializeValue((value as { toJSON(): unknown }).toJSON())
        return
      }

      this.push(OBJECT_START)
      let first = true
      const obj = value as Record<string, unknown>
      for (const key of Object.keys(obj)) {
        const val = obj[key]
        if (val === undefined || typeof val === 'function' || typeof val === 'symbol') continue
        if (!first) this.push(COMMA)
        first = false
        this.push(STRING_START_KEY)
        this.push({ type: TokenType.STRING_CHUNK, role: StringRole.KEY, value: key } as Token)
        this.push(STRING_END_KEY)
        this.push(COLON)
        this.#serializeValue(val)
      }
      this.push(OBJECT_END)
    }
    // Functions, symbols at root → silently ignored (matches JSON.stringify)
  }

  override _transform(value: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.#serializeValue(value === NULL_SENTINEL ? null : value)
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }
}
