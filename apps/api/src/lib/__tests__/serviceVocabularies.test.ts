/**
 * The closed vocabularies of monitored services, and the validators that
 * guard them.
 *
 * Why it matters: service rules and node roles are stored on the graph and
 * edited from the UI. A validator that fills a missing key with a default, or
 * guesses a role for an unknown CI label, would silently change how every
 * map of that tenant computes its health — a service shown "operational"
 * while its components are down. So every rejection must be loud and name
 * the offending value, and the few defaults that do exist (the 1080
 * migration's completion) must only fill keys that are absent.
 */
import { describe, it, expect } from 'vitest'
import {
  assertServiceRole, roleOfLabels, assertServiceImpactRules, parseServiceImpactRules,
  completeServiceImpactRules, sdlEnum, DEFAULT_SERVICE_IMPACT_RULES, DEFAULT_SERVICE_IMPACT_RULES_JSON,
  SERVICE_SDL_ENUMS, SERVICE_HEALTHS, SERVICE_HEALTH_SEVERITY_ORDER, ROLE_BY_CI_LABEL,
  SETTABLE_SERVICE_NODE_ROLES, SERVICE_NODE_ROLES,
} from '../serviceVocabularies.js'

describe('vocabulary invariants', () => {
  it('the severity order is a permutation of the health vocabulary', () => {
    expect([...SERVICE_HEALTH_SEVERITY_ORDER].sort()).toEqual([...SERVICE_HEALTHS].sort())
  })

  it('every seeded role is settable, and entry is never a type role', () => {
    for (const role of Object.values(ROLE_BY_CI_LABEL)) expect(SETTABLE_SERVICE_NODE_ROLES).toContain(role)
    expect(SETTABLE_SERVICE_NODE_ROLES).not.toContain('entry')
    expect(SERVICE_NODE_ROLES).toContain('entry')
  })
})

describe('assertServiceRole', () => {
  it('returns a settable role unchanged', () => {
    expect(assertServiceRole('infrastructure', 'service_role')).toBe('infrastructure')
  })

  it('refuses entry, unknown values and non-strings, naming the value', () => {
    expect(() => assertServiceRole('entry', 'service_role')).toThrow('service_role must be one of: component, infrastructure, certificate. Got: "entry"')
    expect(() => assertServiceRole(undefined, 'x')).toThrow('Got: undefined')
    expect(() => assertServiceRole(3, 'x')).toThrow('Got: 3')
  })
})

describe('roleOfLabels', () => {
  const roles = new Map([['Server', 'infrastructure'], ['Firewall', 'component']] as const)

  it('level 1 is always entry, whatever the type', () => {
    expect(roleOfLabels(roles, ['Nothing'], 1)).toBe('entry')
  })

  it('takes the first label a tenant type declares', () => {
    expect(roleOfLabels(roles, ['ConfigurationItem', 'Firewall'], 2)).toBe('component')
  })

  it('throws on labels no active type declares, instead of inventing a role', () => {
    expect(() => roleOfLabels(roles, ['ConfigurationItem', 'Gone'], 3))
      .toThrow('No service node role for CI labels ["ConfigurationItem","Gone"]')
    expect(() => roleOfLabels(roles, ['Gone'], 3)).toThrow('Known labels: Server, Firewall')
  })
})

