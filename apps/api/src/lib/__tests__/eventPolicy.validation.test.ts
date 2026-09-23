/**
 * lib/eventPolicy.ts — the parts of the validation the two other files do not
 * reach.
 *
 * `eventPolicy.test.ts` pins the keys of the earlier waves, the maxima, the
 * lifecycle lists and the cache; `eventPolicy.more.test.ts` pins the severity
 * map edited from the page. This file pins:
 *
 *  - how severe an alarm is OUTSIDE production (browser tour of 23 Sep 2026):
 *    `production_environments`, values of the tenant's `environment`
 *    vocabulary, and `non_production_severity_map`, where null means «the same
 *    map everywhere». READING checks the shape only (the stored policy is
 *    re-read at every alarm, and a Dictionary change must not switch the
 *    pipeline off); WRITING checks every value against the TENANT's Dictionary
 *    and names the field the administrator has to fix;
 *  - the cross-check that keeps the second map from quietly downgrading every
 *    CI: a non-production map with no production environment is refused;
 *  - no silent fallbacks on the stored JSON: valid JSON that is not an object
 *    fails loud (as a server fault that keeps the shape refusal as its cause,
 *    with no misleading migration hint), an ABSENT key is not read as null,
 *    and a policy that predates a wave names the one migration to run next;
 *  - the lost-update refusal on a policy never modified since bootstrap;
 *  - the policy cache on the metamodel lever (third review · G4): a rename in
 *    the Dictionary rewrites `event_policy` with direct Cypher, so
 *    `invalidateSchema` must drop that tenant's cached policy, and the total
 *    purge after a lost subscription must drop them all.
 *
 * The Dictionary is simulated per tenant: `acme` keeps the shipped values,
 * `globex` renamed them to Italian. The same value is accepted for one and
 * refused for the other — that is what «the tenant's vocabulary, not a list
 * in the code» means.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ValidationError } from '../errors.js'
import { assertDomainValue } from '../domainMatrix.js'
import { clearAllMetamodelCaches, invalidateSchema, lastInvalidation } from '../schemaInvalidator.js'
import {
  DEFAULT_EVENT_POLICY, EVENT_POLICY_MAX, EVENT_POLICY_V7_MIGRATION, EVENT_POLICY_V8_KEYS, EVENT_POLICY_V8_MIGRATION,
  applyEventPolicyInput, assertEventPolicy, cacheEventPolicy, getCachedEventPolicy, invalidateEventPolicyCache,
  parseEventPolicy, toEventPolicyGQL, type EventPolicy, type SeverityMap,
} from '../eventPolicy.js'

const { DICTIONARIES } = vi.hoisted(() => ({
  DICTIONARIES: {
    acme: {
      environment: ['production', 'dr', 'staging', 'development'],
      impact:      ['high', 'medium', 'low'],
      urgency:     ['high', 'medium', 'low'],
    },
    globex: {
      environment: ['produzione', 'collaudo', 'sviluppo'],
      impact:      ['alto', 'medio', 'basso'],
      urgency:     ['alta', 'media', 'bassa'],
    },
  } as Record<string, Record<string, readonly string[]>>,
}))

vi.mock('../domainMatrix.js', async () => {
  const { ValidationError: DictionaryRefusal } = await vi.importActual<typeof import('../errors.js')>('../errors.js')
  return {
    // Same contract and message as the real assertDomainValue (lib/domainMatrix.ts).
    assertDomainValue: vi.fn(async (tenantId: string, vocabulary: string, value: unknown): Promise<string> => {
      const allowed = DICTIONARIES[tenantId]?.[vocabulary]
      if (!allowed) throw new Error(`Dictionary "${vocabulary}" does not exist (neither for tenant ${tenantId} nor shipped)`)
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new DictionaryRefusal(`${vocabulary}: "${String(value)}" is not in the dictionary of this tenant. Allowed: ${allowed.join(', ')}.`)
      }
      return value
    }),
  }
})
// Nothing here reaches a database (the Dictionary is simulated above): this
// only guarantees that a future import cannot open a real connection.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))

const NOW = '2026-09-23T09:00:00.000Z'

/** The owner's choice after the tour: High in production, Medium elsewhere. */
const MEDIUM_ELSEWHERE: SeverityMap = {
  critical: { impact: 'medium', urgency: 'medium' },
  warning:  { impact: 'low',    urgency: 'medium' },
  info:     { impact: 'low',    urgency: 'low' },
}
/** The same choice, in the words of a tenant that renamed impact and urgency. */
const MEDIO_ALTROVE: SeverityMap = {
  critical: { impact: 'medio', urgency: 'media' },
  warning:  { impact: 'basso', urgency: 'media' },
  info:     { impact: 'basso', urgency: 'bassa' },
}
/** acme with the second map switched on (`dr` counts as production). */
const WITH_MAP: EventPolicy = { ...DEFAULT_EVENT_POLICY, production_environments: ['production', 'dr'], non_production_severity_map: MEDIUM_ELSEWHERE }
/** globex's policy, already written with its own values. */
const GLOBEX: EventPolicy = {
  ...DEFAULT_EVENT_POLICY,
  severity_map: { critical: { impact: 'alto', urgency: 'alta' }, warning: { impact: 'medio', urgency: 'media' }, info: { impact: 'basso', urgency: 'bassa' } },
  production_environments: ['produzione'],
}

