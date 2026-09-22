/**
 * Event policy: the severity map edited from the Event Management page.
 *
 * The severity map decides the impact and urgency (hence the priority) of
 * every incident opened by an alarm. Its values belong to the TENANT's own
 * dictionary, so after a rename the page must accept the new value and
 * reject an invented one — with a message naming the severity and the
 * field, since that is what the administrator has to fix. A malformed map
 * (not JSON, a missing severity, an empty value, an unknown key) must be a
 * 400, never a half-saved policy. Also pinned: a stored policy that is not
 * a JSON string fails loud with its type instead of loading defaults.
 */
import { describe, it, expect, vi } from 'vitest'
import { GraphQLError } from 'graphql'

/** This fake tenant renamed the "high" impact to "alto"; urgency keeps the seed values. */
const DICTIONARY: Record<string, string[]> = {
  impact:  ['alto', 'medium', 'low'],
  urgency: ['high', 'medium', 'low'],
}
vi.mock('../domainMatrix.js', () => ({
  assertDomainValue: (_t: string, vocabulary: string, value: unknown) => {
    const allowed = DICTIONARY[vocabulary] ?? []
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return Promise.reject(new GraphQLError(`${vocabulary}: "${String(value)}" is not in the dictionary of this tenant`))
    }
    return Promise.resolve(value)
  },
}))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))

const { DEFAULT_EVENT_POLICY, applyEventPolicyInput, parseEventPolicy, assertSeverityMap } = await import('../eventPolicy.js')

const T = 'acme'
const NOW = '2026-09-22T10:00:00.000Z'
const map = (over: Record<string, unknown> = {}) => ({
  critical: { impact: 'alto', urgency: 'high' },
  warning:  { impact: 'medium', urgency: 'medium' },
  info:     { impact: 'low', urgency: 'low' },
  ...over,
})

describe('applyEventPolicyInput — severityMap', () => {
  it('a map using the tenant dictionary (renamed value included) is saved and bumps the version', async () => {
    const next = await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { severityMap: JSON.stringify(map()) }, NOW)
    expect(next.severity_map.critical).toEqual({ impact: 'alto', urgency: 'high' })
    expect(next.version).toBe(DEFAULT_EVENT_POLICY.version + 1)
    expect(next.updated_at).toBe(NOW)
  })

  it('an impact outside the dictionary is refused, naming severity and field', async () => {
    const bad = map({ warning: { impact: 'huge', urgency: 'medium' } })
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { severityMap: JSON.stringify(bad) }, NOW))
      .rejects.toThrow(/^severityMap\.warning\.impact: impact: "huge" is not in the dictionary/)
  })

  it('an urgency outside the dictionary is refused, naming severity and field', async () => {
    const bad = map({ info: { impact: 'low', urgency: 'whenever' } })
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { severityMap: JSON.stringify(bad) }, NOW))
      .rejects.toThrow(/^severityMap\.info\.urgency: urgency: "whenever"/)
  })

  it('a map that is not JSON is a validation error', async () => {
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { severityMap: '{nope' }, NOW))
      .rejects.toThrow(/severityMap is not valid JSON/)
  })

  it('an empty impact is refused before the dictionary is even asked', async () => {
    const bad = map({ critical: { impact: '  ', urgency: 'high' } })
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { severityMap: JSON.stringify(bad) }, NOW))
      .rejects.toThrow(/severityMap\.critical\.impact must be a non-empty string/)
  })
})

describe('assertSeverityMap — shape', () => {
  it('not an object, a missing severity and an unknown key are all refused', () => {
    expect(() => assertSeverityMap([])).toThrow(/severity_map must be a JSON object keyed by/)
    const { info: _info, ...noInfo } = map()
    expect(() => assertSeverityMap(noInfo)).toThrow(/severity_map\.info is missing or not an object/)
    expect(() => assertSeverityMap(map({ fatal: { impact: 'a', urgency: 'b' } }))).toThrow(/unknown keys: fatal/)
  })
})

describe('parseEventPolicy — stored value of the wrong type', () => {
  it('a non-string value fails loud with its type (never the default policy)', () => {
    expect(() => parseEventPolicy({ group_by: 'ci' }, T)).toThrow(`Tenant ${T} event_policy is not a JSON string (got object)`)
  })

  it('a missing value points to the migration; corrupt JSON says so with the parser reason', () => {
    expect(() => parseEventPolicy(null, T)).toThrow(/has no event_policy — run the 20260909_1010_event_management_fixup migration/)
    expect(() => parseEventPolicy('', T)).toThrow(/has no event_policy/)
    expect(() => parseEventPolicy('{broken', T)).toThrow(new RegExp(`Tenant ${T} event_policy is corrupt JSON: `))
  })
})
