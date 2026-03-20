export const TokenType = {
  OBJECT_START: 'OBJECT_START',
  OBJECT_END: 'OBJECT_END',
  ARRAY_START: 'ARRAY_START',
  ARRAY_END: 'ARRAY_END',
  STRING_START: 'STRING_START',
  STRING_CHUNK: 'STRING_CHUNK',
  STRING_END: 'STRING_END',
  NUMBER: 'NUMBER',
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  NULL: 'NULL',
  COLON: 'COLON',
  COMMA: 'COMMA',
} as const

export type TokenType = (typeof TokenType)[keyof typeof TokenType]

export const StringRole = {
  KEY: 'KEY',
  VALUE: 'VALUE',
} as const

export type StringRole = (typeof StringRole)[keyof typeof StringRole]

export type Token =
  | { type: typeof TokenType.OBJECT_START }
  | { type: typeof TokenType.OBJECT_END }
  | { type: typeof TokenType.ARRAY_START }
  | { type: typeof TokenType.ARRAY_END }
  | { type: typeof TokenType.STRING_START; role: StringRole }
  | { type: typeof TokenType.STRING_CHUNK; role: StringRole; value: string }
  | { type: typeof TokenType.STRING_END; role: StringRole }
  | { type: typeof TokenType.NUMBER; value: number }
  | { type: typeof TokenType.TRUE }
  | { type: typeof TokenType.FALSE }
  | { type: typeof TokenType.NULL }
  | { type: typeof TokenType.COLON }
  | { type: typeof TokenType.COMMA }

// Frozen singletons — zero allocation for structural tokens
export const OBJECT_START: Token = Object.freeze({ type: TokenType.OBJECT_START })
export const OBJECT_END: Token = Object.freeze({ type: TokenType.OBJECT_END })
export const ARRAY_START: Token = Object.freeze({ type: TokenType.ARRAY_START })
export const ARRAY_END: Token = Object.freeze({ type: TokenType.ARRAY_END })
export const COLON: Token = Object.freeze({ type: TokenType.COLON })
export const COMMA: Token = Object.freeze({ type: TokenType.COMMA })
export const TRUE: Token = Object.freeze({ type: TokenType.TRUE })
export const FALSE: Token = Object.freeze({ type: TokenType.FALSE })
export const NULL: Token = Object.freeze({ type: TokenType.NULL })
export const STRING_START_KEY: Token = Object.freeze({ type: TokenType.STRING_START, role: StringRole.KEY })
export const STRING_START_VALUE: Token = Object.freeze({ type: TokenType.STRING_START, role: StringRole.VALUE })
export const STRING_END_KEY: Token = Object.freeze({ type: TokenType.STRING_END, role: StringRole.KEY })
export const STRING_END_VALUE: Token = Object.freeze({ type: TokenType.STRING_END, role: StringRole.VALUE })
