import { Transform, type TransformCallback } from 'node:stream'
import { type Token, TokenType, StringRole } from './tokens.ts'

/**
 * Sentinel value used in place of `null` when emitting root-level null values.
 * Node.js objectMode streams interpret `push(null)` as end-of-stream, so we
 * substitute this symbol. Consumers should check for it:
 *
 *     const actual = value === JSON_NULL ? null : value
 *
 * The convenience `parse()` function handles this automatically.
 */
export const JSON_NULL: unique symbol = Symbol.for('json-river.null')

type ContainerState =
  | { type: 'object'; object: Record<string, unknown>; key: string }
  | { type: 'array'; array: unknown[] }

export class JsonDeserializer extends Transform {
  #stack: ContainerState[] = []
  #stringAccumulator = ''
  #inValueString = false
  #keyAccumulator = ''
  #inKeyString = false

  constructor() {
    super({ writableObjectMode: true, readableObjectMode: true })
  }

  #emitValue(value: unknown): void {
    if (this.#stack.length === 0) {
      // push(null) would signal EOF in objectMode — use sentinel
      this.push(value === null ? JSON_NULL : value)
    } else {
      const parent = this.#stack[this.#stack.length - 1]
      if (parent.type === 'object') {
        parent.object[parent.key] = value
      } else {
        parent.array.push(value)
      }
    }
  }

  override _transform(token: Token, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      switch (token.type) {
        case TokenType.OBJECT_START:
          this.#stack.push({ type: 'object', object: {}, key: '' })
          break

        case TokenType.OBJECT_END: {
          const ctx = this.#stack.pop()!
          this.#emitValue((ctx as { object: Record<string, unknown> }).object)
          break
        }

        case TokenType.ARRAY_START:
          this.#stack.push({ type: 'array', array: [] })
          break

        case TokenType.ARRAY_END: {
          const ctx = this.#stack.pop()!
          this.#emitValue((ctx as { array: unknown[] }).array)
          break
        }

        case TokenType.STRING_START:
          if (token.role === StringRole.KEY) {
            this.#inKeyString = true
            this.#keyAccumulator = ''
          } else {
            this.#inValueString = true
            this.#stringAccumulator = ''
          }
          break

        case TokenType.STRING_CHUNK:
          if (token.role === StringRole.KEY) {
            this.#keyAccumulator += token.value
          } else {
            this.#stringAccumulator += token.value
          }
          break

        case TokenType.STRING_END:
          if (token.role === StringRole.KEY) {
            this.#inKeyString = false
            const parent = this.#stack[this.#stack.length - 1]
            if (parent && parent.type === 'object') {
              parent.key = this.#keyAccumulator
            }
          } else {
            this.#inValueString = false
            this.#emitValue(this.#stringAccumulator)
          }
          break

        case TokenType.NUMBER:
          this.#emitValue(token.value)
          break
        case TokenType.TRUE:
          this.#emitValue(true)
          break
        case TokenType.FALSE:
          this.#emitValue(false)
          break
        case TokenType.NULL:
          this.#emitValue(null)
          break

        // COLON and COMMA carry no semantic value for deserialization
        case TokenType.COLON:
        case TokenType.COMMA:
          break
      }

      callback()
    } catch (err) {
      callback(err as Error)
    }
  }
}
