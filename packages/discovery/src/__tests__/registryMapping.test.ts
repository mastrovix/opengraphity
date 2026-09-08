import { describe, it, expect } from 'vitest'
import { registerConnector, getConnector, getAllConnectors } from '../registry.js'
import { applyMappingRules, inferCIType, normalizeProperties } from '../mapping.js'
import type { Connector } from '../connector.js'
import type { DiscoveredCI, MappingRule } from '../types.js'

function connector(type: string): Connector {
  return {
    type, displayName: type.toUpperCase(), supportedCITypes: ['server'],
    scan: async function* () {},
    testConnection: async () => ({ ok: true, message: 'ok' }),
    getRequiredCredentialFields: () => [],
    getConfigFields: () => [],
  }
}

describe('connector registry', () => {
  it('registers, looks up by type, lists; unknown type → undefined', () => {
    const aws = connector('aws-test')
    registerConnector(aws)
    expect(getConnector('aws-test')).toBe(aws)
    expect(getConnector('nope')).toBeUndefined()
    expect(getAllConnectors()).toContain(aws)
  })

  it('registering the same type twice → explicit error, first registration kept', () => {
    const first = connector('dup')
    registerConnector(first)
    expect(() => registerConnector(connector('dup'))).toThrow('Connector type "dup" is already registered')
    expect(getConnector('dup')).toBe(first)
    expect(getAllConnectors().filter(c => c.type === 'dup')).toHaveLength(1)
  })
})

function ci(over: Partial<DiscoveredCI> = {}): DiscoveredCI {
  return { external_id: 'i-1', source: 'aws', ci_type: '', name: 'web-01', properties: {}, tags: {}, relationships: [], ...over }
}

describe('applyMappingRules', () => {
  it('no rules → the same object; rules copy tag values into properties with the transform', () => {
    const input = ci({ tags: { Env: '  Prod ', Owner: 'DBA' }, properties: { keep: 1 } })
    expect(applyMappingRules(input, [])).toBe(input)

    const rules: MappingRule[] = [
      { source_field: 'Env', target_field: 'environment', transform: 'lowercase' },
      { source_field: 'Env', target_field: 'env_upper', transform: 'uppercase' },
      { source_field: 'Env', target_field: 'env_trim', transform: 'trim' },
      { source_field: 'Owner', target_field: 'owner', transform: 'none' },
      { source_field: 'Owner', target_field: 'owner_raw' },
      { source_field: 'Missing', target_field: 'never' },
    ]
    const out = applyMappingRules(input, rules)
    expect(out.properties).toEqual({
      keep: 1, environment: '  prod ', env_upper: '  PROD ', env_trim: 'Prod', owner: 'DBA', owner_raw: 'DBA',
    })
    expect(out.properties).not.toHaveProperty('never')
    // input not mutated
    expect(input.properties).toEqual({ keep: 1 })
    expect(out).not.toBe(input)
  })
})

describe('inferCIType', () => {
  it('an explicit ci_type wins over every heuristic', () => {
    expect(inferCIType(ci({ ci_type: 'storage', name: 'postgres-lb', properties: { engine: 'postgres' } }))).toBe('storage')
  })

  it.each([
    ['database_instance', ci({ properties: { engine: 'PostgreSQL' } })],
    ['database_instance', ci({ properties: { engine: 'mysql' } })],
    ['database',          ci({ properties: { engine: 'aurora' } })],
    ['database',          ci({ properties: { engine: 'dynamodb' } })],
    ['certificate',       ci({ properties: { certificate_arn: 'arn:x' } })],
    ['certificate',       ci({ name: 'wildcard-cert' })],
    ['load_balancer',     ci({ name: 'prod-alb', properties: { load_balancer_type: 'application' } })],
    ['load_balancer',     ci({ name: 'edge-lb' })],
    ['container',         ci({ name: 'api-container' })],
    ['storage',           ci({ name: 'assets-bucket' })],
    ['network',           ci({ name: 'main-vpc' })],
    ['network',           ci({ name: 'x', properties: { cidr_block: '10.0.0.0/16' } })],
    ['application',       ci({ name: 'billing-lambda' })],
    ['application',       ci({ name: 'x', properties: { app_name: 'billing' } })],
    ['server',            ci({ name: 'web-01' })],
  ])('→ %s', (expected, input) => {
    expect(inferCIType(input)).toBe(expected)
  })

  it('a non-string engine is ignored', () => {
    expect(inferCIType(ci({ name: 'web-01', properties: { engine: 42 } }))).toBe('server')
  })
})

describe('normalizeProperties', () => {
  it('drops null/undefined/blank strings, trims, and turns "true"/"false" into booleans; other values untouched', () => {
    expect(normalizeProperties({
      a: null, b: undefined, c: '', d: '   ', e: '  x  ', f: 'true', g: ' false ', h: 0, i: false, j: [1], k: { n: 1 }, l: 'TRUE',
    })).toEqual({ e: 'x', f: true, g: false, h: 0, i: false, j: [1], k: { n: 1 }, l: 'TRUE' })
  })
})
