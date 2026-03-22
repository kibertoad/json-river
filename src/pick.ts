import { Transform, type TransformCallback } from "node:stream";
import * as fs from "node:fs";
import { tmpNameSync } from "tmp";
import { type Token, TokenType, StringRole } from "./tokens.ts";
import { JsonParser } from "./parser.ts";
import { JsonDeserializer, JSON_NULL } from "./deserializer.ts";
import { JsonArrayItems } from "./array-items.ts";

// Reuse the stringifier's escape logic for re-stringifying tokens to disk
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
    (ch) => ESCAPE_TABLE[ch] ?? "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/**
 * Options for {@link JsonPick}.
 */
export interface JsonPickOptions {
  /**
   * Dot-separated paths to pick for streaming.
   *
   * Each path identifies a field whose value is streamed separately from
   * the shell object. If the picked value is an array, each item is emitted
   * individually.
   *
   * Examples:
   * - `["data"]` — pick the `data` field from the root object
   * - `["response.items"]` — pick `items` inside the `response` object
   * - `["data", "meta.tags"]` — pick multiple fields
   */
  pick: string[];

  /**
   * Emit the shell **before** picked values by offloading picked field
   * data to temporary files on disk.
   *
   * - `true` — offload to the OS temp directory (auto-cleaned on completion)
   * - `string` — offload to files in the given directory (NOT cleaned up —
   *   the caller owns the directory and the files within it)
   * - `undefined` / `false` — inline mode: picked values are emitted as
   *   encountered, shell is emitted last. Zero disk I/O, zero buffering.
   *
   * When enabled, pass 1 re-stringifies picked tokens to temp files, then
   * emits the shell. Pass 2 re-reads each file through the parser pipeline
   * and emits deserialized values. Memory stays O(shell + one item).
   */
  shellFirst?: boolean | string;
}

/**
 * Events emitted by {@link JsonPick}.
 */
export type PickEvent =
  | { type: "shell"; value: Record<string, unknown> }
  | { type: "value"; path: string; value: unknown };

// --- Pick-path trie ---

interface PickTrieNode {
  children: Map<string, PickTrieNode>;
  leaf: boolean;
}

