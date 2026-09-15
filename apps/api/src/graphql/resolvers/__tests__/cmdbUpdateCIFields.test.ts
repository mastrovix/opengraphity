/**
 * `updateCIFields` — la modifica di un CI dal dettaglio e dai criteri dei
 * gruppi dinamici.
 *
 * Revisione del 15 set 2026 · CM-2: questa strada scriveva da sé, senza
 * validazione del vocabolario, senza `name_key`, senza gancio della
 * manutenzione e senza audit. Dal vivo accettava `status: "pizza"` e una
 * proprietà `campo_inventato`. Adesso trova il tipo del CI e passa da
 * `updateCIRecord`, la stessa scrittura di `update<Tipo>`; le chiavi di
 * `customFields` devono essere campi del tipo, e i valori prendono il suo tipo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import { perms } from '../../../lib/__tests__/testPermissions.js'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))

function field(name: string, fieldType: string, over: Record<string, unknown> = {}) {
  return { id: name, name, label: name, fieldType, required: false, defaultValue: null, enumValues: [], order: 0, scope: 'tenant', tenantId: 't1', validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false, ...over }
}
const LB = {
  id: 'ct-lb', name: 'load_balancer', label: 'Load Balancer', neo4jLabel: 'LoadBalancer', scope: 'tenant', tenantId: 't1', active: true,
  icon: '', color: '', validationScript: null, serviceRole: null, relations: [], systemRelations: [],
  fields: [
    field('status', 'enum', { isSystem: true }),
    field('costCenter', 'string'), field('ports', 'number'), field('ha', 'boolean'), field('chain', 'enum', { isSystem: true }),
  ],
} as unknown as CITypeWithDefinitions

vi.mock('@opengraphity/schema-generator', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/schema-generator')>()
  return { ...orig, loadMetamodel: vi.fn(async () => [LB]) }
})
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v) }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn({ close: vi.fn() })) }))
const updateCIRecord = vi.fn(async (_s: unknown, _ctx: unknown, _t: unknown, _l: string, id: string, input: Record<string, unknown>) => ({ id, tenant_id: 't1', name: 'LB-01', ...input }))
vi.mock('../ciMutations.js', () => ({ updateCIRecord: (...a: Parameters<typeof updateCIRecord>) => updateCIRecord(...a) }))

const { ciInputFromFields, cmdbResolvers } = await import('../cmdb.js')
const { runQuery } = await import('@opengraphity/neo4j')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') as const }

function expectBadInput(fn: () => unknown, part: string) {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(GraphQLError)
  expect((thrown as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT')
  expect((thrown as GraphQLError).message).toContain(part)
}

beforeEach(() => { vi.clearAllMocks() })

describe('ciInputFromFields', () => {
  it('campi di base e campi del tipo, in camelCase come gli input del tipo', () => {
    expect(ciInputFromFields({ name: 'LB-01', status: 'active', customFields: JSON.stringify({ costCenter: 'IT-42' }) }, LB))
      .toEqual({ name: 'LB-01', status: 'active', costCenter: 'IT-42' })
  })

  it('CM-2: una chiave che il tipo non dichiara è rifiutata (dal vivo era finita sul CI una `campo_inventato`)', () => {
    let err: GraphQLError | null = null
    try { ciInputFromFields({ customFields: JSON.stringify({ campoInventato: 'x' }) }, LB) } catch (e) { err = e as GraphQLError }
    expect(err?.extensions?.['i18n']).toMatchObject({ key: 'errors.ci.unknownField', params: { field: 'campoInventato', type: 'Load Balancer' } })
  })

  it('un campo di sistema non passa da customFields', () => {
    expectBadInput(() => ciInputFromFields({ customFields: JSON.stringify({ chain: 'Application' }) }, LB), 'which the product manages')
  })

  it('i valori prendono il tipo del campo: numero, booleano, vuoto = null', () => {
    expect(ciInputFromFields({ customFields: JSON.stringify({ ports: '8443', ha: 'true', costCenter: '' }) }, LB))
      .toEqual({ ports: 8443, ha: true, costCenter: null })
    expectBadInput(() => ciInputFromFields({ customFields: JSON.stringify({ ports: 'tanti' }) }, LB), 'is not a number')
    expectBadInput(() => ciInputFromFields({ customFields: JSON.stringify({ ha: 'forse' }) }, LB), 'is not true or false')
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
    ['reserved labels',              JSON.stringify({ labels: ['Admin'] }),                  'system-managed'],
    ['product nameKey',              JSON.stringify({ nameKey: 'x' }),                       'which the product manages'],
    ['product health',               JSON.stringify({ health: 'down' }),                     'which the product manages'],
    ['not JSON',                     '{oops',                                                'not valid JSON'],
    ['JSON array',                   '[1,2]',                                                'must be a JSON object'],
  ]
  it.each(injections)('rifiuta %s', (_n, customFields, part) => {
    expectBadInput(() => ciInputFromFields({ customFields }, LB), part)
  })
})

describe('updateCIFields resolver', () => {
  it('CM-2: trova il tipo dall\'etichetta e scrive da updateCIRecord, la strada di update<Tipo>', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ label: 'LoadBalancer' }] as never)
    const out = await cmdbResolvers.Mutation.updateCIFields(undefined, {
      id: 'ci-1', input: { name: 'LB-02', status: 'pizza', customFields: JSON.stringify({ ports: '80' }) },
    }, ctx) as { type: string; name: string }
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('ci:LoadBalancer')
    expect(cypher).not.toContain('SET')
    expect(params).toMatchObject({ id: 'ci-1', tenantId: 't1' })
    // la validazione (e il rifiuto di `pizza`) sta in updateCIRecord: qui si pretende che ci si passi
    expect(updateCIRecord).toHaveBeenCalledWith(expect.anything(), ctx, LB, 'LoadBalancer', 'ci-1', { name: 'LB-02', status: 'pizza', ports: 80 })
    expect(out.type).toBe('load_balancer')
  })

  it('un CI che non esiste → NOT_FOUND senza scrivere', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    await expect(cmdbResolvers.Mutation.updateCIFields(undefined, { id: 'x', input: { name: 'n' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(updateCIRecord).not.toHaveBeenCalled()
  })

  it('un CI senza etichetta di tipo → CONFLICT che lo dice, non «unknown»', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ label: null }] as never)
    const err = await cmdbResolvers.Mutation.updateCIFields(undefined, { id: 'ci-1', input: { name: 'x' } }, ctx).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).extensions?.code).toBe('CONFLICT')
    expect((err as GraphQLError).message).toMatch(/has no type label/)
  })

  it('un\'etichetta che nessun tipo attivo dichiara → CONFLICT, senza scrivere', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ label: 'Server' }] as never)
    await expect(cmdbResolvers.Mutation.updateCIFields(undefined, { id: 'ci-1', input: { name: 'x' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'CONFLICT' } })
    expect(updateCIRecord).not.toHaveBeenCalled()
  })
})