/** What a synchronous call throws; the test fails if it returns. */
function thrownBy(fn: () => unknown): unknown {
  try { fn() } catch (e) { return e }
  throw new Error('expected the call to throw, and it returned')
}

/** What a promise rejects with; the test fails if it resolves. */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try { await p } catch (e) { return e }
  throw new Error('expected the promise to reject, and it resolved')
}

/** A 400 for the administrator: a ValidationError (BAD_USER_INPUT) with this message. */
function expectValidationError(err: unknown, message: string | RegExp): void {
  expect(err).toBeInstanceOf(ValidationError)
  expect((err as ValidationError).extensions['code']).toBe('BAD_USER_INPUT')
  if (typeof message === 'string') expect((err as ValidationError).message).toBe(message)
  else expect((err as ValidationError).message).toMatch(message)
}

beforeEach(() => { vi.mocked(assertDomainValue).mockClear() })

// ── production_environments in the stored policy ────────────────────────────

describe('production_environments in the stored policy: the shape only, the values are checked on write', () => {
  it('the tour keys start switched off — production is [production] and the second map is null — so on the first day no incident changes priority', () => {
    expect(EVENT_POLICY_V8_KEYS).toEqual(['production_environments', 'non_production_severity_map'])
    expect(EVENT_POLICY_V8_MIGRATION).toBe('20261007_1040_event_policy_non_production')
    expect(DEFAULT_EVENT_POLICY).toMatchObject({ production_environments: ['production'], non_production_severity_map: null })
  })

  it('a list of distinct names is read back as stored and in order, even names no code list knows: reading never asks the Dictionary', () => {
    const stored = { ...DEFAULT_EVENT_POLICY, production_environments: ['prod-eu', 'prod-us'] }
    expect(parseEventPolicy(JSON.stringify(stored), 'acme').production_environments).toEqual(['prod-eu', 'prod-us'])
    expect(assertDomainValue).not.toHaveBeenCalled()
  })

  it('an empty list is a valid stored value while the second map is off', () => {
    expect(assertEventPolicy({ ...DEFAULT_EVENT_POLICY, production_environments: [] }).production_environments).toEqual([])
  })

  it('a value that is not a list is refused, naming the field and what it must hold', () => {
    expectValidationError(
      thrownBy(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, production_environments: 'production' })),
      'event_policy.production_environments must be a list of values of the environment vocabulary. Got: "production"',
    )
  })

  it('an empty or non-string entry, and a name listed twice, are refused naming the entry', () => {
    const withList = (production_environments: unknown) => () => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, production_environments })
    expectValidationError(thrownBy(withList(['production', ''])), 'event_policy.production_environments: "" is not a non-empty string')
    expectValidationError(thrownBy(withList(['production', 42])), 'event_policy.production_environments: 42 is not a non-empty string')
    expectValidationError(thrownBy(withList([null])), 'event_policy.production_environments: null is not a non-empty string')
    expectValidationError(thrownBy(withList(['production', 'dr', 'production'])), 'event_policy.production_environments: production appears twice')
  })
})

// ── non_production_severity_map in the stored policy ────────────────────────

