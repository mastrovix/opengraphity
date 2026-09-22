/**
 * Catalog form resolvers (resolvers/catalogForm.ts): the SUCCESS paths of the
 * field validators and the empty cases that catalogForm.test.ts leaves out.
 *
 * Why these behaviours matter:
 *  - translations: a label without a language would be stored under the key
 *    "undefined" and never shown; blank translations must not overwrite the
 *    fallback label;
 *  - a table field is stored as the document THIS version understands (not the
 *    raw text the client sent), so stray keys never reach the graph;
 *  - a ref_ci field keeps its CI types de-duplicated and its CMDB filter only
 *    after the real WHERE builder accepted it — a broken filter found by the
 *    requester would be a search that never finds anything;
 *  - a portal user must get NO form (the generic request) when every item of
 *    the form is workspace-only, not an empty form;
 *  - a request that is not in the tenant yields no answers, not someone
 *    else's.
 *
 * Only what talks to the database is faked; the real validation stays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import type { FormFieldDef } from '../../../lib/catalogForm.js'

const runQuery = vi.fn()
const runQueryOne = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close, executeWrite: vi.fn() })),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const formFields = vi.fn()
const formAnswersOf = vi.fn()
const etichetteDeiValori = vi.fn()
const cacheGet = vi.fn()
vi.mock('../../../lib/catalogForm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/catalogForm.js')>()),
  formFields: (...a: unknown[]) => formFields(...a),
  formFieldsByName: vi.fn(async () => new Map()),
  assertFormFieldName: vi.fn(async () => undefined),
  saveCatalogFormRevision: vi.fn(async () => undefined),
  formAnswersOf: (...a: unknown[]) => formAnswersOf(...a),
  etichetteDeiValori: (...a: unknown[]) => etichetteDeiValori(...a),
  formFieldsCache: { get: (...a: unknown[]) => cacheGet(...a) },
}))
vi.mock('../../../lib/catalogFormLimits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/catalogFormLimits.js')>()),
  assertLibraryRoom: vi.fn(async () => undefined),
  assertFormSize: vi.fn(async () => undefined),
}))
vi.mock('../../../lib/vocabularyEntries.js', () => ({
  loadVocabularyEntries: vi.fn(async (_t: string, name: string) => {
    if (name !== 'state') throw new GraphQLError(`Vocabulary "${name}" does not exist`, { extensions: { code: 'BAD_USER_INPUT' } })
    return { values: ['open', 'closed'], labels: {} }
  }),
}))
vi.mock('../../../lib/schemaInvalidator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/schemaInvalidator.js')>()),
  invalidateSchema: vi.fn(),
}))
vi.mock('../../../services/formDesignerService.js', () => ({ proponiModulo: vi.fn() }))
vi.mock('../../../lib/tenantLanguage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/tenantLanguage.js')>()),
  languageFor: vi.fn(async () => 'en'),
}))
const ticketPropsOf = vi.fn((): Record<string, unknown> | null => null)
vi.mock('../../../lib/ticketProps.js', () => ({ ticketPropsOf: () => ticketPropsOf() }))

const { catalogFormResolvers, serviceRequestFormAnswers, serviceRequestFormFieldValues } = await import('../catalogForm.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: perms('admin') } as never

function field(p: Partial<FormFieldDef> & { name: string }): FormFieldDef {
  return {
    id: `id-${p.name}`, fieldType: 'text', label: p.name, labels: [], help: null, helps: [],
    required: false, vocabulary: null, validationScript: null, formula: null, tableDefinition: null,
    refTypes: [], refFilter: null, shared: false, inList: false, createdAt: null, updatedAt: null,
    ...p,
  } as FormFieldDef
}

async function refusal(fn: () => Promise<unknown>): Promise<{ key: string | null; message: string }> {
  try { await fn(); return { key: 'NO REFUSAL', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { key: (g.extensions?.['i18n'] as { key?: string } | undefined)?.key ?? null, message: g.message }
  }
}

/** The params of the CREATE (f:FormField) write. */
const createParams = () => runQuery.mock.calls.find((c) => String(c[1]).includes('CREATE (f:FormField'))![2] as Record<string, unknown>
const create = (input: Record<string, unknown>) => catalogFormResolvers.Mutation.createFormField(null, { input }, ctx)

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  runQuery.mockResolvedValue([])
  runQueryOne.mockResolvedValue({ n: 0 })
  formFields.mockImplementation(async () => [field({ name: 'f' })])
  ticketPropsOf.mockReturnValue(null)
})