describe('assertServiceImpactRules', () => {
  const ok = () => ({ ...DEFAULT_SERVICE_IMPACT_RULES }) as Record<string, unknown>

  it('accepts the defaults and returns a normalised copy', () => {
    const out = assertServiceImpactRules(ok())
    expect(out).toEqual(DEFAULT_SERVICE_IMPACT_RULES)
    expect(out).not.toBe(DEFAULT_SERVICE_IMPACT_RULES)
    expect(JSON.parse(DEFAULT_SERVICE_IMPACT_RULES_JSON)).toEqual(DEFAULT_SERVICE_IMPACT_RULES)
  })

  it.each([
    ['not an object', null, 'rules must be a JSON object'],
    ['an array', [], 'rules must be a JSON object'],
    ['wrong version', { ...ok(), version: 2 }, 'rules.version must be 1. Got: 2'],
    ['min_nodes 0', { ...ok(), min_nodes: 0 }, 'rules.min_nodes must be an integer >= 1'],
    ['min_nodes fractional', { ...ok(), min_nodes: 1.5 }, 'rules.min_nodes'],
    ['min_nodes as string', { ...ok(), min_nodes: '1' }, 'rules.min_nodes'],
    ['unknown_nodes out of vocabulary', { ...ok(), unknown_nodes: 'down' }, 'rules.unknown_nodes must be one of: ignore, operational'],
    ['open_incident_from missing', { ...ok(), open_incident_from: undefined }, 'rules.open_incident_from must be one of'],
    ['during_storm out of vocabulary', { ...ok(), during_storm: 'skip' }, 'rules.during_storm must be one of: evaluate, hold'],
    ['an unknown key', { ...ok(), extra: 1 }, 'rules has unknown keys: extra'],
    ['down_share_pct above 100', { ...ok(), down_share_pct: 101 }, 'rules.down_share_pct must be an integer between 0 and 100'],
    ['degraded_share_pct negative', { ...ok(), degraded_share_pct: -1 }, 'rules.degraded_share_pct'],
    ['degraded_share_pct missing', { ...ok(), degraded_share_pct: undefined }, 'rules.degraded_share_pct'],
  ])('refuses %s', (_label, value, message) => {
    expect(() => assertServiceImpactRules(value)).toThrow(message)
  })

  it('names the caller in the message', () => {
    expect(() => assertServiceImpactRules({ ...ok(), version: 0 }, 'ServiceMap m1 rules')).toThrow('ServiceMap m1 rules.version')
  })
})

describe('parseServiceImpactRules', () => {
  it('parses the stored JSON string', () => {
    expect(parseServiceImpactRules(DEFAULT_SERVICE_IMPACT_RULES_JSON, 'm1')).toEqual(DEFAULT_SERVICE_IMPACT_RULES)
  })

  it('refuses absent, non-string and corrupt rules, naming the map', () => {
    expect(() => parseServiceImpactRules(null, 'm1')).toThrow('ServiceMap m1 has no rules')
    expect(() => parseServiceImpactRules('', 'm1')).toThrow('ServiceMap m1 has no rules')
    expect(() => parseServiceImpactRules({}, 'm1')).toThrow('ServiceMap m1 rules is not a JSON string (got object)')
    expect(() => parseServiceImpactRules('{nope', 'm1')).toThrow('ServiceMap m1 rules is corrupt JSON')
    expect(() => parseServiceImpactRules('{"version":1}', 'm1')).toThrow('ServiceMap m1 rules.min_nodes')
  })
})

describe('completeServiceImpactRules', () => {
  it('returns null when nothing is missing, so complete rules are not rewritten', () => {
    expect(completeServiceImpactRules({ ...DEFAULT_SERVICE_IMPACT_RULES })).toBeNull()
  })

  it('fills only the absent keys and leaves present (even invalid) values alone', () => {
    const out = completeServiceImpactRules({ version: 1, down_share_pct: 999, min_nodes: 3 })
    expect(out).toEqual({ ...DEFAULT_SERVICE_IMPACT_RULES, down_share_pct: 999, min_nodes: 3 })
  })
})

describe('sdlEnum', () => {
  it('renders every SDL enum from its TypeScript list', () => {
    expect(sdlEnum('DuringStormMode')).toBe('enum DuringStormMode { evaluate hold }')
    for (const name of Object.keys(SERVICE_SDL_ENUMS) as Array<keyof typeof SERVICE_SDL_ENUMS>) {
      expect(sdlEnum(name)).toBe(`enum ${name} { ${SERVICE_SDL_ENUMS[name]!.join(' ')} }`)
    }
  })
})
