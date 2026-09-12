import { describe, it, expect, vi } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  runQuery: vi.fn(),
  runQueryOne: vi.fn(),
}))

const { buildCIFieldUpdates, cmdbResolvers } = await import('../cmdb.js')
const { getSession, runQuery } = await import('@opengraphity/neo4j')

const NOW = '2026-09-08T00:00:00.000Z'

function expectBadInput(fn: () => unknown, part: string) {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(GraphQLError)
  expect((thrown as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT')
  expect((thrown as GraphQLError).message).toContain(part)
}

describe('buildCIFieldUpdates (B-01)', () => {
  it('maps base fields + camelCase custom keys to a parameter object', () => {
    expect(buildCIFieldUpdates({ name: 'web-01', customFields: JSON.stringify({ ipAddress: '10.0.0.1', rack_unit: 12 }) }, NOW))
      .toEqual({ updated_at: NOW, name: 'web-01', ip_address: '10.0.0.1', rack_unit: 12 })
  })

  const injections: Array<[string, string, string]> = [
    ['SET injection via key',        JSON.stringify({ 'x = 1 SET ci.tenant_id': 'evil' }), 'invalid field name'],
    ['closing brace / comment',      JSON.stringify({ 'foo}) DETACH DELETE ci //': 1 }),     'invalid field name'],
    ['backtick',                     JSON.stringify({ 'a`b': 1 }),                           'invalid field name'],
    ['space',                        JSON.stringify({ 'a b': 1 }),                           'invalid field name'],
    ['leading underscore (PascalCase)', JSON.stringify({ Foo: 1 }),                          'invalid field name'],
    ['reserved tenant_id',           JSON.stringify({ tenant_id: 'other' }),                 'system-managed'],
    ['reserved tenantId (camel)',    JSON.stringify({ tenantId: 'other' }),                  'system-managed'],
    ['reserved id',                  JSON.stringify({ id: 'x' }),                            'system-managed'],
    ['reserved created_at',          JSON.stringify({ created_at: 'x' }),                    'system-managed'],
    ['reserved labels',              JSON.stringify({ labels: ['Admin'] }),                  'system-managed'],
    ['not JSON',                     '{oops',                                                'not valid JSON'],
    ['JSON array',                   '[1,2]',                                                'must be a JSON object'],
  ]
  it.each(injections)('rejects %s', (_n, customFields, part) => {
    expectBadInput(() => buildCIFieldUpdates({ customFields }, NOW), part)
  })
})

describe('updateCIFields resolver', () => {
  it('uses SET ci += $updates with a parameter map (no key in the query text)', async () => {
    const session = { close: vi.fn() }
    vi.mocked(getSession).mockReturnValue(session as never)
    // L'etichetta è parte del contratto: `mapCI` deriva il tipo da lì (i nodi CI
    // non portano `type`).
    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'ci-1', name: 'web-01', tenant_id: 't1' }, label: 'LoadBalancer' }] as never)

    const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' as const }
    await cmdbResolvers.Mutation.updateCIFields(undefined, {
      id: 'ci-1', input: { name: 'web-01', customFields: JSON.stringify({ ipAddress: '10.0.0.1' }) },
    }, ctx)

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('SET ci += $updates')
    // A-9: predicato dal metamodello del tenant (prima un CI di un tipo del
    // cliente non veniva trovato e la modifica diceva «non trovato»).
    expect(cypher).toContain('ci:LoadBalancer')
    expect(cypher).not.toContain('ip_address')
    expect(params).toMatchObject({ id: 'ci-1', tenantId: 't1', updates: { name: 'web-01', ip_address: '10.0.0.1' } })
  })

  it('rejects an injected key before touching the database', async () => {
    vi.mocked(runQuery).mockClear()
    const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' as const }
    await expect(cmdbResolvers.Mutation.updateCIFields(undefined, {
      id: 'ci-1', input: { customFields: JSON.stringify({ 'x = 1 SET ci.tenant_id': 'evil' }) },
    }, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(runQuery).not.toHaveBeenCalled()
  })
})

// ── Il tipo viene dall'ETICHETTA (revisione delle otto ondate) ───────────────
//
// `mapCI` ripiegava su `props.type`, che sui nodi CI NON esiste (dal vivo: 0 su
// 2049): il tipo diventava `'unknown'` e il `__resolveType` — reso fail-loud
// nell'ondata 6, correttamente — lanciava DOPO la scrittura. Il salvataggio di
// un CI dal web riusciva e rispondeva errore, per ogni CI di ogni cliente.
// Il difetto non era il fail-loud: era questo chiamante, che non gli passava
// l'informazione che possiede.
describe('updateCIFields — il tipo dall\'etichetta, e le proprietà del prodotto', () => {
  const props = { id: 'ci-1', tenant_id: 't1', name: 'LB-01', status: 'active' }
  const call = (input: Record<string, unknown>) =>
    cmdbResolvers.Mutation.updateCIFields(undefined, { id: 'ci-1', input }, { tenantId: 't1', userId: 'u', userEmail: 'u@x', role: 'operator' as const })

  it('chiede l\'etichetta nella query e risolve il tipo del CLIENTE', async () => {
    vi.mocked(getSession).mockReturnValue({ close: vi.fn() } as never)
    vi.mocked(runQuery).mockResolvedValue([{ props, label: 'LoadBalancer' }] as never)
    const out = await call({ name: 'LB-01' }) as { type: string }
    const [, cypher] = vi.mocked(runQuery).mock.calls.at(-1)!
    expect(cypher).toContain("head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label")
    expect(out.type).toBe('load_balancer')
  })

  it('un CI senza etichetta di tipo → CONFLICT che lo dice, non «unknown»', async () => {
    vi.mocked(getSession).mockReturnValue({ close: vi.fn() } as never)
    vi.mocked(runQuery).mockResolvedValue([{ props, label: null }] as never)
    const err = await call({ name: 'x' }).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).extensions?.code).toBe('CONFLICT')
    expect((err as GraphQLError).message).toMatch(/non ha un'etichetta di tipo/)
  })

  // La guardia sulle chiavi è DOPPIA: forma (anti-injection) + riservate dei CI.
  // Da `customFields` passavano `name_key`, `health`, `chain`, `type` e i
  // `discovery_*`: la fuga che l'ondata 5 aveva chiuso su `ciMutations`.
  it.each(['nameKey', 'health', 'healthSource', 'chain', 'type', 'discoverySourceId'])(
    'rifiuta la proprietà del prodotto "%s" senza scrivere', (key) => {
      expectBadInput(() => buildCIFieldUpdates({ customFields: JSON.stringify({ [key]: 'x' }) }, NOW), 'gestita dal prodotto')
    })

  it('un campo normale del cliente passa', () => {
    expect(buildCIFieldUpdates({ customFields: JSON.stringify({ costCenter: 'IT-42' }) }, NOW))
      .toEqual({ updated_at: NOW, cost_center: 'IT-42' })
  })
})
