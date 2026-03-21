import { Transform, type TransformCallback } from "node:stream";
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
} from "./tokens.ts";

// Internal sentinel — write(null) would throw ERR_STREAM_NULL_VALUES
const NULL_SENTINEL = Symbol("json-river.serializer.null");

export interface JsonSerializerOptions {
  /**
   * How to handle BigInt values.
   *
   * - `"error"` (default) — throw a TypeError, matching `JSON.stringify` behavior.
   * - `"number"` — convert to Number via `Number(value)`. Values beyond
   *   `Number.MAX_SAFE_INTEGER` will lose precision silently.
   */
  bigint?: "error" | "number";

  /**
   * A replacer that alters serialization behavior, matching `JSON.stringify`'s second argument.
   *
   * - **Function** `(key, value) => newValue` — called for every value. Return `undefined`
   *   to omit an object property; in arrays, `undefined` becomes `null`.
   * - **Array** of strings/numbers — only these object keys are included (array elements
   *   are unaffected).
   */
  replacer?: ((key: string, value: unknown) => unknown) | (string | number)[];
}

export class JsonSerializer extends Transform {
  readonly #bigint: "error" | "number";
  readonly #replacerFn: ((key: string, value: unknown) => unknown) | null;
  readonly #replacerKeys: Set<string> | null;

  constructor(options?: JsonSerializerOptions) {
    super({ writableObjectMode: true, readableObjectMode: true });
    this.#bigint = options?.bigint ?? "error";

    if (typeof options?.replacer === "function") {
      this.#replacerFn = options.replacer;
      this.#replacerKeys = null;
    } else if (Array.isArray(options?.replacer)) {
      this.#replacerFn = null;
      this.#replacerKeys = new Set(options.replacer.map(String));
    } else {
      this.#replacerFn = null;
      this.#replacerKeys = null;
    }
  }

  // Override write to intercept null (which Node treats as end-of-stream signal)
  override write(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    if (chunk === null) chunk = NULL_SENTINEL;
    return super.write(
      chunk as any,
      encodingOrCallback as any,
      callback as any,
    );
  }

  /**
   * Apply toJSON() and the function replacer (if any) to a value.
   * Array replacer is handled separately during object key iteration.
   */
  #resolve(value: unknown, key: string): unknown {
    if (
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      "toJSON" in value &&
      typeof (value as Record<string, unknown>).toJSON === "function"
    ) {
      value = (value as { toJSON(key: string): unknown }).toJSON(key);
    }
    if (this.#replacerFn) {
      value = this.#replacerFn(key, value);
    }
    return value;
  }

  /**
   * Emit tokens for a value that has already been through #resolve().
   */
  #emit(value: unknown): void {
    if (value === null || value === undefined) {
      this.push(NULL);
      return;
    }

    switch (typeof value) {
      case "boolean":
        this.push(value ? TRUE : FALSE);
        return;
      case "number":
        if (!isFinite(value)) {
          this.push(NULL);
        } else {
          this.push({ type: TokenType.NUMBER, value } as Token);
        }
        return;
      case "string":
        this.push(STRING_START_VALUE);
        if (value.length > 0) {
          this.push({
            type: TokenType.STRING_CHUNK,
            role: StringRole.VALUE,
            value,
          } as Token);
        }
        this.push(STRING_END_VALUE);
        return;
      case "bigint":
        if (this.#bigint === "error") {
          throw new TypeError("Do not know how to serialize a BigInt");
        }
        this.push({ type: TokenType.NUMBER, value: Number(value) } as Token);
        return;
    }

    if (Array.isArray(value)) {
      this.push(ARRAY_START);
      for (let i = 0; i < value.length; i++) {
        if (i > 0) this.push(COMMA);
        const resolved = this.#resolve(value[i], String(i));
        if (
          resolved === undefined ||
          typeof resolved === "function" ||
          typeof resolved === "symbol"
        ) {
          this.push(NULL);
        } else {
          this.#emit(resolved);
        }
      }
      this.push(ARRAY_END);
      return;
    }

    if (typeof value === "object") {
      this.push(OBJECT_START);
      let first = true;
      const obj = value as Record<string, unknown>;
      const keys = this.#replacerKeys
        ? Object.keys(obj).filter((k) => this.#replacerKeys!.has(k))
        : Object.keys(obj);
      for (const objKey of keys) {
        const resolved = this.#resolve(obj[objKey], objKey);
        if (
          resolved === undefined ||
          typeof resolved === "function" ||
          typeof resolved === "symbol"
        )
          continue;
        if (!first) this.push(COMMA);
        first = false;
        this.push(STRING_START_KEY);
        this.push({
          type: TokenType.STRING_CHUNK,
          role: StringRole.KEY,
          value: objKey,
        } as Token);
        this.push(STRING_END_KEY);
        this.push(COLON);
        this.#emit(resolved);
      }
      this.push(OBJECT_END);
    }
    // Functions, symbols at root → silently ignored (matches JSON.stringify)
  }

  override _transform(
    value: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const resolved = this.#resolve(
        value === NULL_SENTINEL ? null : value,
        "",
      );
      this.#emit(resolved);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}