describe('createFormField — what gets stored', () => {
  it('translations are keyed by language and blank ones are dropped', async () => {
    await create({
      name: 'f', fieldType: 'text', label: 'F',
      labels: [{ language: 'it', text: 'Campo' }, { language: 'de', text: '  ' }],
      helps: [{ language: 'en', text: 'Help' }],
    })
    const p = createParams()
    expect(JSON.parse(p['labels'] as string)).toEqual({ it: 'Campo' })
    expect(JSON.parse(p['helps'] as string)).toEqual({ en: 'Help' })
  })

  it('a translation without a language is refused', async () => {
    const r = await refusal(() => create({ name: 'f', fieldType: 'text', label: 'F', labels: [{ language: ' ', text: 'x' }] }))
    expect(r.key).toBe('errors.formField.labelLanguage')
  })

  it('an enum field keeps the vocabulary it names, trimmed', async () => {
    await create({ name: 'f', fieldType: 'enum', label: 'F', vocabulary: ' state ' })
    expect(createParams()['vocabulary']).toBe('state')
  })

  it('a table is re-serialised from the parsed document, dropping unknown keys', async () => {
    const table = { version: 1, columns: [{ name: 'qty', label: 'Qty', fieldType: 'number' }], junk: 'x' }
    await create({ name: 'f', fieldType: 'table', label: 'F', tableDefinition: JSON.stringify(table) })
    const stored = JSON.parse(createParams()['tableDefinition'] as string) as Record<string, unknown>
    expect(stored).not.toHaveProperty('junk')
    expect((stored['columns'] as Array<{ name: string }>).map((c) => c.name)).toEqual(['qty'])
  })

  it('ref_ci: known CI types are stored once each, and no filter means the whole of those types', async () => {
    runQuery.mockImplementation(async (_s: unknown, cypher: string) =>
      (String(cypher).includes('RETURN t.name AS name') ? [{ name: 'server' }, { name: 'printer' }] : []))
    await create({ name: 'f', fieldType: 'ref_ci', label: 'F', refTypes: ['server', ' server ', 'printer', ''] })
    const p = createParams()
    expect(p['refTypes']).toEqual(['server', 'printer'])
    expect(p['refFilter']).toBeNull()
  })

  it('ref_ci: a filter on a property of the chosen types is accepted and stored as sent', async () => {
    const filter = JSON.stringify({ rules: [{ field: 'vendor', operator: 'equals', value: 'Dell' }] })
    runQuery.mockImplementation(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
      if (String(cypher).includes('HAS_FIELD')) {
        // The allowed properties are read for the chosen types, inside the tenant.
        expect(params).toEqual({ tenantId: 't1', tipi: ['server'] })
        return [{ name: 'vendor' }]
      }
      if (String(cypher).includes('RETURN t.name AS name')) return [{ name: 'server' }]
      return []
    })
    await create({ name: 'f', fieldType: 'ref_ci', label: 'F', refTypes: ['server'], refFilter: filter })
    expect(createParams()['refFilter']).toBe(filter)
  })
})

describe('catalogFormToFill for the portal', () => {
  it('a form whose every item is workspace-only gives no form at all (the generic request)', async () => {
    runQueryOne.mockResolvedValue({
      id: 'v1', name: 'Laptop', updatedAt: null,
      form: JSON.stringify({ version: 1, revision: 2, sections: [{ id: 'main', title: { en: 'S' }, items: [{ field: 'internal', endUser: false }] }] }),
    })
    expect(await catalogFormResolvers.Query.catalogFormToFill(null, { itemId: 'v1', endUser: true }, ctx)).toBeNull()
  })
})

describe('answers of a request that is not in this tenant', () => {
  it('formAnswers: no row, no answers', async () => {
    runQueryOne.mockResolvedValue(null)
    expect(await serviceRequestFormAnswers({ id: 'r-other', catalogItemId: 'v1', formRevision: 1 }, null, ctx)).toEqual([])
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ id: 'r-other', tenantId: 't1' })
    expect(formAnswersOf).not.toHaveBeenCalled()
  })

  it('formFieldValues: no row, no values', async () => {
    cacheGet.mockResolvedValue([field({ name: 'plate', inList: true })])
    runQueryOne.mockResolvedValue(null)
    expect(await serviceRequestFormFieldValues({ id: 'r-other' }, null, ctx)).toEqual([])
  })
})

describe('formFieldValues on a multi-value field', () => {
  it('a list answer comes out as values with their readable labels, and no single value', async () => {
    cacheGet.mockResolvedValue([field({ name: 'tags', fieldType: 'multi_enum', vocabulary: 'state', inList: true })])
    etichetteDeiValori.mockResolvedValue(() => (v: string) => v.toUpperCase())
    // The list query already read the props: no session is opened.
    ticketPropsOf.mockReturnValue({ tags: ['open', 'closed'] })
    const out = await serviceRequestFormFieldValues({ id: 'r1' }, null, ctx)
    expect(out[0]).toMatchObject({ name: 'tags', value: null, values: ['open', 'closed'], displayValues: ['OPEN', 'CLOSED'] })
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})
