/**
 * The `entityFilterFields` resolver: what the FilterBuilder offers beyond the
 * static GraphQL schema.
 *
 * Why these behaviours matter for a user:
 *  - tenant custom fields are not in the schema; if the resolver stops adding
 *    them, an agent cannot filter incidents on the fields their admin created;
 *  - catalogue-form library fields are only offered on service requests (the
 *    forms write them only there); offering them on incidents would build
 *    filters that never match anything;
 *  - a multi-select field is stored as a list: without `multi: true` the client
 *    offers "equals", which silently finds nothing;
 *  - table fields are filtered per ROW with relation operators (`rowFilter`),
 *    and labelled "Table · Column" in the tenant's language — otherwise the
 *    filter shows raw property names while the rest of the product shows labels;
 *  - everything is read for `ctx.tenantId`: one tenant's vocabulary must never
 *    label another tenant's filter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildSchema, type GraphQLResolveInfo } from 'graphql'

const fake = vi.hoisted(() => ({
  customDefs: [] as Array<Record<string, unknown>>,
  library:    [] as Array<Record<string, unknown>>,
  vocabularies: {} as Record<string, { values: string[]; labels: Record<string, Record<string, string>> }>,
  language: 'it',
  seenTenants: [] as string[],
}))

vi.mock('../ticketCustomFields.js', () => ({
  requestCustomFieldDefs: vi.fn(async (ctx: { tenantId: string }) => { fake.seenTenants.push(ctx.tenantId); return fake.customDefs }),
}))
vi.mock('../../../lib/catalogForm.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  formFields: vi.fn(async (_s: unknown, tenantId: string) => { fake.seenTenants.push(tenantId); return fake.library }),
}))
vi.mock('../../../lib/vocabularyEntries.js', () => ({
  loadVocabularyEntries: vi.fn(async (tenantId: string, name: string) => {
    fake.seenTenants.push(tenantId)
    const v = fake.vocabularies[name]
    if (!v) throw new Error(`no vocabulary ${name}`)
    return { values: v.values, labels: v.labels, colors: {} }
  }),
}))
vi.mock('../ci-utils.js', () => ({
  withSession: async <T>(fn: (s: unknown) => Promise<T>) => fn({}),
}))
vi.mock('../../../lib/tenantLanguage.js', () => ({
  languageFor: vi.fn(async (tenantId: string) => { fake.seenTenants.push(tenantId); return fake.language }),
}))

const { entityFilterFieldsResolvers } = await import('../entityFilterFields.js')

const schema = buildSchema(`
  enum Status { open closed }
  type User { id: ID! }
  type Incident { id: ID!, title: String, status: Status, tags: [String], owner: User }
  type ServiceRequest { id: ID!, title: String }
  type Widget { id: ID!, size: Int }
  type Query { x: Int }
`)

const info = { schema } as unknown as GraphQLResolveInfo
const ctx = { tenantId: 't-acme' } as never

function run(typeName: string) {
  return entityFilterFieldsResolvers.Query.entityFilterFields(undefined, { typeName }, ctx, info)
}

function field(overrides: Record<string, unknown>) {
  return {
    id: 'f', name: 'x', fieldType: 'text', label: 'X', labels: [], help: null, helps: [],
    required: false, vocabulary: null, validationScript: null, formula: null, tableDefinition: null,
    ...overrides,
  }
}

beforeEach(() => {
  fake.customDefs = []; fake.library = []; fake.vocabularies = {}
  fake.language = 'it'; fake.seenTenants = []
})

describe('types without tenant custom fields', () => {
  it('return only the schema fields and never ask for custom fields', async () => {
    const out = await run('Widget')
    expect(out.map((f) => f.name)).toEqual(['id', 'size'])
    // Widget is not a ticket: no metamodel read at all.
    expect(fake.seenTenants).toEqual([])
  })
})

describe('ticket custom fields', () => {
  it('are appended with the scalar matching their type, and enums keep their values', async () => {
    fake.customDefs = [
      { name: 'cost', fieldType: 'number' },
      { name: 'vip', fieldType: 'boolean' },
      { name: 'notes', fieldType: 'string' },
      { name: 'tier', fieldType: 'enum', enumValues: ['gold', 'silver'] },
    ]
    const out = await run('Incident')
    const byName = new Map(out.map((f) => [f.name, f]))
    expect(byName.get('cost')?.scalarName).toBe('Float')
    expect(byName.get('vip')?.scalarName).toBe('Boolean')
    expect(byName.get('notes')?.scalarName).toBe('String')
    expect(byName.get('tier')).toMatchObject({ kind: 'ENUM', enumValues: ['gold', 'silver'], scalarName: null })
    // Lists and object relations of the schema stay out.
    expect(byName.has('tags')).toBe(false)
    expect(byName.has('owner')).toBe(false)
  })

  it('a custom field shadowing a schema field is not offered twice', async () => {
    fake.customDefs = [{ name: 'title', fieldType: 'number' }]
    const out = await run('Incident')
    const titles = out.filter((f) => f.name === 'title')
    expect(titles).toHaveLength(1)
    // The schema definition wins: it is what the filter engine actually queries.
    expect(titles[0]?.scalarName).toBe('String')
  })

  it('catalogue-form library fields are NOT offered on incidents', async () => {
    fake.library = [field({ name: 'laptop_model' })]
    const out = await run('Incident')
    expect(out.some((f) => f.name === 'laptop_model')).toBe(false)
  })
})

describe('service requests: catalogue-form library fields', () => {
  it('plain fields carry label, form type, scalar and automation-settability', async () => {
    fake.library = [
      field({ name: 'budget', fieldType: 'number', label: 'Budget' }),
      field({ name: 'urgent', fieldType: 'boolean', label: 'Urgent' }),
      field({ name: 'reason', fieldType: 'text', label: 'Reason' }),
      field({ name: 'computed', fieldType: 'text', label: 'Computed', formula: 'return 1' }),
    ]
    const out = await run('ServiceRequest')
    const byName = new Map(out.map((f) => [f.name, f]))
    expect(byName.get('budget')).toMatchObject({ kind: 'SCALAR', scalarName: 'Float', label: 'Budget', formFieldType: 'number', settableByAutomation: true, multi: false, rowFilter: false })
    expect(byName.get('urgent')?.scalarName).toBe('Boolean')
    expect(byName.get('reason')?.scalarName).toBe('String')
    // A formula field is computed by the server: an automation must not be offered to write it.
    expect(byName.get('computed')?.settableByAutomation).toBe(false)
  })

  it('vocabulary fields become enums labelled in the tenant language, multi-select flagged as a list', async () => {
    fake.vocabularies = {
      envs: { values: ['production', 'staging'], labels: { production: { it: 'Produzione', en: 'Production' } } },
    }
    fake.library = [
      field({ name: 'envs', fieldType: 'multi_enum', label: 'Ambienti', vocabulary: 'envs' }),
      field({ name: 'env', fieldType: 'enum', label: 'Ambiente', vocabulary: 'envs' }),
    ]
    const out = await run('ServiceRequest')
    const multi = out.find((f) => f.name === 'envs')!
    expect(multi).toMatchObject({ kind: 'ENUM', enumValues: ['production', 'staging'], vocabulary: 'envs', multi: true, settableByAutomation: false })
    // Missing label falls back to a readable title case, not the raw value.
    expect(multi.choices).toEqual([{ value: 'production', label: 'Produzione' }, { value: 'staging', label: 'Staging' }])
    expect(out.find((f) => f.name === 'env')).toMatchObject({ multi: false, settableByAutomation: true })
  })

  it('notes, and fields already offered by schema or custom fields, are left out', async () => {
    fake.customDefs = [{ name: 'priority_hint', fieldType: 'string' }]
    fake.library = [
      field({ name: 'intro', fieldType: 'note' }),
      field({ name: 'title', fieldType: 'text' }),
      field({ name: 'priority_hint', fieldType: 'text' }),
    ]
    const out = await run('ServiceRequest')
    expect(out.some((f) => f.name === 'intro')).toBe(false)
    expect(out.filter((f) => f.name === 'title')).toHaveLength(1)
    expect(out.filter((f) => f.name === 'priority_hint')).toHaveLength(1)
    expect(out.find((f) => f.name === 'priority_hint')?.formFieldType).toBeNull()
  })

  it('a table becomes one row-filter field per column, labelled "Table · Column"', async () => {
    fake.vocabularies = { roles: { values: ['admin'], labels: { admin: { it: 'Amministratore' } } } }
    fake.library = [
      field({
        name: 'people', fieldType: 'table', label: 'Persone da abilitare',
        tableDefinition: { columns: [
          { name: 'email', labels: { en: 'Email', it: 'Posta' }, fieldType: 'text' },
          { name: 'role', labels: { it: 'Ruolo' }, fieldType: 'enum', vocabulary: 'roles' },
        ] },
      }),
      // A table without a definition is broken data: it offers nothing rather than crashing.
      field({ name: 'broken', fieldType: 'table', label: 'Broken', tableDefinition: null }),
    ]
    const out = await run('ServiceRequest')
    // The table itself is not a value and is not offered as one.
    expect(out.some((f) => f.name === 'people' || f.name === 'broken')).toBe(false)
    const rows = out.filter((f) => f.rowFilter)
    expect(rows).toHaveLength(2)
    const [email, role] = rows
    expect(email).toMatchObject({ kind: 'SCALAR', scalarName: 'String', label: 'Persone da abilitare · Posta', formFieldType: 'text', vocabulary: null, settableByAutomation: false })
    expect(email?.name).toMatch(/^people.+email$/)
    expect(role).toMatchObject({ kind: 'ENUM', enumValues: ['admin'], label: 'Persone da abilitare · Ruolo', vocabulary: 'roles' })
    expect(role?.choices).toEqual([{ value: 'admin', label: 'Amministratore' }])
  })

  it('every read is scoped to the caller tenant', async () => {
    fake.vocabularies = { envs: { values: ['a'], labels: {} } }
    fake.library = [field({ name: 'env', fieldType: 'enum', vocabulary: 'envs' })]
    await run('ServiceRequest')
    expect(fake.seenTenants.length).toBeGreaterThan(0)
    expect(new Set(fake.seenTenants)).toEqual(new Set(['t-acme']))
  })

  it('an invalid type name is rejected before any tenant data is read', async () => {
    await expect(run('__Schema')).rejects.toThrow(/invalid typeName/)
    expect(fake.seenTenants).toEqual([])
  })
})