describe('non_production_severity_map in the stored policy', () => {
  it('a stored map is read back as an object; null is read back as null (the same severity_map everywhere)', () => {
    expect(parseEventPolicy(JSON.stringify(WITH_MAP), 'acme')).toEqual(WITH_MAP)
    expect(parseEventPolicy(JSON.stringify({ ...WITH_MAP, non_production_severity_map: null }), 'acme').non_production_severity_map).toBeNull()
  })

  it('a malformed stored map is refused like severity_map, but under its own name', () => {
    const withMap = (non_production_severity_map: unknown) => () => assertEventPolicy({ ...WITH_MAP, non_production_severity_map })
    const { info: _info, ...noInfo } = MEDIUM_ELSEWHERE
    expectValidationError(thrownBy(withMap(noInfo)), 'event_policy.non_production_severity_map.info is missing or not an object')
    expectValidationError(
      thrownBy(withMap({ ...MEDIUM_ELSEWHERE, critical: { impact: 'medium', urgency: ' ' } })),
      'event_policy.non_production_severity_map.critical.urgency must be a non-empty string. Got: " "',
    )
    expectValidationError(thrownBy(withMap({ ...MEDIUM_ELSEWHERE, fatal: { impact: 'high', urgency: 'high' } })), 'event_policy.non_production_severity_map has unknown keys: fatal')
    expectValidationError(thrownBy(withMap('medium')), 'event_policy.non_production_severity_map must be a JSON object keyed by info, warning, critical')
  })

  it('an ABSENT key is not read as null (switched off): the policy predates the tour, and the error names the migration that adds it', () => {
    const { production_environments: _p, non_production_severity_map: _n, ...beforeTour } = DEFAULT_EVENT_POLICY
    expect((thrownBy(() => parseEventPolicy(JSON.stringify(beforeTour), 'acme')) as Error).message).toBe(
      'Tenant acme event_policy is invalid: Tenant acme event_policy.production_environments must be a list of values of the environment vocabulary. Got: undefined'
      + ' — missing production_environments, non_production_severity_map: run the 20261007_1040_event_policy_non_production migration',
    )
    const { non_production_severity_map: _m, ...noMap } = DEFAULT_EVENT_POLICY
    expect((thrownBy(() => parseEventPolicy(JSON.stringify(noMap), 'acme')) as Error).message).toBe(
      'Tenant acme event_policy is invalid: Tenant acme event_policy.non_production_severity_map must be a JSON object keyed by info, warning, critical'
      + ' — missing non_production_severity_map: run the 20261007_1040_event_policy_non_production migration',
    )
  })

  it('only the oldest missing migration is named: a policy that also lacks high_impact_dependents points to the 1050, not to the tour migration', () => {
    const { production_environments: _p, non_production_severity_map: _n, high_impact_dependents: _h, ...beforeG7 } = DEFAULT_EVENT_POLICY
    const message = (thrownBy(() => parseEventPolicy(JSON.stringify(beforeG7), 'acme')) as Error).message
    expect(message).toBe(
      'Tenant acme event_policy is invalid: Tenant acme event_policy.high_impact_dependents must be an integer >= 0. Got: undefined'
      + ` — missing high_impact_dependents: run the ${EVENT_POLICY_V7_MIGRATION} migration`,
    )
    expect(message).not.toContain(EVENT_POLICY_V8_MIGRATION)
  })
})

// ── The cross-check ──────────────────────────────────────────────────────────

describe('a non-production map needs at least one production environment', () => {
  const REFUSAL = 'production_environments cannot be empty while non_production_severity_map is set: every CI with an environment would count as non-production'

  it('a stored policy with the map on and no production environment is refused, saying why', () => {
    expectValidationError(thrownBy(() => assertEventPolicy({ ...WITH_MAP, production_environments: [] })), `event_policy.${REFUSAL}`)
  })

  it('the mutation is refused in either order: emptying the list under an active map, or switching the map on over an empty list', async () => {
    expectValidationError(await rejectionOf(applyEventPolicyInput('acme', WITH_MAP, { productionEnvironments: [] }, NOW)), `eventPolicy.${REFUSAL}`)
    const noProduction: EventPolicy = { ...DEFAULT_EVENT_POLICY, production_environments: [] }
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', noProduction, { nonProductionSeverityMap: JSON.stringify(MEDIUM_ELSEWHERE) }, NOW)),
      `eventPolicy.${REFUSAL}`,
    )
  })

  it('switching the map off in the same save makes the empty list acceptable', async () => {
    const next = await applyEventPolicyInput('acme', WITH_MAP, { productionEnvironments: [], nonProductionSeverityMap: null }, NOW)
    expect(next).toMatchObject({ production_environments: [], non_production_severity_map: null, version: WITH_MAP.version + 1 })
  })
})

