import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  type Token,
  TokenType,
  StringRole,
  OBJECT_START,
  OBJECT_END,
  ARRAY_START,
  ARRAY_END,
  COLON as COLON_TOKEN,
  COMMA as COMMA_TOKEN,
  TRUE as TRUE_TOKEN,
  FALSE as FALSE_TOKEN,
  NULL as NULL_TOKEN,
  STRING_START_KEY,
  STRING_START_VALUE,
  STRING_END_KEY,
  STRING_END_VALUE,
} from "./tokens.ts";

// Char codes for fast comparison
const CH_LCURLY = 0x7b; // {
const CH_RCURLY = 0x7d; // }
const CH_LBRACKET = 0x5b; // [
const CH_RBRACKET = 0x5d; // ]
const CH_QUOTE = 0x22; // "
const CH_COLON = 0x3a; // :
const CH_COMMA = 0x2c; // ,
const CH_BACKSLASH = 0x5c; // \
const CH_SLASH = 0x2f; // /
const CH_b = 0x62;
const CH_f = 0x66;
const CH_n = 0x6e;
const CH_r = 0x72;
const CH_t = 0x74;
const CH_u = 0x75;
const CH_SPACE = 0x20;
const CH_TAB = 0x09;
const CH_NEWLINE = 0x0a;
const CH_CR = 0x0d;
const CH_MINUS = 0x2d;
const CH_PLUS = 0x2b;
const CH_DOT = 0x2e;
const CH_0 = 0x30;
const CH_9 = 0x39;
const CH_a = 0x61;
const CH_e = 0x65;
const CH_E = 0x45;
const CH_F = 0x46;
const CH_A = 0x41;

// Structural expectations
const EXPECT_VALUE = 0;
const EXPECT_KEY_OR_OBJECT_END = 1;
const EXPECT_KEY = 2;
const EXPECT_COLON = 3;
const EXPECT_COMMA_OR_OBJECT_END = 4;
const EXPECT_VALUE_OR_ARRAY_END = 5;
const EXPECT_COMMA_OR_ARRAY_END = 6;
const EXPECT_END = 7;

// Value parsing modes
const MODE_NONE = 0;
const MODE_STRING = 1;
const MODE_STRING_ESCAPE = 2;
const MODE_STRING_UNICODE = 3;
const MODE_NUMBER = 4;
const MODE_KEYWORD = 5;

// Container types for stack
const CONTAINER_OBJECT = 0;
const CONTAINER_ARRAY = 1;

// Number sub-phases
const NUM_AFTER_MINUS = 0;
const NUM_ZERO = 1;
const NUM_DIGITS = 2;
const NUM_DOT = 3;
const NUM_FRAC_DIGITS = 4;
const NUM_E = 5;
const NUM_E_SIGN = 6;
const NUM_EXP_DIGITS = 7;

const VALID_NUMBER_END = new Set([
  NUM_ZERO,
  NUM_DIGITS,
  NUM_FRAC_DIGITS,
  NUM_EXP_DIGITS,
]);

const ESCAPE_MAP: Record<number, string> = {
  [CH_QUOTE]: '"',
  [CH_BACKSLASH]: "\\",
  [CH_SLASH]: "/",
  [CH_b]: "\b",
  [CH_f]: "\f",
  [CH_n]: "\n",
  [CH_r]: "\r",
  [CH_t]: "\t",
};

function isWhitespace(code: number): boolean {
  return (
    code === CH_SPACE ||
    code === CH_TAB ||
    code === CH_NEWLINE ||
    code === CH_CR
  );
}

function isDigit(code: number): boolean {
  return code >= CH_0 && code <= CH_9;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= CH_0 && code <= CH_9) ||
    (code >= CH_a && code <= CH_f) ||
    (code >= CH_A && code <= CH_F)
  );
}

export class UnexpectedCharError extends Error {
  position: number;
  char: string;

  constructor(char: string, position: number) {
    super(`Unexpected character "${char}" at position ${position}.`);
    this.position = position;
    this.char = char;
  }
}

