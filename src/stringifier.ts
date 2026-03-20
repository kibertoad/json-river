import { Transform, type TransformCallback } from "node:stream";
import { type Token, TokenType } from "./tokens.ts";

// oxlint-disable-next-line no-control-regex -- intentional: escapes JSON control chars
const ESCAPE_REGEX = /[\x00-\x1f"\\]/g;
const ESCAPE_TABLE: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function escapeString(s: string): string {
  return s.replace(
    ESCAPE_REGEX,
    (ch) =>
      ESCAPE_TABLE[ch] ??
      "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

export interface JsonStringifierOptions {
  /** Indentation — number of spaces or a string prefix, like JSON.stringify's third argument. */
  space?: string | number;
}

export class JsonStringifier extends Transform {
  #space: string;
  #depth = 0;
  #pendingNewline = false;

  constructor(options?: JsonStringifierOptions) {
    super({ writableObjectMode: true });
    this.#space =
      typeof options?.space === "number"
        ? " ".repeat(options.space)
        : (options?.space ?? "");
  }

  override _transform(
    token: Token,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const s = this.#space;
      let emptyClose = false;

      // Emit pending indent before content tokens (not before close brackets)
      if (s && this.#pendingNewline) {
        if (
          token.type === TokenType.OBJECT_END ||
          token.type === TokenType.ARRAY_END
        ) {
          // Empty container — no indent needed
          emptyClose = true;
          this.#pendingNewline = false;
        } else if (
          token.type !== TokenType.STRING_CHUNK &&
          token.type !== TokenType.STRING_END
        ) {
          this.push("\n" + s.repeat(this.#depth));
          this.#pendingNewline = false;
        }
      }

      switch (token.type) {
        case TokenType.OBJECT_START:
          this.push("{");
          this.#depth++;
          if (s) this.#pendingNewline = true;
          break;
        case TokenType.OBJECT_END:
          this.#depth--;
          if (s && !emptyClose) this.push("\n" + s.repeat(this.#depth));
          this.push("}");
          this.#pendingNewline = false;
          break;
        case TokenType.ARRAY_START:
          this.push("[");
          this.#depth++;
          if (s) this.#pendingNewline = true;
          break;
        case TokenType.ARRAY_END:
          this.#depth--;
          if (s && !emptyClose) this.push("\n" + s.repeat(this.#depth));
          this.push("]");
          this.#pendingNewline = false;
          break;
        case TokenType.COMMA:
          this.push(",");
          if (s) this.#pendingNewline = true;
          break;
        case TokenType.COLON:
          this.push(s ? ": " : ":");
          break;
        case TokenType.STRING_START:
          this.push('"');
          break;
        case TokenType.STRING_CHUNK:
          this.push(escapeString(token.value));
          break;
        case TokenType.STRING_END:
          this.push('"');
          break;
        case TokenType.NUMBER:
          this.push(JSON.stringify(token.value));
          break;
        case TokenType.TRUE:
          this.push("true");
          break;
        case TokenType.FALSE:
          this.push("false");
          break;
        case TokenType.NULL:
          this.push("null");
          break;
      }

      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}