// ── GraphQL out ──────────────────────────────────────────────────────────────

describe('toEventPolicyGQL: the tour keys', () => {
  it('the second map goes out as JSON text like severityMap (null stays null) and the page can save it back unchanged; the environments go out as a copy', async () => {
    const gql = toEventPolicyGQL(WITH_MAP)
    expect(gql.nonProductionSeverityMap).toBe(JSON.stringify(MEDIUM_ELSEWHERE))
    expect(toEventPolicyGQL(DEFAULT_EVENT_POLICY).nonProductionSeverityMap).toBeNull()
    const saved = await applyEventPolicyInput('acme', WITH_MAP, { nonProductionSeverityMap: gql.nonProductionSeverityMap }, NOW)
    expect(saved.non_production_severity_map).toEqual(MEDIUM_ELSEWHERE)

    expect(gql.productionEnvironments).toEqual(['production', 'dr'])
    gql.productionEnvironments.push('staging')
    expect(WITH_MAP.production_environments).toEqual(['production', 'dr'])
  })
})

// ── GraphQL in: nonProductionSeverityMap ────────────────────────────────────

describe('applyEventPolicyInput — nonProductionSeverityMap, the one field where null is a value', () => {
  it('a map in the tenant Dictionary switches it on, bumps the version and leaves severity_map as it was', async () => {
    const next = await applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { nonProductionSeverityMap: JSON.stringify(MEDIUM_ELSEWHERE) }, NOW)
    expect(next.non_production_severity_map).toEqual(MEDIUM_ELSEWHERE)
    expect(next.severity_map).toEqual(DEFAULT_EVENT_POLICY.severity_map)
    expect(next).toMatchObject({ version: DEFAULT_EVENT_POLICY.version + 1, updated_at: NOW })
  })

  it('null switches it off (the same severity map everywhere), while null on any other field is refused', async () => {
    expect((await applyEventPolicyInput('acme', WITH_MAP, { nonProductionSeverityMap: null }, NOW)).non_production_severity_map).toBeNull()
    expectValidationError(await rejectionOf(applyEventPolicyInput('acme', WITH_MAP, { severityMap: null }, NOW)), 'severityMap cannot be null')
    expectValidationError(await rejectionOf(applyEventPolicyInput('acme', WITH_MAP, { productionEnvironments: null }, NOW)), 'productionEnvironments cannot be null')
  })

  it('only a real null switches it off: an empty string or the JSON text "null" is refused, never read as «off»', async () => {
    expectValidationError(await rejectionOf(applyEventPolicyInput('acme', WITH_MAP, { nonProductionSeverityMap: '' }, NOW)), /^nonProductionSeverityMap is not valid JSON: \S/)
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', WITH_MAP, { nonProductionSeverityMap: 'null' }, NOW)),
      'nonProductionSeverityMap must be a JSON object keyed by info, warning, critical',
    )
  })

  it('the values belong to the TENANT Dictionary: renamed values pass for the tenant that renamed them, and a refusal names field, severity and vocabulary', async () => {
    const italian = await applyEventPolicyInput('globex', GLOBEX, { nonProductionSeverityMap: JSON.stringify(MEDIO_ALTROVE) }, NOW)
    expect(italian.non_production_severity_map).toEqual(MEDIO_ALTROVE)
    // The same map on a tenant that kept the shipped values.
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { nonProductionSeverityMap: JSON.stringify(MEDIO_ALTROVE) }, NOW)),
      'nonProductionSeverityMap.info.impact: impact: "basso" is not in the dictionary of this tenant. Allowed: high, medium, low.',
    )
    const badUrgency = { ...MEDIUM_ELSEWHERE, warning: { impact: 'low', urgency: 'whenever' } }
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { nonProductionSeverityMap: JSON.stringify(badUrgency) }, NOW)),
      'nonProductionSeverityMap.warning.urgency: urgency: "whenever" is not in the dictionary of this tenant. Allowed: high, medium, low.',
    )
  })

  it('a map that is not JSON, or lacks a severity, is refused under the non-production name', async () => {
    expectValidationError(await rejectionOf(applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { nonProductionSeverityMap: '{nope' }, NOW)), /^nonProductionSeverityMap is not valid JSON: \S/)
    const { critical: _c, ...noCritical } = MEDIUM_ELSEWHERE
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { nonProductionSeverityMap: JSON.stringify(noCritical) }, NOW)),
      'nonProductionSeverityMap.critical is missing or not an object',
    )
  })
})

