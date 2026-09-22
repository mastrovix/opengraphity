/**
 * Portal severities — reading what is stored, and the missing tenant.
 *
 * Why it matters: the stored list decides what an end user can pick when
 * opening a ticket. A corrupt value must be refused LOUDLY with the tenant
 * and position named (never silently shrunk to the entries that parse, which
 * would hide a severity from the portal), and a tenant that does not exist
 * must be a NotFound, not "not configured" — the two need different fixes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let stored: unknown = null
let tenantExists = true
let writeFinds = true

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => undefined }),
  runQuery: vi.fn(async () => []),
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('SET t.portal_severity_options')) return writeFinds ? { id: params['tenantId'] } : null
    return tenantExists ? { raw: stored } : null
  }),
}))
vi.mock('../domainMatrix.js', () => ({ domainVocabulary: vi.fn(async () => ['high', 'low']) }))
vi.mock('../vocabularyEntries.js', () => ({ loadVocabularyEntries: vi.fn(async () => ({ values: ['high', 'low'], labels: {}, colors: {} })) }))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en') }))

const { portalSeverityOptions, setPortalSeverityOptions } = await import('../portalSeverityOptions.js')

beforeEach(() => {
  stored = null
  tenantExists = true
  writeFinds = true
})

describe('portalSeverityOptions — reading the stored value', () => {
  it('a missing or empty property is "not declared" (null), not an empty list', async () => {
    expect(await portalSeverityOptions('t1')).toBeNull()
    stored = ''
    expect(await portalSeverityOptions('t1')).toBeNull()
  })

  it('an unknown tenant is a NotFound, not "not configured"', async () => {
    tenantExists = false
    await expect(portalSeverityOptions('ghost')).rejects.toThrow(/Tenant/)
    await expect(portalSeverityOptions('ghost')).rejects.not.toThrow(/must be a list/)
  })

  it('accepts a value already stored as a native list (not only as JSON text)', async () => {
    stored = [{ value: 'high', labels: { it: 'Alta' } }, { value: 'low' }]
    expect(await portalSeverityOptions('t1')).toEqual([{ value: 'high', labels: { it: 'Alta' } }, { value: 'low', labels: {} }])
  })

  it.each([
    ['{broken', /t1: portal_severity_options is not valid JSON/],
    [JSON.stringify({ value: 'high' }), /must be a list/],
    [JSON.stringify(['high']), /\[0\] is not an object/],
    [JSON.stringify([null]), /\[0\] is not an object/],
    [JSON.stringify([{ value: 'high' }, { labels: {} }]), /\[1\] has no value/],
    [JSON.stringify([{ value: '' }]), /\[0\] has no value/],
    [JSON.stringify([{ value: 'high', labels: 'Alta' }]), /\[0\]\.labels is not an object/],
    [JSON.stringify([{ value: 'high', labels: null }]), /\[0\]\.labels is not an object/],
    [JSON.stringify([{ value: 'high', labels: { fr: 'Haute' } }]), /unknown language "fr"/],
    [JSON.stringify([{ value: 'high', labels: { en: '   ' } }]), /empty label for "en"/],
    [JSON.stringify([{ value: 'high', labels: { en: 3 } }]), /empty label for "en"/],
  ])('a corrupt value %s is refused loudly, naming tenant and position', async (raw, message) => {
    stored = raw
    await expect(portalSeverityOptions('t1')).rejects.toThrow(message)
  })

  it('the JSON parse error is kept as the cause, for whoever debugs it', async () => {
    stored = '{broken'
    const e = await portalSeverityOptions('t1').then(() => null, (err: unknown) => err as Error)
    expect(e?.cause).toBeInstanceOf(SyntaxError)
  })
})

describe('setPortalSeverityOptions — the tenant vanished between check and write', () => {
  it('is a NotFound instead of a silent success', async () => {
    writeFinds = false
    await expect(setPortalSeverityOptions('ghost', [{ value: 'high', labels: [] }])).rejects.toThrow(/Tenant/)
  })
})
