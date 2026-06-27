import { describe, it, expect } from 'vitest'
import { extractOllamaContent, firstSentence, extractJsonBlock } from './shared'

describe('extractOllamaContent', () => {
  it('returns trimmed content from a well-formed Ollama response', async () => {
    const res = new Response(JSON.stringify({ message: { content: '  hello  ' } }))
    expect(await extractOllamaContent(res)).toBe('hello')
  })

  it("returns '' on a malformed (non-JSON) body instead of throwing", async () => {
    const res = new Response('this is not json{')
    expect(await extractOllamaContent(res)).toBe('')
  })

  it("returns '' on an empty body instead of throwing", async () => {
    const res = new Response('')
    expect(await extractOllamaContent(res)).toBe('')
  })

  it("returns '' when the envelope lacks message.content", async () => {
    const res = new Response(JSON.stringify({ unexpected: 'shape' }))
    expect(await extractOllamaContent(res)).toBe('')
  })

  it("returns '' when the JSON body is literally null", async () => {
    const res = new Response('null')
    expect(await extractOllamaContent(res)).toBe('')
  })
})

describe('firstSentence (#784)', () => {
  it('keeps only the first sentence of multi-sentence output', () => {
    expect(firstSentence('Alex uses dark mode. He avoids light themes.')).toBe('Alex uses dark mode.')
  })

  it('returns a single sentence unchanged', () => {
    expect(firstSentence('Alex prefers tabs over spaces.')).toBe('Alex prefers tabs over spaces.')
  })

  it('handles ! and ? terminators', () => {
    expect(firstSentence('Alex loves Swift! He ships often.')).toBe('Alex loves Swift!')
    expect(firstSentence('Does Alex like Go? He prefers Rust.')).toBe('Does Alex like Go?')
  })

  it('does not split on a decimal point mid-sentence', () => {
    expect(firstSentence('Alex targets 99.9 percent uptime.')).toBe('Alex targets 99.9 percent uptime.')
  })

  it('falls back to the whole string when there is no terminator', () => {
    expect(firstSentence('Alex prefers tabs')).toBe('Alex prefers tabs')
  })
})

describe('extractJsonBlock (#785)', () => {
  it('strips a prose prefix before a JSON object', () => {
    expect(extractJsonBlock('Here is the result: {"gap": true}')).toBe('{"gap": true}')
  })

  it('strips prose around a JSON array', () => {
    expect(extractJsonBlock('Sure! ["a", "b"] hope that helps')).toBe('["a", "b"]')
  })

  it('returns clean JSON unchanged', () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}')
  })

  it('picks the bracket type that appears first', () => {
    // object opens before the array, so extract from the object
    expect(extractJsonBlock('x {"a":[1,2]} y')).toBe('{"a":[1,2]}')
  })

  it('ignores a prose [...] annotation before the real object (#831)', () => {
    // The earliest bracket is the prose array, but only the object parses.
    expect(extractJsonBlock('Here are the [extracted] facts: {"fact":"x"}')).toBe('{"fact":"x"}')
  })

  it('extracts a top-level array of objects (gap-analysis shape, #831)', () => {
    // Object span "{...},{...}" is invalid; the full array is the parseable one.
    expect(extractJsonBlock('Result: [{"a":1},{"b":2}]')).toBe('[{"a":1},{"b":2}]')
  })

  it('returns the raw string when no JSON bracket is present', () => {
    expect(extractJsonBlock('no json here')).toBe('no json here')
  })
})