// ── GraphQL in: productionEnvironments ──────────────────────────────────────

describe('applyEventPolicyInput — productionEnvironments', () => {
  it('the complete list replaces the previous one in the given order, each name checked in THIS tenant environment vocabulary', async () => {
    const next = await applyEventPolicyInput('acme', WITH_MAP, { productionEnvironments: ['dr', 'production'] }, NOW)
    expect(next.production_environments).toEqual(['dr', 'production'])
    expect(vi.mocked(assertDomainValue).mock.calls).toEqual([['acme', 'environment', 'dr'], ['acme', 'environment', 'production']])
    expect((await applyEventPolicyInput('globex', GLOBEX, { productionEnvironments: ['produzione', 'collaudo'] }, NOW)).production_environments)
      .toEqual(['produzione', 'collaudo'])
  })

  it('a name outside the tenant vocabulary is a ValidationError naming field, vocabulary and value — the shipped name too, once the tenant renamed it', async () => {
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('globex', GLOBEX, { productionEnvironments: ['produzione', 'production'] }, NOW)),
      'productionEnvironments: environment: "production" is not in the dictionary of this tenant. Allowed: produzione, collaudo, sviluppo.',
    )
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', WITH_MAP, { productionEnvironments: ['prod'] }, NOW)),
      'productionEnvironments: environment: "prod" is not in the dictionary of this tenant. Allowed: production, dr, staging, development.',
    )
  })

  it('the shape is checked before the Dictionary is asked: not a list, an empty name or a name listed twice is refused under the GraphQL field name', async () => {
    const refusal = (productionEnvironments: unknown) =>
      rejectionOf(applyEventPolicyInput('acme', WITH_MAP, { productionEnvironments } as never, NOW))
    expectValidationError(await refusal('production'), 'productionEnvironments must be a list of values of the environment vocabulary. Got: "production"')
    expectValidationError(await refusal(['production', '']), 'productionEnvironments: "" is not a non-empty string')
    expectValidationError(await refusal(['production', 'dr', 'production']), 'productionEnvironments: production appears twice')
    expect(assertDomainValue).not.toHaveBeenCalled()
  })

  it('an empty list is saved while the non-production map is off', async () => {
    expect((await applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { productionEnvironments: [] }, NOW)).production_environments).toEqual([])
  })
})

// ── Lost update ──────────────────────────────────────────────────────────────

describe('the lost-update refusal on a policy never modified since bootstrap', () => {
  it('names both versions and, with no updated_at to show, says nothing about when', async () => {
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { expectedVersion: 3, retentionDays: 30 }, NOW)),
      'eventPolicy was modified by someone else (expected version 3, current is 1): reload it and apply your changes again',
    )
  })

  it('expectedVersion null is the same as absent: no check, the save lands on the current version', async () => {
    const current: EventPolicy = { ...DEFAULT_EVENT_POLICY, version: 9, updated_at: '2026-09-22T08:00:00.000Z' }
    expect(await applyEventPolicyInput('acme', current, { expectedVersion: null, retentionDays: 30 }, NOW))
      .toMatchObject({ version: 10, updated_at: NOW, retention_days: 30 })
  })
})

// ── Stored JSON that is not a policy object ──────────────────────────────────

