import { describe, it, expect } from 'vitest'
import { TokenType, StringRole, type Token } from '../src/tokens.ts'
import { UnexpectedCharError, PrematureEndError } from '../src/parser.ts'
import { collectTokens } from './helpers.ts'

describe('JsonParser', () => {
  describe('simple values', () => {
    it('parses an integer', async () => {
      const tokens = await collectTokens('42')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: 42 }])
    })

    it('parses zero', async () => {
      const tokens = await collectTokens('0')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: 0 }])
    })

    it('parses negative zero', async () => {
      const tokens = await collectTokens('-0')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: -0 }])
    })

    it('parses negative integer', async () => {
      const tokens = await collectTokens('-17')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: -17 }])
    })

    it('parses float', async () => {
      const tokens = await collectTokens('3.14')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: 3.14 }])
    })

    it('parses exponent', async () => {
      const tokens = await collectTokens('1e10')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: 1e10 }])
    })

    it('parses negative exponent', async () => {
      const tokens = await collectTokens('1.5E-3')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: 1.5e-3 }])
    })

    it('parses exponent with plus', async () => {
      const tokens = await collectTokens('2e+5')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: 2e5 }])
    })

    it('parses true', async () => {
      const tokens = await collectTokens('true')
      expect(tokens).toEqual([{ type: TokenType.TRUE }])
    })

    it('parses false', async () => {
      const tokens = await collectTokens('false')
      expect(tokens).toEqual([{ type: TokenType.FALSE }])
    })

    it('parses null', async () => {
      const tokens = await collectTokens('null')
      expect(tokens).toEqual([{ type: TokenType.NULL }])
    })

    it('parses a simple string', async () => {
      const tokens = await collectTokens('"hello"')
      expect(tokens).toEqual([
        { type: TokenType.STRING_START, role: StringRole.VALUE },
        { type: TokenType.STRING_CHUNK, role: StringRole.VALUE, value: 'hello' },
        { type: TokenType.STRING_END, role: StringRole.VALUE },
      ])
    })

    it('parses an empty string', async () => {
      const tokens = await collectTokens('""')
      expect(tokens).toEqual([
        { type: TokenType.STRING_START, role: StringRole.VALUE },
        { type: TokenType.STRING_END, role: StringRole.VALUE },
      ])
    })
  })

  describe('string escapes', () => {
    it('parses standard escapes', async () => {
      const tokens = await collectTokens('"\\n\\t\\r\\\\\\"\\/\\b\\f"')
      const chunk = tokens.find((t): t is Token & { type: TokenType.STRING_CHUNK } => t.type === TokenType.STRING_CHUNK)
      expect(chunk!.value).toBe('\n\t\r\\"/\b\f')
    })

    it('parses unicode escapes', async () => {
      const tokens = await collectTokens('"\\u0041\\u0042"')
      const chunk = tokens.find((t): t is Token & { type: TokenType.STRING_CHUNK } => t.type === TokenType.STRING_CHUNK)
      expect(chunk!.value).toBe('AB')
    })

    it('parses mixed content and escapes', async () => {
      const tokens = await collectTokens('"hello\\nworld"')
      const chunk = tokens.find((t): t is Token & { type: TokenType.STRING_CHUNK } => t.type === TokenType.STRING_CHUNK)
      expect(chunk!.value).toBe('hello\nworld')
    })
  })

  describe('containers', () => {
    it('parses empty object', async () => {
      const tokens = await collectTokens('{}')
      expect(tokens).toEqual([
        { type: TokenType.OBJECT_START },
        { type: TokenType.OBJECT_END },
      ])
    })

    it('parses empty array', async () => {
      const tokens = await collectTokens('[]')
      expect(tokens).toEqual([
        { type: TokenType.ARRAY_START },
        { type: TokenType.ARRAY_END },
      ])
    })

    it('parses simple object', async () => {
      const tokens = await collectTokens('{"a":1}')
      expect(tokens).toEqual([
        { type: TokenType.OBJECT_START },
        { type: TokenType.STRING_START, role: StringRole.KEY },
        { type: TokenType.STRING_CHUNK, role: StringRole.KEY, value: 'a' },
        { type: TokenType.STRING_END, role: StringRole.KEY },
        { type: TokenType.COLON },
        { type: TokenType.NUMBER, value: 1 },
        { type: TokenType.OBJECT_END },
      ])
    })

    it('parses object with multiple keys', async () => {
      const tokens = await collectTokens('{"a":1,"b":2}')
      const types = tokens.map(t => t.type)
      expect(types).toEqual([
        TokenType.OBJECT_START,
        TokenType.STRING_START, TokenType.STRING_CHUNK, TokenType.STRING_END,
        TokenType.COLON, TokenType.NUMBER,
        TokenType.COMMA,
        TokenType.STRING_START, TokenType.STRING_CHUNK, TokenType.STRING_END,
        TokenType.COLON, TokenType.NUMBER,
        TokenType.OBJECT_END,
      ])
    })

    it('parses simple array', async () => {
      const tokens = await collectTokens('[1,2,3]')
      expect(tokens).toEqual([
        { type: TokenType.ARRAY_START },
        { type: TokenType.NUMBER, value: 1 },
        { type: TokenType.COMMA },
        { type: TokenType.NUMBER, value: 2 },
        { type: TokenType.COMMA },
        { type: TokenType.NUMBER, value: 3 },
        { type: TokenType.ARRAY_END },
      ])
    })

    it('parses nested structures', async () => {
      const tokens = await collectTokens('{"arr":[1,{"nested":true}]}')
      const types = tokens.map(t => t.type)
      expect(types).toContain(TokenType.ARRAY_START)
      expect(types).toContain(TokenType.TRUE)

      // Verify nesting order
      const startIdx = types.indexOf(TokenType.ARRAY_START)
      const nestedObjStart = types.indexOf(TokenType.OBJECT_START, startIdx + 1)
      const trueIdx = types.indexOf(TokenType.TRUE)
      expect(nestedObjStart).toBeLessThan(trueIdx)
    })
  })

  describe('whitespace handling', () => {
    it('ignores leading/trailing whitespace', async () => {
      const tokens = await collectTokens('  42  ')
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: 42 }])
    })

    it('ignores whitespace between tokens', async () => {
      const tokens = await collectTokens('  {  "a"  :  1  }  ')
      expect(tokens.length).toBe(7) // Same as compact form
    })

    it('ignores all whitespace types', async () => {
      const tokens = await collectTokens(' \t\n\r{ \t\n\r} \t\n\r')
      expect(tokens).toEqual([
        { type: TokenType.OBJECT_START },
        { type: TokenType.OBJECT_END },
      ])
    })
  })

  describe('chunk boundary handling', () => {
    it('handles string split across chunks', async () => {
      const tokens = await collectTokens(['"hel', 'lo"'])
      const chunks = tokens.filter(
        (t): t is Token & { type: TokenType.STRING_CHUNK } => t.type === TokenType.STRING_CHUNK,
      )
      const fullValue = chunks.map(c => c.value).join('')
      expect(fullValue).toBe('hello')
    })

    it('handles number split across chunks', async () => {
      const tokens = await collectTokens(['3.', '14'])
      expect(tokens).toEqual([{ type: TokenType.NUMBER, value: 3.14 }])
    })

    it('handles keyword split across chunks', async () => {
      const tokens = await collectTokens(['tr', 'ue'])
      expect(tokens).toEqual([{ type: TokenType.TRUE }])
    })

    it('handles object split at every boundary', async () => {
      // When strings span chunk boundaries, extra STRING_CHUNK tokens appear.
      // Verify structural correctness by checking start/end token counts.
      const json = '{"key":"value"}'
      for (let i = 1; i < json.length; i++) {
        const tokens = await collectTokens([json.slice(0, i), json.slice(i)])
        const objStarts = tokens.filter(t => t.type === TokenType.OBJECT_START)
        const objEnds = tokens.filter(t => t.type === TokenType.OBJECT_END)
        const strStarts = tokens.filter(t => t.type === TokenType.STRING_START)
        const strEnds = tokens.filter(t => t.type === TokenType.STRING_END)
        expect(objStarts.length).toBe(1)
        expect(objEnds.length).toBe(1)
        expect(strStarts.length).toBe(2) // key + value
        expect(strEnds.length).toBe(2)
      }
    })

    it('handles single-character chunks', async () => {
      const json = '{"a":1}'
      const chars = json.split('')
      const tokens = await collectTokens(chars)
      expect(tokens.length).toBe(7)
    })

    it('handles escape sequence split across chunks', async () => {
      const tokens = await collectTokens(['"hello\\', 'nworld"'])
      const chunks = tokens.filter(
        (t): t is Token & { type: TokenType.STRING_CHUNK } => t.type === TokenType.STRING_CHUNK,
      )
      const fullValue = chunks.map(c => c.value).join('')
      expect(fullValue).toBe('hello\nworld')
    })

    it('handles unicode escape split across chunks', async () => {
      const tokens = await collectTokens(['"\\u00', '41"'])
      const chunks = tokens.filter(
        (t): t is Token & { type: TokenType.STRING_CHUNK } => t.type === TokenType.STRING_CHUNK,
      )
      const fullValue = chunks.map(c => c.value).join('')
      expect(fullValue).toBe('A')
    })
  })

  describe('multi mode', () => {
    it('parses multiple root values', async () => {
      const tokens = await collectTokens('1\n2\n3', { multi: true })
      const numbers = tokens.filter(
        (t): t is Token & { type: TokenType.NUMBER } => t.type === TokenType.NUMBER,
      )
      expect(numbers.map(n => n.value)).toEqual([1, 2, 3])
    })

    it('parses JSONL', async () => {
      const tokens = await collectTokens('{"a":1}\n{"b":2}', { multi: true })
      const objStarts = tokens.filter(t => t.type === TokenType.OBJECT_START)
      expect(objStarts.length).toBe(2)
    })

    it('parses empty input in multi mode', async () => {
      const tokens = await collectTokens('', { multi: true })
      expect(tokens).toEqual([])
    })

    it('parses whitespace-only input in multi mode', async () => {
      const tokens = await collectTokens('   \n   ', { multi: true })
      expect(tokens).toEqual([])
    })

    it('rejects multiple values in single mode', async () => {
      await expect(collectTokens('1 2')).rejects.toThrow(UnexpectedCharError)
    })
  })

  describe('error handling', () => {
    it('rejects premature end of object', async () => {
      await expect(collectTokens('{')).rejects.toThrow(PrematureEndError)
    })

    it('rejects premature end of array', async () => {
      await expect(collectTokens('[')).rejects.toThrow(PrematureEndError)
    })

    it('rejects premature end of string', async () => {
      await expect(collectTokens('"hello')).rejects.toThrow(PrematureEndError)
    })

    it('rejects empty input', async () => {
      await expect(collectTokens('')).rejects.toThrow(PrematureEndError)
    })

    it('rejects trailing comma in object', async () => {
      await expect(collectTokens('{"a":1,}')).rejects.toThrow(UnexpectedCharError)
    })

    it('rejects trailing comma in array', async () => {
      await expect(collectTokens('[1,]')).rejects.toThrow(UnexpectedCharError)
    })

    it('rejects leading zeros', async () => {
      await expect(collectTokens('01')).rejects.toThrow(UnexpectedCharError)
    })

    it('rejects lone minus', async () => {
      await expect(collectTokens('-')).rejects.toThrow(PrematureEndError)
    })

    it('rejects incomplete decimal', async () => {
      await expect(collectTokens('1.')).rejects.toThrow(PrematureEndError)
    })

    it('rejects incomplete exponent', async () => {
      await expect(collectTokens('1e')).rejects.toThrow(PrematureEndError)
    })

    it('rejects incomplete exponent sign', async () => {
      await expect(collectTokens('1e+')).rejects.toThrow(PrematureEndError)
    })

    it('rejects invalid escape sequence', async () => {
      await expect(collectTokens('"\\x"')).rejects.toThrow(UnexpectedCharError)
    })

    it('rejects control characters in strings', async () => {
      await expect(collectTokens('"\x01"')).rejects.toThrow(UnexpectedCharError)
    })

    it('rejects mismatched brackets', async () => {
      await expect(collectTokens('{]')).rejects.toThrow(UnexpectedCharError)
    })

    it('rejects mismatched brackets (reverse)', async () => {
      await expect(collectTokens('[}')).rejects.toThrow(UnexpectedCharError)
    })

    it('rejects incomplete keyword', async () => {
      await expect(collectTokens('tru')).rejects.toThrow(PrematureEndError)
    })

    it('rejects invalid keyword', async () => {
      await expect(collectTokens('trux')).rejects.toThrow(UnexpectedCharError)
    })
  })

  describe('large inputs', () => {
    it('parses a large array', async () => {
      const items = Array.from({ length: 10_000 }, (_, i) => i)
      const json = JSON.stringify(items)
      const tokens = await collectTokens(json)
      const numbers = tokens.filter(
        (t): t is Token & { type: TokenType.NUMBER } => t.type === TokenType.NUMBER,
      )
      expect(numbers.length).toBe(10_000)
      expect(numbers[9999].value).toBe(9999)
    })

    it('parses a deeply nested structure', async () => {
      const depth = 100
      const json = '['.repeat(depth) + '1' + ']'.repeat(depth)
      const tokens = await collectTokens(json)
      const starts = tokens.filter(t => t.type === TokenType.ARRAY_START)
      const ends = tokens.filter(t => t.type === TokenType.ARRAY_END)
      expect(starts.length).toBe(depth)
      expect(ends.length).toBe(depth)
    })
  })
})