function buildPickTrie(paths: string[]): PickTrieNode {
  const root: PickTrieNode = { children: new Map(), leaf: false };
  for (const path of paths) {
    const segments = path.split(".");
    let node = root;
    for (const seg of segments) {
      let child = node.children.get(seg);
      if (!child) {
        child = { children: new Map(), leaf: false };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.leaf = true;
  }
  return root;
}

// --- Shell container state (mirrors JsonDeserializer) ---

type ContainerState =
  | { type: "object"; object: Record<string, unknown>; key: string }
  | { type: "array"; array: unknown[] };

// --- Offloaded pick metadata ---

interface OffloadedPick {
  path: string;
  filePath: string;
  isArray: boolean;
}

// --- Modes ---

const MODE_SHELL = 0;
const MODE_PICK = 1;

/**
 * Token-level Transform that picks fields out of a JSON object for
 * separate streaming, while materializing everything else into a "shell".
 *
 * **Inline mode (default):** single pass, zero buffering, zero disk I/O.
 * Picked values are emitted as encountered, shell is emitted last.
 * Memory: O(shell + max single picked item).
 *
 * **Shell-first mode (`shellFirst: true | string`):** dual pass via
 * filesystem offloading. Pass 1 re-stringifies picked tokens to temp files
 * and builds the shell. Pass 2 re-reads each file and emits values.
 * Shell is emitted first, then values. Memory: O(shell + one item).
 *
 * **Output events (objectMode readable):**
 * - `{ type: "value", path, value }` — one per picked value / array item
 * - `{ type: "shell", value }` — the object with picked fields omitted
 *
 * Supports dot-notation for nested picks: `"response.items"` picks the
 * `items` key inside the `response` object.
 *
 * **Pipeline:**
 * ```
 * JsonParser → JsonPick
 * ```
 */
export class JsonPick extends Transform {
  readonly #trie: PickTrieNode;

  // Shell building (mirrors JsonDeserializer)
  #shellStack: ContainerState[] = [];
  #shellStringAcc = "";
  #shellKeyAcc = "";
  #shellValue: Record<string, unknown> | null = null;

  // Trie navigation
  #trieStack: (PickTrieNode | null)[] = [];
  #pathParts: string[] = [];
  #pendingTrieChild: PickTrieNode | null = null;

  // Pick state (shared)
  #mode = MODE_SHELL;
  #pickCurrentPath = "";
  #pickStarted = false;

  // Inline pick state
  #pickIsArray = false;
  #pickInRootString = false;
  #pickStack: ContainerState[] = [];
  #pickStringAcc = "";
  #pickKeyAcc = "";
  #pickResult: unknown = undefined;

  // Offload pick state
  readonly #shellFirst: boolean;
  readonly #offloadDir: string | null;
  readonly #autoCleanup: boolean;
  #offloadedPicks: OffloadedPick[] = [];
  #currentPickFd = -1;
  #offloadDepth = 0;
  #offloadInString = false;
  #writeBuf = "";

  // Key tracking
  #currentKey = "";
  #isFirstToken = true;

  constructor(options: JsonPickOptions) {
    super({ writableObjectMode: true, readableObjectMode: true });
    if (!options.pick || options.pick.length === 0) {
      throw new Error("JsonPick requires at least one pick path");
    }
    this.#trie = buildPickTrie(options.pick);

    if (options.shellFirst === true) {
      this.#shellFirst = true;
      this.#offloadDir = null; // use OS tmpdir via tmpNameSync
      this.#autoCleanup = true;
    } else if (typeof options.shellFirst === "string") {
      this.#shellFirst = true;
      this.#offloadDir = options.shellFirst;
      this.#autoCleanup = false;
    } else {
      this.#shellFirst = false;
      this.#offloadDir = null;
      this.#autoCleanup = false;
    }
  }

  override _transform(token: Token, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (this.#mode === MODE_PICK) {
        if (this.#shellFirst) {
          this.#handlePickOffload(token);
        } else {
          this.#handlePickInline(token);
        }
      } else {
        this.#handleShell(token);
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    if (!this.#shellFirst) {
      // Inline mode: shell comes last
      if (this.#shellValue) {
        this.push({ type: "shell", value: this.#shellValue } satisfies PickEvent);
      }
      callback();
      return;
    }

    // Shell-first mode: shell, then replay from files
    if (this.#shellValue) {
      this.push({ type: "shell", value: this.#shellValue } satisfies PickEvent);
    }

    this.#replayOffloadedPicks()
      .then(() => callback())
      .catch((err) => callback(err as Error));
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    this.#closeCurrentFd();
    if (this.#autoCleanup) {
      this.#cleanupOffloadFiles();
    }
    callback(err);
  }

  // ===================================================================
  // Shell mode: build shell + detect picks
  // ===================================================================

  #handleShell(token: Token): void {
    switch (token.type) {
      case TokenType.OBJECT_START: {
        if (this.#pendingTrieChild) {
          this.#trieStack.push(this.#pendingTrieChild);
          this.#pathParts.push(this.#currentKey);
          this.#pendingTrieChild = null;
        } else if (this.#isFirstToken) {
          this.#trieStack.push(this.#trie);
        } else {
          this.#trieStack.push(null);
        }
        this.#isFirstToken = false;
        this.#shellStack.push({ type: "object", object: {}, key: "" });
        break;
      }

      case TokenType.OBJECT_END: {
        const ctx = this.#shellStack.pop()!;
        this.#shellEmitValue((ctx as { object: Record<string, unknown> }).object);
        const trieNode = this.#trieStack.pop();
        if (trieNode && this.#trieStack.length > 0) {
          this.#pathParts.pop();
        }
        break;
      }

      case TokenType.ARRAY_START:
        this.#checkNotRoot("array");
        this.#checkNotTrieIntermediate("array");
        this.#shellStack.push({ type: "array", array: [] });
        this.#trieStack.push(null);
        break;

      case TokenType.ARRAY_END: {
        const ctx = this.#shellStack.pop()!;
        this.#shellEmitValue((ctx as { array: unknown[] }).array);
        this.#trieStack.pop();
        break;
      }

      case TokenType.STRING_START:
        if (token.role === StringRole.KEY) {
          this.#shellKeyAcc = "";
        } else {
          this.#checkNotRoot("string");
          this.#checkNotTrieIntermediate("string");
          this.#shellStringAcc = "";
        }
        break;

      case TokenType.STRING_CHUNK:
        if (token.role === StringRole.KEY) {
          this.#shellKeyAcc += token.value;
        } else {
          this.#shellStringAcc += token.value;
        }
        break;

      case TokenType.STRING_END:
        if (token.role === StringRole.KEY) {
          const parent = this.#shellStack[this.#shellStack.length - 1];
          if (parent && parent.type === "object") {
            parent.key = this.#shellKeyAcc;
          }
          this.#currentKey = this.#shellKeyAcc;
        } else {
          this.#shellEmitValue(this.#shellStringAcc);
        }
        break;

      case TokenType.COLON: {
        const trieNode = this.#trieStack[this.#trieStack.length - 1];
        if (trieNode) {
          const child = trieNode.children.get(this.#currentKey);
          if (child) {
            if (child.leaf) {
              this.#mode = MODE_PICK;
              this.#pickStarted = false;
              this.#pickCurrentPath = this.#buildPickPath();
              // Reset mode-specific state
              this.#pickIsArray = false;
              this.#pickInRootString = false;
              this.#pickStack.length = 0;
              this.#offloadDepth = 0;
              this.#offloadInString = false;
            } else {
              this.#pendingTrieChild = child;
            }
          }
        }
        break;
      }

      case TokenType.NUMBER:
        this.#checkNotRoot("number");
        this.#checkNotTrieIntermediate("number");
        this.#shellEmitValue(token.value);
        break;

      case TokenType.TRUE:
        this.#checkNotRoot("boolean");
        this.#checkNotTrieIntermediate("boolean");
        this.#shellEmitValue(true);
        break;

      case TokenType.FALSE:
        this.#checkNotRoot("boolean");
        this.#checkNotTrieIntermediate("boolean");
        this.#shellEmitValue(false);
        break;

      case TokenType.NULL:
        this.#checkNotRoot("null");
        this.#checkNotTrieIntermediate("null");
        this.#shellEmitValue(null);
        break;

      case TokenType.COMMA:
        break;
    }
  }

  // ===================================================================
  // Pick mode — inline: deserialize + emit immediately
  // ===================================================================

  #handlePickInline(token: Token): void {
    if (!this.#pickStarted) {
      this.#pickStarted = true;

      if (token.type === TokenType.ARRAY_START) {
        this.#pickIsArray = true;
        return;
      }
      if (token.type === TokenType.OBJECT_START) {
        this.#pickStack.push({ type: "object", object: {}, key: "" });
        return;
      }
      if (token.type === TokenType.STRING_START && token.role === StringRole.VALUE) {
        this.#pickInRootString = true;
        this.#pickStringAcc = "";
        return;
      }
      // Scalar
      this.#emitPickValue(this.#scalarValue(token));
      this.#mode = MODE_SHELL;
      return;
    }

    // Inside a container
    if (this.#pickStack.length > 0) {
      this.#feedPickDeserializer(token);
      if (this.#pickStack.length === 0) {
        this.#emitPickValue(this.#pickResult);
        if (!this.#pickIsArray) {
          this.#mode = MODE_SHELL;
        }
      }
      return;
    }

    // Root-level string
    if (this.#pickInRootString) {
      if (token.type === TokenType.STRING_CHUNK && token.role === StringRole.VALUE) {
        this.#pickStringAcc += token.value;
      } else if (token.type === TokenType.STRING_END && token.role === StringRole.VALUE) {
        this.#pickInRootString = false;
        this.#emitPickValue(this.#pickStringAcc);
        if (!this.#pickIsArray) {
          this.#mode = MODE_SHELL;
        }
      }
      return;
    }

    // Between array items
    switch (token.type) {
      case TokenType.ARRAY_END:
        this.#mode = MODE_SHELL;
        break;
      case TokenType.COMMA:
        break;
      case TokenType.OBJECT_START:
        this.#pickStack.push({ type: "object", object: {}, key: "" });
        break;
      case TokenType.ARRAY_START:
        this.#pickStack.push({ type: "array", array: [] });
        break;
      case TokenType.STRING_START:
        if (token.role === StringRole.VALUE) {
          this.#pickInRootString = true;
          this.#pickStringAcc = "";
        }
        break;
      case TokenType.NUMBER:
      case TokenType.TRUE:
      case TokenType.FALSE:
      case TokenType.NULL:
        this.#emitPickValue(this.#scalarValue(token));
        break;
    }
  }

  #feedPickDeserializer(token: Token): void {
    switch (token.type) {
      case TokenType.OBJECT_START:
        this.#pickStack.push({ type: "object", object: {}, key: "" });
        break;
      case TokenType.OBJECT_END: {
        const ctx = this.#pickStack.pop()!;
        this.#pickEmitValue((ctx as { object: Record<string, unknown> }).object);
        break;
      }
      case TokenType.ARRAY_START:
        this.#pickStack.push({ type: "array", array: [] });
        break;
      case TokenType.ARRAY_END: {
        const ctx = this.#pickStack.pop()!;
        this.#pickEmitValue((ctx as { array: unknown[] }).array);
        break;
      }
      case TokenType.STRING_START:
        if (token.role === StringRole.KEY) this.#pickKeyAcc = "";
        else this.#pickStringAcc = "";
        break;
      case TokenType.STRING_CHUNK:
        if (token.role === StringRole.KEY) this.#pickKeyAcc += token.value;
        else this.#pickStringAcc += token.value;
        break;
      case TokenType.STRING_END:
        if (token.role === StringRole.KEY) {
          const parent = this.#pickStack[this.#pickStack.length - 1];
          if (parent && parent.type === "object") parent.key = this.#pickKeyAcc;
        } else {
          this.#pickEmitValue(this.#pickStringAcc);
        }
        break;
      case TokenType.NUMBER:
        this.#pickEmitValue(token.value);
        break;
      case TokenType.TRUE:
        this.#pickEmitValue(true);
        break;
      case TokenType.FALSE:
        this.#pickEmitValue(false);
        break;
      case TokenType.NULL:
        this.#pickEmitValue(null);
        break;
    }
  }

  #pickEmitValue(value: unknown): void {
    if (this.#pickStack.length === 0) {
      this.#pickResult = value;
    } else {
      const parent = this.#pickStack[this.#pickStack.length - 1];
      if (parent.type === "object") {
        parent.object[parent.key] = value;
      } else {
        parent.array.push(value);
      }
    }
  }

  // ===================================================================
  // Pick mode — offload: re-stringify tokens to temp file
  // ===================================================================

  #handlePickOffload(token: Token): void {
    if (!this.#pickStarted) {
      this.#pickStarted = true;
      this.#openOffloadFile(token.type === TokenType.ARRAY_START);
    }

    this.#writeTokenToFile(token);

    switch (token.type) {
      case TokenType.OBJECT_START:
      case TokenType.ARRAY_START:
        this.#offloadDepth++;
        break;

      case TokenType.OBJECT_END:
      case TokenType.ARRAY_END:
        this.#offloadDepth--;
        if (this.#offloadDepth === 0) {
          this.#finishOffload();
        }
        break;

      case TokenType.STRING_START:
        if (this.#offloadDepth === 0 && token.role === StringRole.VALUE) {
          this.#offloadInString = true;
        }
        break;

      case TokenType.STRING_END:
        if (this.#offloadInString && token.role === StringRole.VALUE) {
          this.#offloadInString = false;
          if (this.#offloadDepth === 0) {
            this.#finishOffload();
          }
        }
        break;

      case TokenType.NUMBER:
      case TokenType.TRUE:
      case TokenType.FALSE:
      case TokenType.NULL:
        if (this.#offloadDepth === 0 && !this.#offloadInString) {
          this.#finishOffload();
        }
        break;
    }
  }

  #openOffloadFile(isArray: boolean): void {
    const filePath = tmpNameSync({
      prefix: "json-pick-",
      postfix: ".json",
      ...(this.#offloadDir ? { dir: this.#offloadDir } : {}),
    });
    this.#currentPickFd = fs.openSync(filePath, "w");
    this.#writeBuf = "";
    this.#offloadedPicks.push({
      path: this.#pickCurrentPath,
      filePath,
      isArray,
    });
  }

  #writeTokenToFile(token: Token): void {
    let str: string;
    switch (token.type) {
      case TokenType.OBJECT_START:
        str = "{";
        break;
      case TokenType.OBJECT_END:
        str = "}";
        break;
      case TokenType.ARRAY_START:
        str = "[";
        break;
      case TokenType.ARRAY_END:
        str = "]";
        break;
      case TokenType.COLON:
        str = ":";
        break;
      case TokenType.COMMA:
        str = ",";
        break;
      case TokenType.TRUE:
        str = "true";
        break;
      case TokenType.FALSE:
        str = "false";
        break;
      case TokenType.NULL:
        str = "null";
        break;
      case TokenType.NUMBER:
        str = JSON.stringify(token.value);
        break;
      case TokenType.STRING_START:
        str = '"';
        break;
      case TokenType.STRING_CHUNK:
        str = escapeString(token.value);
        break;
      case TokenType.STRING_END:
        str = '"';
        break;
      default:
        return;
    }

    this.#writeBuf += str;
    if (this.#writeBuf.length >= 65536) {
      this.#flushWriteBuf();
    }
  }

  #flushWriteBuf(): void {
    if (this.#writeBuf && this.#currentPickFd !== -1) {
      fs.writeSync(this.#currentPickFd, this.#writeBuf);
      this.#writeBuf = "";
    }
  }

  #finishOffload(): void {
    this.#flushWriteBuf();
    fs.closeSync(this.#currentPickFd);
    this.#currentPickFd = -1;
    this.#mode = MODE_SHELL;
  }

  // ===================================================================
  // Pass 2: replay offloaded picks from disk
  // ===================================================================

  async #replayOffloadedPicks(): Promise<void> {
    try {
      for (const pick of this.#offloadedPicks) {
        await this.#replayOneFile(pick);
      }
    } finally {
      if (this.#autoCleanup) {
        this.#cleanupOffloadFiles();
      }
    }
  }

  #replayOneFile(pick: OffloadedPick): Promise<void> {
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(pick.filePath, {
        encoding: "utf8",
      });
      const parser = new JsonParser();

      const emitValue = (value: unknown): void => {
        this.push({
          type: "value",
          path: pick.path,
          value: value === JSON_NULL ? null : value,
        } satisfies PickEvent);
      };

      if (pick.isArray) {
        const arrayItems = new JsonArrayItems();
        const deserializer = new JsonDeserializer();
        readStream.pipe(parser).pipe(arrayItems).pipe(deserializer);
        deserializer.on("data", emitValue);
        deserializer.on("end", resolve);
        deserializer.on("error", reject);
        arrayItems.on("error", reject);
      } else {
        const deserializer = new JsonDeserializer();
        readStream.pipe(parser).pipe(deserializer);
        deserializer.on("data", emitValue);
        deserializer.on("end", resolve);
        deserializer.on("error", reject);
      }

      parser.on("error", reject);
      readStream.on("error", reject);
    });
  }

  // ===================================================================
  // Cleanup
  // ===================================================================

  #closeCurrentFd(): void {
    if (this.#currentPickFd !== -1) {
      try {
        fs.closeSync(this.#currentPickFd);
      } catch {
        // best-effort
      }
      this.#currentPickFd = -1;
    }
  }

  #cleanupOffloadFiles(): void {
    for (const pick of this.#offloadedPicks) {
      try {
        fs.unlinkSync(pick.filePath);
      } catch {
        // best-effort — file may already be gone
      }
    }
    this.#offloadedPicks = [];
  }

  // ===================================================================
  // Shared helpers
  // ===================================================================

  #shellEmitValue(value: unknown): void {
    if (this.#shellStack.length === 0) {
      this.#shellValue = value as Record<string, unknown>;
    } else {
      const parent = this.#shellStack[this.#shellStack.length - 1];
      if (parent.type === "object") {
        parent.object[parent.key] = value;
      } else {
        parent.array.push(value);
      }
    }
  }

  #emitPickValue(value: unknown): void {
    this.push({
      type: "value",
      path: this.#pickCurrentPath,
      value,
    } satisfies PickEvent);
  }

  #buildPickPath(): string {
    if (this.#pathParts.length === 0) return this.#currentKey;
    return this.#pathParts.join(".") + "." + this.#currentKey;
  }

  #scalarValue(token: Token): unknown {
    switch (token.type) {
      case TokenType.NUMBER:
        return token.value;
      case TokenType.TRUE:
        return true;
      case TokenType.FALSE:
        return false;
      case TokenType.NULL:
        return null;
      default:
        return undefined;
    }
  }

  #checkNotRoot(actual: string): void {
    if (this.#isFirstToken) {
      throw new Error(`JsonPick requires root value to be an object, got ${actual}`);
    }
  }

  #checkNotTrieIntermediate(actual: string): void {
    if (this.#pendingTrieChild) {
      const path = this.#buildPickPath();
      this.#pendingTrieChild = null;
      throw new Error(`Expected object at path "${path}", got ${actual}`);
    }
  }
}
