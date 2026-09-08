import { describe, it, expect } from 'vitest'
import { kbEmbeddingText, normalizeKbTags, incidentEmbeddingText } from '../embeddings.js'

describe('normalizeKbTags (C-24) — the single tags normaliser', () => {
  it('parses the persisted JSON string', () => {
    expect(normalizeKbTags('["vpn","rete"]')).toEqual(['vpn', 'rete'])
  })
  it('accepts a native list, null/empty → []', () => {
    expect(normalizeKbTags(['a'])).toEqual(['a'])
    expect(normalizeKbTags(null)).toEqual([])
    expect(normalizeKbTags('')).toEqual([])
  })
  it('corrupt JSON / non-array / wrong type throw (no silent tag loss)', () => {
    expect(() => normalizeKbTags('["a"')).toThrow('not valid JSON')
    expect(() => normalizeKbTags('{"a":1}')).toThrow('must be an array')
    expect(() => normalizeKbTags(42)).toThrow('unexpected type')
  })
})

describe('kbEmbeddingText', () => {
  it('includes tags persisted as a JSON string (previously dropped)', () => {
    const text = kbEmbeddingText({ title: 'VPN lenta', category: 'network', tags: '["vpn","wifi"]', body: 'corpo' })
    expect(text).toBe('VPN lenta\nnetwork\nvpn wifi\ncorpo')
  })
  it('no tags → no empty line', () => {
    expect(kbEmbeddingText({ title: 'T', category: 'c', tags: '[]', body: 'b' })).toBe('T\nc\nb')
  })
  it('body is truncated at 4000 chars', () => {
    expect(kbEmbeddingText({ title: 'T', body: 'x'.repeat(5000) })).toHaveLength(2 + 4000)
  })
})

describe('incidentEmbeddingText', () => {
  it('skips missing parts', () => {
    expect(incidentEmbeddingText({ title: 'DB down', description: 'dettagli' })).toBe('DB down\ndettagli')
  })
})
