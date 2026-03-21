import { Transform, type TransformCallback } from "node:stream";
import { type Token, TokenType, StringRole } from "./tokens.ts";

/**
 * Options for {@link JsonArrayItems}.
 */
export interface JsonArrayItemsOptions {
  /**
   * Dot-separated path to the target array within the JSON structure.
   * Omit (or pass `undefined`) for root-level arrays.
   *
   * Examples:
   * - `undefined` — root value must be an array: `[item1, item2, ...]`
   * - `"data"` — `{"data": [item1, item2, ...]}`
   * - `"results.items"` — `{"results": {"items": [item1, item2, ...]}}`
   */
  path?: string;
}

const PHASE_SEEK = 0;
const PHASE_SKIP = 1;
const PHASE_STREAM = 2;
const PHASE_DONE = 3;

/**
 * Token-level Transform that extracts items from a JSON array.
 *
 * Given a stream of tokens from {@link JsonParser}, this transform emits only
 * the tokens belonging to individual array items, making each item appear as
 * an independent root-level value to downstream consumers (e.g. {@link JsonDeserializer}).
 *
 * This enables streaming processing of large arrays without materializing
 * the entire array in memory.
 *
 * **Pipeline:**
 * ```
 * JsonParser → JsonArrayItems → JsonDeserializer
 * ```
 *
 * Each array item is emitted as a complete set of tokens. The wrapping array
 * (and any object envelope around it) is consumed and not forwarded.
 */
export class JsonArrayItems extends Transform {
  readonly #segments: string[];
  #phase: number = PHASE_SEEK;
  #matched = 0;
  #depth = 0;
  #keyBuf = "";
  #readingKey = false;

  // SKIP state
  #skipContainerDepth = 0;

  // STREAM state
  #itemDepth = 0;
  #inStringItem = false;

  constructor(options?: JsonArrayItemsOptions) {
    super({ writableObjectMode: true, readableObjectMode: true });
    this.#segments = options?.path ? options.path.split(".") : [];
  }

  #pathDescription(): string {
    if (this.#matched === 0) return "(root)";
    return this.#segments.slice(0, this.#matched).join(".");
  }

  #expectedType(): string {
    return this.#matched < this.#segments.length ? "object" : "array";
  }

  override _transform(
    token: Token,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      switch (this.#phase) {
        case PHASE_SEEK:
          this.#handleSeek(token);
          break;
        case PHASE_SKIP:
          this.#handleSkip(token);
          break;
        case PHASE_STREAM:
          this.#handleStream(token);
          break;
        // PHASE_DONE: ignore remaining tokens
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.#phase === PHASE_DONE) {
      callback();
    } else {
      callback(new Error("Unexpected end of token stream"));
    }
  }

  #handleSeek(token: Token): void {
    switch (token.type) {
      case TokenType.ARRAY_START:
        if (
          this.#matched === this.#segments.length &&
          this.#depth === this.#matched
        ) {
          // Found target array
          this.#phase = PHASE_STREAM;
          return;
        }
        this.#throwUnexpectedType("array");
        break;

      case TokenType.OBJECT_START:
        if (
          this.#matched < this.#segments.length &&
          this.#depth === this.#matched
        ) {
          // Entering the next object on the path
          this.#depth++;
          return;
        }
        if (
          this.#matched === this.#segments.length &&
          this.#depth === this.#matched
        ) {
          this.#throwUnexpectedType("object");
        }
        this.#depth++;
        break;

      case TokenType.STRING_START:
        if (token.role === StringRole.KEY && this.#depth === this.#matched + 1) {
          this.#keyBuf = "";
          this.#readingKey = true;
        } else if (
          token.role === StringRole.VALUE &&
          this.#depth === this.#matched
        ) {
          this.#throwUnexpectedType("string");
        }
        break;

      case TokenType.STRING_CHUNK:
        if (this.#readingKey && token.role === StringRole.KEY) {
          this.#keyBuf += token.value;
        }
        break;

      case TokenType.STRING_END:
        if (this.#readingKey && token.role === StringRole.KEY) {
          this.#readingKey = false;
        }
        break;

      case TokenType.COLON:
        if (this.#depth === this.#matched + 1) {
          if (this.#keyBuf === this.#segments[this.#matched]) {
            this.#matched++;
          } else {
            this.#phase = PHASE_SKIP;
            this.#skipContainerDepth = 0;
          }
        }
        break;

      case TokenType.OBJECT_END:
        this.#depth--;
        if (this.#depth === this.#matched) {
          throw new Error(
            `Key "${this.#segments[this.#matched]}" not found in object at path "${this.#pathDescription()}"`,
          );
        }
        break;

      case TokenType.COMMA:
        break;

      case TokenType.NUMBER:
      case TokenType.TRUE:
      case TokenType.FALSE:
      case TokenType.NULL:
        if (this.#depth === this.#matched) {
          this.#throwUnexpectedType(
            token.type === TokenType.NUMBER
              ? "number"
              : token.type === TokenType.NULL
                ? "null"
                : "boolean",
          );
        }
        break;
    }
  }

  #handleSkip(token: Token): void {
    switch (token.type) {
      case TokenType.OBJECT_START:
      case TokenType.ARRAY_START:
        this.#skipContainerDepth++;
        break;

      case TokenType.OBJECT_END:
      case TokenType.ARRAY_END:
        this.#skipContainerDepth--;
        if (this.#skipContainerDepth === 0) {
          this.#phase = PHASE_SEEK;
        }
        break;

      default:
        if (this.#skipContainerDepth === 0) {
          if (
            token.type === TokenType.STRING_END ||
            token.type === TokenType.NUMBER ||
            token.type === TokenType.TRUE ||
            token.type === TokenType.FALSE ||
            token.type === TokenType.NULL
          ) {
            this.#phase = PHASE_SEEK;
          }
          // STRING_START, STRING_CHUNK: wait for STRING_END
        }
        break;
    }
  }

  #handleStream(token: Token): void {
    if (this.#itemDepth === 0 && !this.#inStringItem) {
      // Between items
      if (token.type === TokenType.ARRAY_END) {
        this.#phase = PHASE_DONE;
        return;
      }
      if (token.type === TokenType.COMMA) return;

      // Start of a new item
      this.push(token);
      switch (token.type) {
        case TokenType.OBJECT_START:
        case TokenType.ARRAY_START:
          this.#itemDepth = 1;
          break;
        case TokenType.STRING_START:
          this.#inStringItem = true;
          break;
        // NUMBER, TRUE, FALSE, NULL: single-token item, already pushed
      }
      return;
    }

    // Inside an item — pass through
    this.push(token);

    if (this.#inStringItem) {
      if (token.type === TokenType.STRING_END) {
        this.#inStringItem = false;
      }
      return;
    }

    if (token.type === TokenType.OBJECT_START || token.type === TokenType.ARRAY_START) {
      this.#itemDepth++;
    } else if (token.type === TokenType.OBJECT_END || token.type === TokenType.ARRAY_END) {
      this.#itemDepth--;
    }
  }

  #throwUnexpectedType(actual: string): never {
    throw new Error(
      `Expected ${this.#expectedType()} at path "${this.#pathDescription()}", got ${actual}`,
    );
  }
}