describe('parseEventPolicy: valid JSON that is not a policy object', () => {
  it.each(['null', '[]', '42', '"critical"'])('%s fails loud as an invalid policy, with no migration hint (there are no keys to be missing)', (raw) => {
    expect((thrownBy(() => parseEventPolicy(raw, 'acme')) as Error).message)
      .toBe('Tenant acme event_policy is invalid: Tenant acme event_policy must be a JSON object')
  })

  it('a broken stored policy is a server fault, not the administrator input: a plain Error that keeps the refusal, or the parser error, as its cause', () => {
    // Header of eventPolicy.ts: a missing or corrupt JSON on the tenant is an
    // error; only an input outside the allowed values is a ValidationError.
    const invalid = thrownBy(() => parseEventPolicy('[]', 'acme')) as Error
    expect(invalid).not.toBeInstanceOf(ValidationError)
    expectValidationError(invalid.cause, 'Tenant acme event_policy must be a JSON object')

    const corrupt = thrownBy(() => parseEventPolicy('{broken', 'acme')) as Error
    expect(corrupt).not.toBeInstanceOf(ValidationError)
    expect(corrupt.cause).toBeInstanceOf(SyntaxError)
    expect(corrupt.message).toBe(`Tenant acme event_policy is corrupt JSON: ${(corrupt.cause as SyntaxError).message}`)
  })

  it('assertEventPolicy refuses anything that is not an object, naming what it was validating', () => {
    for (const value of [null, [], 'policy', 1]) {
      expectValidationError(thrownBy(() => assertEventPolicy(value)), 'event_policy must be a JSON object')
    }
    expectValidationError(thrownBy(() => assertEventPolicy(undefined, 'eventPolicy')), 'eventPolicy must be a JSON object')
  })
})

// ── G-MON-7 ──────────────────────────────────────────────────────────────────

describe('high_impact_dependents (G-MON-7): 0 means no highlight, and the maximum is finite', () => {
  it('0 and the maximum pass, one more is refused citing the maximum — in the stored policy and from the mutation', async () => {
    expect(EVENT_POLICY_MAX.high_impact_dependents).toBe(100_000)
    expect(assertEventPolicy({ ...DEFAULT_EVENT_POLICY, high_impact_dependents: 0 }).high_impact_dependents).toBe(0)
    expect(assertEventPolicy({ ...DEFAULT_EVENT_POLICY, high_impact_dependents: 100_000 }).high_impact_dependents).toBe(100_000)
    expectValidationError(
      thrownBy(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, high_impact_dependents: 100_001 })),
      'event_policy.high_impact_dependents must be at most 100000. Got: 100001',
    )
    expect((await applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { highImpactDependents: 12 }, NOW)).high_impact_dependents).toBe(12)
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { highImpactDependents: 100_001 }, NOW)),
      'eventPolicy.high_impact_dependents must be at most 100000. Got: 100001',
    )
    expectValidationError(
      await rejectionOf(applyEventPolicyInput('acme', DEFAULT_EVENT_POLICY, { highImpactDependents: 2.5 }, NOW)),
      'eventPolicy.high_impact_dependents must be an integer >= 0. Got: 2.5',
    )
  })
})

// ── The metamodel lever ──────────────────────────────────────────────────────

describe('the policy cache is on the metamodel lever (third review · G4)', () => {
  const AT = 1_000
  beforeEach(() => invalidateEventPolicyCache())

  it('invalidateSchema(tenant), what a rename in the Dictionary calls, drops that tenant cached policy and no other', () => {
    cacheEventPolicy('acme', DEFAULT_EVENT_POLICY, AT)
    cacheEventPolicy('globex', GLOBEX, AT)
    invalidateSchema('acme')
    expect(getCachedEventPolicy('acme', AT)).toBeNull()
    expect(getCachedEventPolicy('globex', AT)).toBe(GLOBEX)
    expect(lastInvalidation()).toMatchObject({ tenantId: 'acme', failed: [] })
    expect(lastInvalidation()!.cleared).toContain('event_policy')
  })

  it('after a lost subscription the total purge drops the cached policy of every tenant (the cache knows how to clear all)', () => {
    cacheEventPolicy('acme', DEFAULT_EVENT_POLICY, AT)
    cacheEventPolicy('globex', GLOBEX, AT)
    const outcome = clearAllMetamodelCaches()
    expect(outcome.cleared).toContain('event_policy')
    expect(outcome.withoutClearAll).not.toContain('event_policy')
    expect(outcome.failed).toEqual([])
    expect(getCachedEventPolicy('acme', AT)).toBeNull()
    expect(getCachedEventPolicy('globex', AT)).toBeNull()
  })
})