export class PrematureEndError extends Error {
  constructor() {
    super("Premature end of JSON stream.");
  }
}

export interface JsonParserOptions {
  /** If true, allows multiple root-level JSON values (JSONL / JSON-seq). */
  multi?: boolean;
}

export class JsonParser extends Transform {
  #expect = EXPECT_VALUE;
  #mode = MODE_NONE;
  #stack: number[] = [];
  #position = 0;
  #decoder = new StringDecoder("utf8");

  // String state
  #stringValue = "";
  #stringRole = StringRole.VALUE;
  #unicodeHex = "";

  // Number state
  #numberRaw = "";
  #numPhase = 0;

  // Keyword state
  #keywordRaw = "";
  #keywordExpected = "";

  #multi: boolean;

  constructor(options?: JsonParserOptions) {
    super({ readableObjectMode: true, decodeStrings: false });
    this.#multi = options?.multi ?? false;
  }

  #afterValue(): void {
    if (this.#stack.length === 0) {
      this.#expect = EXPECT_END;
    } else if (this.#stack[this.#stack.length - 1] === CONTAINER_OBJECT) {
      this.#expect = EXPECT_COMMA_OR_OBJECT_END;
    } else {
      this.#expect = EXPECT_COMMA_OR_ARRAY_END;
    }
  }

  #flushNumber(): void {
    this.push({
      type: TokenType.NUMBER,
      value: Number(this.#numberRaw),
    } as Token);
    this.#numberRaw = "";
    this.#mode = MODE_NONE;
    this.#afterValue();
  }

  #flushStringChunk(): void {
    if (this.#stringValue.length > 0) {
      this.push({
        type: TokenType.STRING_CHUNK,
        role: this.#stringRole,
        value: this.#stringValue,
      } as Token);
      this.#stringValue = "";
    }
  }

  #expectsValue(): boolean {
    return (
      this.#expect === EXPECT_VALUE ||
      this.#expect === EXPECT_VALUE_OR_ARRAY_END ||
      (this.#multi && this.#expect === EXPECT_END)
    );
  }

  #continueNumber(code: number, char: string): boolean {
    switch (this.#numPhase) {
      case NUM_AFTER_MINUS:
        if (code === CH_0) {
          this.#numPhase = NUM_ZERO;
          this.#numberRaw += char;
          return true;
        }
        if (isDigit(code)) {
          this.#numPhase = NUM_DIGITS;
          this.#numberRaw += char;
          return true;
        }
        return false;
      case NUM_ZERO:
        if (code === CH_DOT) {
          this.#numPhase = NUM_DOT;
          this.#numberRaw += char;
          return true;
        }
        if (code === CH_e || code === CH_E) {
          this.#numPhase = NUM_E;
          this.#numberRaw += char;
          return true;
        }
        return false;
      case NUM_DIGITS:
        if (isDigit(code)) {
          this.#numberRaw += char;
          return true;
        }
        if (code === CH_DOT) {
          this.#numPhase = NUM_DOT;
          this.#numberRaw += char;
          return true;
        }
        if (code === CH_e || code === CH_E) {
          this.#numPhase = NUM_E;
          this.#numberRaw += char;
          return true;
        }
        return false;
      case NUM_DOT:
        if (isDigit(code)) {
          this.#numPhase = NUM_FRAC_DIGITS;
          this.#numberRaw += char;
          return true;
        }
        return false;
      case NUM_FRAC_DIGITS:
        if (isDigit(code)) {
          this.#numberRaw += char;
          return true;
        }
        if (code === CH_e || code === CH_E) {
          this.#numPhase = NUM_E;
          this.#numberRaw += char;
          return true;
        }
        return false;
      case NUM_E:
        if (code === CH_PLUS || code === CH_MINUS) {
          this.#numPhase = NUM_E_SIGN;
          this.#numberRaw += char;
          return true;
        }
        if (isDigit(code)) {
          this.#numPhase = NUM_EXP_DIGITS;
          this.#numberRaw += char;
          return true;
        }
        return false;
      case NUM_E_SIGN:
        if (isDigit(code)) {
          this.#numPhase = NUM_EXP_DIGITS;
          this.#numberRaw += char;
          return true;
        }
        return false;
      case NUM_EXP_DIGITS:
        if (isDigit(code)) {
          this.#numberRaw += char;
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  #processChar(code: number, char: string): void {
    // === Multi-char value modes ===

    if (this.#mode === MODE_STRING) {
      if (code === CH_QUOTE) {
        this.#flushStringChunk();
        this.push(
          this.#stringRole === StringRole.KEY
            ? STRING_END_KEY
            : STRING_END_VALUE,
        );
        this.#mode = MODE_NONE;
        if (this.#stringRole === StringRole.KEY) {
          this.#expect = EXPECT_COLON;
        } else {
          this.#afterValue();
        }
        return;
      }
      if (code === CH_BACKSLASH) {
        this.#mode = MODE_STRING_ESCAPE;
        return;
      }
      if (code < 0x20) {
        throw new UnexpectedCharError(char, this.#position);
      }
      this.#stringValue += char;
      return;
    }

    if (this.#mode === MODE_STRING_ESCAPE) {
      if (code === CH_u) {
        this.#mode = MODE_STRING_UNICODE;
        this.#unicodeHex = "";
        return;
      }
      const decoded = ESCAPE_MAP[code];
      if (decoded === undefined) {
        throw new UnexpectedCharError(char, this.#position);
      }
      this.#stringValue += decoded;
      this.#mode = MODE_STRING;
      return;
    }

    if (this.#mode === MODE_STRING_UNICODE) {
      if (!isHexDigit(code)) {
        throw new UnexpectedCharError(char, this.#position);
      }
      this.#unicodeHex += char;
      if (this.#unicodeHex.length === 4) {
        this.#stringValue += String.fromCharCode(
          parseInt(this.#unicodeHex, 16),
        );
        this.#mode = MODE_STRING;
      }
      return;
    }

    if (this.#mode === MODE_NUMBER) {
      if (this.#continueNumber(code, char)) return;
      // Number ended — validate and flush
      if (!VALID_NUMBER_END.has(this.#numPhase)) {
        throw new UnexpectedCharError(char, this.#position);
      }
      this.#flushNumber();
      // Fall through to process current char as structural
    }

    if (this.#mode === MODE_KEYWORD) {
      this.#keywordRaw += char;
      if (this.#keywordExpected.startsWith(this.#keywordRaw)) {
        if (this.#keywordRaw === this.#keywordExpected) {
          if (this.#keywordExpected === "true") this.push(TRUE_TOKEN);
          else if (this.#keywordExpected === "false") this.push(FALSE_TOKEN);
          else this.push(NULL_TOKEN);
          this.#mode = MODE_NONE;
          this.#afterValue();
        }
        return;
      }
      throw new UnexpectedCharError(char, this.#position);
    }

    // === Whitespace ===
    if (isWhitespace(code)) return;

    // === Structural characters ===

    // Object start
    if (code === CH_LCURLY && this.#expectsValue()) {
      this.push(OBJECT_START);
      this.#stack.push(CONTAINER_OBJECT);
      this.#expect = EXPECT_KEY_OR_OBJECT_END;
      return;
    }

    // Object end
    if (
      code === CH_RCURLY &&
      (this.#expect === EXPECT_KEY_OR_OBJECT_END ||
        this.#expect === EXPECT_COMMA_OR_OBJECT_END)
    ) {
      this.push(OBJECT_END);
      this.#stack.pop();
      this.#afterValue();
      return;
    }

    // Array start
    if (code === CH_LBRACKET && this.#expectsValue()) {
      this.push(ARRAY_START);
      this.#stack.push(CONTAINER_ARRAY);
      this.#expect = EXPECT_VALUE_OR_ARRAY_END;
      return;
    }

    // Array end
    if (
      code === CH_RBRACKET &&
      (this.#expect === EXPECT_VALUE_OR_ARRAY_END ||
        this.#expect === EXPECT_COMMA_OR_ARRAY_END)
    ) {
      this.push(ARRAY_END);
      this.#stack.pop();
      this.#afterValue();
      return;
    }

    // Colon
    if (code === CH_COLON && this.#expect === EXPECT_COLON) {
      this.push(COLON_TOKEN);
      this.#expect = EXPECT_VALUE;
      return;
    }

    // Comma
    if (code === CH_COMMA) {
      if (this.#expect === EXPECT_COMMA_OR_OBJECT_END) {
        this.push(COMMA_TOKEN);
        this.#expect = EXPECT_KEY;
        return;
      }
      if (this.#expect === EXPECT_COMMA_OR_ARRAY_END) {
        this.push(COMMA_TOKEN);
        this.#expect = EXPECT_VALUE;
        return;
      }
    }

    // String start
    if (code === CH_QUOTE) {
      if (this.#expectsValue()) {
        this.#stringRole = StringRole.VALUE;
        this.#stringValue = "";
        this.#mode = MODE_STRING;
        this.push(STRING_START_VALUE);
        return;
      }
      if (
        this.#expect === EXPECT_KEY_OR_OBJECT_END ||
        this.#expect === EXPECT_KEY
      ) {
        this.#stringRole = StringRole.KEY;
        this.#stringValue = "";
        this.#mode = MODE_STRING;
        this.push(STRING_START_KEY);
        return;
      }
    }

    // Number start (minus or digit)
    if (code === CH_MINUS && this.#expectsValue()) {
      this.#mode = MODE_NUMBER;
      this.#numPhase = NUM_AFTER_MINUS;
      this.#numberRaw = "-";
      return;
    }

    if (isDigit(code) && this.#expectsValue()) {
      this.#mode = MODE_NUMBER;
      this.#numberRaw = char;
      this.#numPhase = code === CH_0 ? NUM_ZERO : NUM_DIGITS;
      return;
    }

    // Keyword start (true, false, null)
    if (code === CH_t && this.#expectsValue()) {
      this.#mode = MODE_KEYWORD;
      this.#keywordRaw = "t";
      this.#keywordExpected = "true";
      return;
    }
    if (code === CH_f && this.#expectsValue()) {
      this.#mode = MODE_KEYWORD;
      this.#keywordRaw = "f";
      this.#keywordExpected = "false";
      return;
    }
    if (code === CH_n && this.#expectsValue()) {
      this.#mode = MODE_KEYWORD;
      this.#keywordRaw = "n";
      this.#keywordExpected = "null";
      return;
    }

    throw new UnexpectedCharError(char, this.#position);
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const str =
        typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
      for (let i = 0; i < str.length; i++) {
        this.#processChar(str.charCodeAt(i), str[i]);
        this.#position++;
      }

      // Flush partial string at chunk boundary to bound memory
      if (
        this.#mode === MODE_STRING ||
        this.#mode === MODE_STRING_ESCAPE ||
        this.#mode === MODE_STRING_UNICODE
      ) {
        this.#flushStringChunk();
      }

      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      // Handle any remaining bytes from the StringDecoder
      const remaining = this.#decoder.end();
      if (remaining.length > 0) {
        for (let i = 0; i < remaining.length; i++) {
          this.#processChar(remaining.charCodeAt(i), remaining[i]);
          this.#position++;
        }
      }

      // Flush pending number
      if (this.#mode === MODE_NUMBER) {
        if (!VALID_NUMBER_END.has(this.#numPhase)) {
          throw new PrematureEndError();
        }
        this.#flushNumber();
      }

      // Any other incomplete value mode is an error
      if (this.#mode !== MODE_NONE) {
        throw new PrematureEndError();
      }

      // Must have completed at least one root value (unless multi mode with no input)
      if (
        this.#expect !== EXPECT_END &&
        !(this.#multi && this.#expect === EXPECT_VALUE)
      ) {
        throw new PrematureEndError();
      }

      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}
