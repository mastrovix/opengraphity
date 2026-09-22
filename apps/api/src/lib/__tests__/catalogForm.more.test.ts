/**
 * Catalog forms: the edges the first suite leaves open.
 *
 * Why these behaviours matter, one line each:
 *
 *  - THE SHAPE OF A STORED DOCUMENT (form and table definition): every wrong
 *    shape must be a loud error that names what is wrong. A document read as
 *    "empty" would look like a configuration, and the customer would build a
 *    second one on top of the first without knowing.
 *  - THE ANSWERS: a hidden, read-only or computed field that arrives anyway is
 *    refused; a Dictionary with no values is a configuration error, never a
 *    licence to accept any text; a computed team must exist, or the workflow
 *    task it routes would have nobody to go to.
 *  - READING BACK: references, files and table rows are grouped by field, so
 *    the request page shows each answer under its own question.
 *  - CORRECTING AN ANSWER (`writeFormAnswer`): list answers stay lists for the
 *    condition evaluator, answers the form no longer asks are cleared, and a
 *    missing ticket or frozen revision is an error rather than a silent no-op.
 *  - WRITING REFERENCES: an unknown reference type must fail loudly instead of
 *    dropping the relation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from 'neo4j-driver'
import type { CatalogFormDefinition, FormTableDefinition } from '@opengraphity/types'

// ── Programmable graph ──────────────────────────────────────────────────────

type Handler = (query: string, params: Record<string, unknown>) => unknown
let onQuery: Handler = () => []
let onQueryOne: Handler = () => null
const queries: Array<{ query: string; params: Record<string, unknown> }> = []
const sessionClose = vi.fn(async () => undefined)

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: sessionClose })),
  runQuery: vi.fn(async (_s: unknown, query: string, params: Record<string, unknown> = {}) => {
    queries.push({ query, params })
    return onQuery(query, params)
  }),
  runQueryOne: vi.fn(async (_s: unknown, query: string, params: Record<string, unknown> = {}) => {
    queries.push({ query, params })
    return onQueryOne(query, params)
  }),
}))

vi.mock('../vocabularyEntries.js', () => ({
  loadVocabularyEntries: vi.fn(async (_t: string, name: string) => {
    if (name === 'env') return { values: ['prod', 'dev'], labels: { prod: { en: 'Production', it: 'Produzione' } }, colors: {} }
    if (name === 'systems') return { values: ['mail', 'crm'], labels: {}, colors: {} }
    if (name === 'empty') return { values: [], labels: {}, colors: {} }
    throw new Error(`Vocabulary "${name}" does not exist`)
  }),
}))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))
vi.mock('../metamodelScript.js', () => ({
  runValidationScript: vi.fn(async () => null),
  runFormulaScript: vi.fn(async () => ({ ok: true, value: null })),
}))
vi.mock('../customFieldName.js', () => ({
  assertCustomFieldName: vi.fn(async (_s: unknown, _t: string, _e: string, name: string) => {
    if (name === 'id') throw new Error('reserved name')
  }),
}))

const mod = await import('../catalogForm.js')
const {
  formFieldsCache, formFieldsWithFormula, formFieldsByName, formFieldAutomationMetas, assertFormFieldName,
  parseCatalogForm, assertCatalogForm, resolveFormWrites, parseFormTable, assertFormTable, leggiRigheTabella,
  validaRigheTabella, saveCatalogFormRevision, formAnswersOf, writeFormReferences, writeFormAnswer,
} = mod
type FormFieldDef = import('../catalogForm.js').FormFieldDef
const { runFormulaScript, runValidationScript } = await import('../metamodelScript.js')

const session = {} as Session

beforeEach(() => {
  onQuery = () => []
  onQueryOne = () => null
  queries.length = 0
  sessionClose.mockClear()
  vi.mocked(runFormulaScript).mockReset().mockResolvedValue({ ok: true, value: null } as never)
  vi.mocked(runValidationScript).mockReset().mockResolvedValue(null)
  formFieldsCache.clear()
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function field(name: string, fieldType: string, extra: Partial<FormFieldDef> = {}): FormFieldDef {
  return {
    id: `id-${name}`, name, fieldType: fieldType as FormFieldDef['fieldType'], label: name, labels: [],
    help: null, helps: [], required: false, vocabulary: null, validationScript: null, formula: null,
    tableDefinition: null, refTypes: [], refFilter: null, shared: false, inList: false,
    createdAt: null, updatedAt: null, ...extra,
  }
}
const lib = (...fields: FormFieldDef[]) => new Map(fields.map((f) => [f.name, f]))

/** The raw row shape `mapField` reads, as Neo4j returns it. */
function row(name: string, fieldType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `id-${name}`, name, fieldType, label: name, labels: null, helps: null, ...extra }
}

function form(items: CatalogFormDefinition['sections'][number]['items'], revision = 1): CatalogFormDefinition {
  return { version: 1, revision, sections: [{ id: 'main', title: { en: 'Main', it: 'Principale' }, items }] }
}

/** The i18n key of the error thrown by `fn`: the key is the contract the UI translates. */
async function errorKey(fn: () => unknown): Promise<string> {
  try { await fn() } catch (e) {
    const ext = (e as { extensions?: { i18n?: { key?: string } } }).extensions
    return ext?.i18n?.key ?? `plain: ${(e as Error).message}`
  }
  throw new Error('expected a rejection')
}

const TABLE: FormTableDefinition = {
  version: 1,
  columns: [
    { name: 'role', labels: { en: 'Role' }, fieldType: 'enum', vocabulary: 'env', required: true },
    { name: 'qty', labels: {}, fieldType: 'number', vocabulary: null, required: false },
    { name: 'ok', labels: { en: '  ' }, fieldType: 'boolean', vocabulary: null, required: false },
    { name: 'when', labels: {}, fieldType: 'date', vocabulary: null, required: false },
    { name: 'kind', labels: {}, fieldType: 'enum', vocabulary: 'empty', required: false },
  ],
}

// ── The library ─────────────────────────────────────────────────────────────

describe('the field library', () => {
  it('the list cache reads with a READ session, maps legacy rows prudently, and closes the session', async () => {
    onQuery = () => [row('model', 'text', { label: null, help: '', refTypes: 'not-a-list', inList: 'yes', shared: true, refFilter: '' })]
    const [f] = await formFieldsCache.get('t1')
    // A field born before these columns existed: label falls back to the
    // name, no CI filter (the whole CMDB, as before), not a list column.
    expect(f).toMatchObject({ name: 'model', label: 'model', help: null, refTypes: [], inList: false, shared: true, refFilter: null })
    expect(sessionClose).toHaveBeenCalled()
  })

  it('declared CI types are read as a list of strings', async () => {
    onQuery = () => [row('app', 'ref_ci', { refTypes: ['business_application', 7] })]
    const [f] = await formFieldsCache.get('t3')
    expect(f!.refTypes).toEqual(['business_application', '7'])
  })

  it('an unknown field type is an error, not a half-rendered field', async () => {
    onQuery = () => [row('weird', 'hologram')]
    await expect(formFieldsCache.get('t2')).rejects.toThrow(/unknown field type "hologram"/)
  })

  it('formFieldsWithFormula returns labels and closes the session even on failure', async () => {
    onQuery = () => [{ label: 'Total' }]
    expect(await formFieldsWithFormula('t1')).toEqual(['Total'])
    onQuery = () => { throw new Error('db down') }
    await expect(formFieldsWithFormula('t1')).rejects.toThrow('db down')
    expect(sessionClose).toHaveBeenCalledTimes(2)
  })

  it('formFieldsByName with no names does not touch the graph', async () => {
    expect((await formFieldsByName(session, 't1', [])).size).toBe(0)
    expect(queries).toHaveLength(0)
  })

  it('automation metas: only settable fields of service requests, with their vocabulary values', async () => {
    onQuery = () => [
      row('env', 'enum', { vocabulary: 'env' }),
      row('note_x', 'textarea'),
      row('systems', 'multi_enum', { vocabulary: 'systems' }),
      row('total', 'number', { formula: 'x' }),
      row('file', 'attachment'),
    ]
    const metas = await formFieldAutomationMetas(session, 't1', 'service_request')
    expect([...metas.keys()].sort()).toEqual(['env', 'note_x'])
    expect(metas.get('env')).toEqual({ name: 'env', fieldType: 'enum', enumValues: ['prod', 'dev'], enumTypeName: 'env' })
    expect(metas.get('note_x')).toMatchObject({ fieldType: 'string', enumValues: [], enumTypeName: null })
    // Other ticket kinds never fill a form.
    expect((await formFieldAutomationMetas(session, 't1', 'incident')).size).toBe(0)
  })

  it('a library field name obeys the custom field name rules', async () => {
    await expect(assertFormFieldName(session, 't1', 'id')).rejects.toThrow('reserved name')
    await expect(assertFormFieldName(session, 't1', 'model')).resolves.toBeUndefined()
  })
})

// ── The stored form document ───────────────────────────────────────────────

describe('parseCatalogForm: every wrong shape is named', () => {
  const doc = (section: unknown) => JSON.stringify({ version: 1, revision: 1, sections: [section] })
  const withItem = (item: unknown) => doc({ id: 'a', title: { en: 'A' }, items: [item] })

  it.each([
    ['a list instead of an object', '[]', /expected an object/],
    ['a non-integer version', JSON.stringify({ version: 1.5, revision: 0, sections: [] }), /version must be a positive integer/],
    ['sections that are not a list', JSON.stringify({ version: 1, revision: 0, sections: {} }), /sections must be a list/],
    ['a non-string title', doc({ id: 'a', title: { en: 3 }, items: [] }), /the en text is not a string/],
    ['items that are not a list', doc({ id: 'a', items: 'x' }), /items must be a list/],
    ['a bad condition match', doc({ id: 'a', items: [], visibleWhen: { match: 'some', rules: [] } }), /match must be/],
    ['a rule without a field name', withItem({ field: 'model', visibleWhen: { match: 'all', rules: [{ field: 'X-1', op: 'filled' }] } }), /rules\[0\]: field is not a field name/],
    ['an item without a field name', withItem({ field: 'Bad Name' }), /field is not a field name/],
    ['a bad width', withItem({ field: 'model', width: 'third' }), /width must be/],
    ['a non-boolean required', withItem({ field: 'model', required: 'yes' }), /required must be true or false/],
    ['a non-text default', withItem({ field: 'model', defaultValue: 3 }), /defaultValue must be text/],
    ['a non-boolean readOnly', withItem({ field: 'model', readOnly: 1 }), /readOnly must be true or false/],
    ['a non-boolean endUser', withItem({ field: 'model', endUser: 'no' }), /endUser must be true or false/],
  ])('%s', (_label, raw, message) => {
    expect(() => parseCatalogForm(raw, 'doc')).toThrow(message)
  })

  it('a well-formed document keeps every optional key it carries (and drops blank texts)', () => {
    const parsed = parseCatalogForm({
      version: 1, revision: 2,
      sections: [{
        id: 'a', title: { en: 'A', it: '  ' }, description: { en: 'Why' }, columns: 1,
        visibleWhen: { match: 'any', rules: [{ field: 'model', op: 'eq', value: '1' }] },
        items: [{ field: 'model', required: true, defaultValue: 'd', readOnly: false, endUser: true, width: 'half', help: { it: 'Aiuto' } }],
      }],
    }, 'doc')!
    const s = parsed.sections[0]!
    // One column is the default: it is not written, so no form changes look by itself.
    expect(s).not.toHaveProperty('columns')
    expect(s.title).toEqual({ en: 'A' })
    expect(s.description).toEqual({ en: 'Why' })
    expect(s.visibleWhen).toEqual({ match: 'any', rules: [{ field: 'model', op: 'eq', value: '1' }] })
    expect(s.items[0]).toEqual({ field: 'model', required: true, defaultValue: 'd', readOnly: false, endUser: true, width: 'half', help: { it: 'Aiuto' } })
  })
})

describe('assertCatalogForm: rules against the library', () => {
  it('a choice field without a vocabulary would offer nothing', async () => {
    expect(await errorKey(() => assertCatalogForm(form([{ field: 'env' }]), lib(field('env', 'enum')))))
      .toBe('errors.catalogForm.fieldNoVocabulary')
  })

  it('a condition cannot look at a field that is not stored as a property', async () => {
    const def = form([
      { field: 'file', endUser: true },
      { field: 'model', visibleWhen: { match: 'all', rules: [{ field: 'file', op: 'filled' }] } },
    ])
    expect(await errorKey(() => assertCatalogForm(def, lib(field('file', 'attachment'), field('model', 'text')))))
      .toBe('errors.catalogForm.conditionFieldType')
  })
})

// ── The answers ─────────────────────────────────────────────────────────────

describe('resolveFormWrites: refusals and the less common kinds of answer', () => {
  const run = (def: CatalogFormDefinition, library: Map<string, FormFieldDef>, inputs: unknown[], opts = {}) =>
    resolveFormWrites(session, 't1', def, library, inputs as never, opts)

  it('a yes/no answer must be true or false', async () => {
    expect(await errorKey(() => run(form([{ field: 'urgent' }]), lib(field('urgent', 'boolean')), [{ name: 'urgent', value: 'maybe' }])))
      .toBe('errors.formField.notBoolean')
  })

  it('a choice from an EMPTY Dictionary is refused, single or multiple', async () => {
    expect(await errorKey(() => run(form([{ field: 'env' }]), lib(field('env', 'enum', { vocabulary: 'empty' })), [{ name: 'env', value: 'x' }])))
      .toBe('errors.formField.vocabularyEmpty')
    expect(await errorKey(() => run(form([{ field: 'sys' }]), lib(field('sys', 'multi_enum', { vocabulary: 'empty' })), [{ name: 'sys', values: ['x'] }])))
      .toBe('errors.formField.vocabularyEmpty')
  })

  it('a read-only field is not accepted from whoever fills the form', async () => {
    expect(await errorKey(() => run(form([{ field: 'model', readOnly: true }]), lib(field('model', 'text')), [{ name: 'model', value: 'x' }])))
      .toBe('errors.catalogForm.answerReadOnly')
  })

  it('blank answers are written as null (clearing), and an empty reference writes no relation', async () => {
    const res = await run(
      form([{ field: 'model' }, { field: 'sys' }, { field: 'ci', endUser: false }]),
      lib(field('model', 'text'), field('sys', 'multi_enum', { vocabulary: 'systems' }), field('ci', 'ref_ci')),
      [{ name: 'model', value: '  ' }, { name: 'sys', values: [' ', ''] }, { name: 'ci', refIds: [' '] }],
    )
    expect(res.props).toEqual({ model: null, sys: null })
    expect(res.references).toEqual([])
  })

  it('a team reference is checked against the tenant before it is accepted', async () => {
    onQuery = (q, p) => (q.includes('MATCH (n:Team') && p['id'] === 'team-1' && p['tenantId'] === 't1' ? [{ id: 'team-1' }] : [])
    const library = lib(field('team', 'ref_team'))
    const def = form([{ field: 'team', endUser: false }])
    const ok = await run(def, library, [{ name: 'team', refIds: ['team-1'] }])
    expect(ok.references).toEqual([{ field: 'team', fieldType: 'ref_team', ids: ['team-1'] }])
    expect(await errorKey(() => run(def, library, [{ name: 'team', refIds: ['team-other-tenant'] }])))
      .toBe('errors.formField.referenceNotFound')
  })

  it('the formula sees the raw answers converted tolerantly; the real refusal still comes with its own message', async () => {
    let seen: Record<string, unknown> = {}
    vi.mocked(runFormulaScript).mockImplementation(async (_code, input) => { seen = input; return { ok: true, value: 1 } as never })
    const library = lib(
      field('total', 'number', { formula: 'sum' }),
      field('sys', 'multi_enum', { vocabulary: 'systems' }),
      field('file', 'attachment'),
      field('model', 'text'),
      field('cost', 'number'),
    )
    const def = form([{ field: 'total' }, { field: 'sys' }, { field: 'file' }, { field: 'model' }, { field: 'cost' }])
    const inputs = [
      { name: 'sys', values: [' crm ', ''] },
      { name: 'file' },
      { name: 'model', value: '' },
      { name: 'cost', value: 'abc' },
    ]
    // "abc" is not a number: the formula run must not swallow that into a
    // formula error, the user reads the field's own refusal.
    expect(await errorKey(() => run(def, library, inputs))).toBe('errors.formField.notNumber')
    expect(seen['sys']).toEqual(['crm'])
    expect(seen).not.toHaveProperty('cost')
    expect(seen).not.toHaveProperty('model')
  })

  it('a computed TEAM becomes a relation to the team with that name, or a refusal when it does not exist', async () => {
    vi.mocked(runFormulaScript).mockResolvedValue({ ok: true, value: ' Desk Milano ' } as never)
    const library = lib(field('desk', 'ref_team', { formula: 'pick' }))
    const def = form([{ field: 'desk', endUser: false }])
    onQueryOne = (q, p) => (q.includes('MATCH (t:Team') && p['nomeSquadra'] === 'Desk Milano' ? { id: 'team-9' } : null)
    const res = await run(def, library, [])
    expect(res.references).toEqual([{ field: 'desk', fieldType: 'ref_team', ids: ['team-9'] }])

    onQueryOne = () => null
    // A typo in the formula must not produce tasks with no assignee.
    expect(await errorKey(() => run(def, library, []))).toBe('errors.formField.teamNotFound')
  })

  it('a required table needs at least one filled row', async () => {
    const def = form([{ field: 'people', required: true }])
    const library = lib(field('people', 'table', { tableDefinition: TABLE }))
    expect(await errorKey(() => run(def, library, []))).toBe('errors.formTable.rowRequired')
    expect(await errorKey(() => run(def, library, [{ name: 'people', rows: [{ role: '', qty: '' }] }]))).toBe('errors.formTable.rowRequired')
  })

  it('a required table with a filled row passes and its rows are returned for writing', async () => {
    const def = form([{ field: 'people', required: true }])
    const library = lib(field('people', 'table', { tableDefinition: TABLE }))
    const res = await run(def, library, [{ name: 'people', rows: [{ role: 'dev' }] }])
    expect(res.tables).toEqual([{ field: 'people', rows: [{ role: 'dev', qty: null, ok: null, when: null, kind: null }] }])
  })

  it('without a known reader language the refusal uses the base label', async () => {
    const { languageForUser } = await import('../tenantLanguage.js')
    vi.mocked(languageForUser).mockResolvedValueOnce(null as never)
    try {
      await run(form([{ field: 'cost' }]), lib(field('cost', 'number', { label: 'Cost', labels: [{ language: 'it', label: 'Costo' }] })), [{ name: 'cost', values: ['1'] }])
      throw new Error('expected a rejection')
    } catch (e) {
      expect((e as Error).message).toContain('"Cost"')
    }
  })

  it('a validation script does not judge an unanswered field', async () => {
    vi.mocked(runValidationScript).mockResolvedValue('always refused')
    const res = await run(form([{ field: 'model' }]), lib(field('model', 'text', { validationScript: 'return "no"' })), [])
    expect(res.props).toEqual({})
  })
})

// ── Tables ──────────────────────────────────────────────────────────────────

describe('parseFormTable and assertFormTable', () => {
  const col = (c: Record<string, unknown>) => ({ version: 1, columns: [{ name: 'label', fieldType: 'text', ...c }] })

  it.each([
    ['missing keys', { version: 1 }, /has no columns/],
    ['broken JSON', '{nope', /not valid JSON/],
    ['a bad version', { version: 0, columns: [] }, /table version must be a positive integer/],
    ['a version from the future', { version: 99, columns: [] }, /version 99/],
    ['columns that are not a list', { version: 1, columns: 'x' }, /columns must be a list/],
    ['a bad column name', col({ name: 'A B' }), /name must be lowercase/],
    ['a bad column type', col({ fieldType: 'ref_ci' }), /fieldType must be one of/],
    ['a non-string vocabulary', col({ vocabulary: 3 }), /vocabulary must be a string/],
    ['labels that are a list', col({ labels: ['x'] }), /labels must be an object/],
  ])('%s is an error', (_l, raw, message) => {
    expect(() => parseFormTable(raw, 'tbl')).toThrow(message)
  })

  it('a column with an empty vocabulary string reads as no vocabulary', () => {
    expect(parseFormTable(col({ vocabulary: '', required: true }), 'tbl')!.columns[0])
      .toEqual({ name: 'label', labels: {}, fieldType: 'text', vocabulary: null, required: true })
  })

  it.each([
    ['no columns', { version: 1, columns: [] }, 'errors.formTable.noColumns'],
    ['a repeated column', { version: 1, columns: [TABLE.columns[1]!, TABLE.columns[1]!] }, 'errors.formTable.duplicateColumn'],
    ['a choice without vocabulary', { version: 1, columns: [{ ...TABLE.columns[0]!, vocabulary: null }] }, 'errors.formTable.columnWithoutVocabulary'],
    ['a vocabulary on a number', { version: 1, columns: [{ ...TABLE.columns[1]!, vocabulary: 'env' }] }, 'errors.formTable.columnVocabularyNotAllowed'],
  ])('assertFormTable refuses %s', async (_l, def, key) => {
    expect(await errorKey(() => assertFormTable(def as FormTableDefinition, 'people'))).toBe(key)
  })

  it('assertFormTable accepts a sensible table', () => {
    expect(() => assertFormTable(TABLE, 'people')).not.toThrow()
  })
})

describe('validaRigheTabella: each cell in its column type, naming row and column', () => {
  const people = field('people', 'table', { tableDefinition: TABLE })
  const vocab = async (n: string) => (n === 'env' ? ['prod', 'dev'] : [])
  const check = (rows: unknown[]) => validaRigheTabella(people, 'People', rows as never, vocab, 10)

  it('converts the good cells and keeps blanks as null', async () => {
    const out = await check([{ role: 'prod', qty: ' 3.50 ', ok: 'true', when: '2026-01-02' }])
    expect(out).toEqual([{ role: 'prod', qty: '3.5', ok: 'true', when: '2026-01-02', kind: null }])
  })

  it.each([
    [{ role: 'prod', ok: 'yes' }, 'errors.formTable.cellNotBoolean'],
    [{ role: 'prod', when: 'not a date' }, 'errors.formTable.cellNotDate'],
    [{ role: 'prod', kind: 'x' }, 'errors.formTable.cellVocabularyEmpty'],
    [{ role: 'staging' }, 'errors.formTable.cellNotInVocabulary'],
  ])('refuses %j', async (r, key) => {
    expect(await errorKey(() => check([r]))).toBe(key)
  })

  it('a missing required cell names the column by its label, or by its name when the label is blank', async () => {
    try { await check([{ qty: '1' }]); throw new Error('expected a rejection') } catch (e) {
      expect((e as Error).message).toMatch(/Row 1 of "People": the column "Role" is required/)
    }
  })
})

describe('table rows on the ticket', () => {
  it('leggiRigheTabella groups rows by field, drops our tenant_id and stringifies values', async () => {
    onQuery = () => [
      { field: 'people', values: { tenant_id: 't1', role: 'prod', qty: 3 } },
      { field: 'people', values: { tenant_id: 't1', role: 'dev', qty: null } },
      { field: 'assets', values: { tenant_id: 't1', tag: 'A1' } },
    ]
    const rows = await leggiRigheTabella(session, 't1', 'sr-1')
    expect(rows.get('people')).toEqual([{ role: 'prod', qty: '3' }, { role: 'dev', qty: null }])
    expect(rows.get('assets')).toEqual([{ tag: 'A1' }])
    expect(queries[0]!.params).toEqual({ entityId: 'sr-1', tenantId: 't1' })
  })

  it('saveCatalogFormRevision stores the frozen copy with its revision number, scoped to the tenant', async () => {
    const def = form([{ field: 'model' }], 7)
    await saveCatalogFormRevision(session, 't1', 'item-1', def, '2026-09-22T00:00:00Z', null)
    expect(queries[0]!.params).toMatchObject({ itemId: 'item-1', tenantId: 't1', revision: 7, publishedBy: null })
    // The copy must read back identical: that is what "frozen" promises.
    expect(parseCatalogForm(queries[0]!.params['definition'], 'x')).toEqual(def)
  })
})

// ── Reading answers back ────────────────────────────────────────────────────

describe('formAnswersOf', () => {
  it('values of fields without a vocabulary read as themselves, and a known value reads with its label', async () => {
    const plain = await mod.etichetteDeiValori('t1', [field('model', 'text')])
    expect(plain('model')('MacBook')).toBe('MacBook')
    const labelled = await mod.etichetteDeiValori('t1', [field('env', 'enum', { vocabulary: 'env' }), field('model', 'text')])
    expect(labelled('env')('prod')).toBe('Produzione')
    // A value the Dictionary no longer knows stays the real datum, not an invented label.
    expect(labelled('env')('staging')).toBe('staging')
    expect(labelled('model')('x')).toBe('x')
  })

  it('groups references and files by field, skips notes, and keeps list answers as lists', async () => {
    const def = form([{ field: 'intro' }, { field: 'sys' }, { field: 'ci' }, { field: 'owner' }, { field: 'file' }, { field: 'gone' }], 2)
    onQuery = (q, p) => {
      if (q.includes('r.definition AS definition')) return [{ definition: JSON.stringify(def) }]
      if (q.includes('WHERE f.name IN $names')) {
        return [row('intro', 'note'), row('sys', 'multi_enum', { vocabulary: 'systems' }), row('ci', 'ref_ci'), row('owner', 'ref_user'), row('file', 'attachment')]
          .filter((r) => (p['names'] as string[]).includes(String(r['name'])))
      }
      if (q.includes('FORM_REFERS_TO_CI')) return [{ field: 'ci', id: 'ci-1', label: 'srv-01' }, { field: 'ci', id: 'ci-2', label: 'srv-02' }]
      if (q.includes('FORM_REFERS_TO_USER')) return [{ field: 'owner', id: 'u-1', label: 'Ada' }]
      if (q.includes('a.field_name AS field')) return [{ field: 'file', id: 'a-1', filename: 'q.pdf', sizeBytes: null }]
      return []
    }
    const out = await formAnswersOf(session, 't1', { id: 'sr-1', catalogItemId: 'item-1', formRevision: 2, props: { sys: ['mail', 'crm'], gone: 'legacy' } })
    expect(out.map((a) => a.name)).toEqual(['sys', 'ci', 'owner', 'file', 'gone'])
    const byName = new Map(out.map((a) => [a.name, a]))
    expect(byName.get('sys')).toMatchObject({ value: null, values: ['mail', 'crm'], displayValues: ['mail', 'crm'] })
    expect(byName.get('sys')!.options).toEqual([{ value: 'mail', label: 'mail' }, { value: 'crm', label: 'crm' }])
    expect(byName.get('ci')!.references).toEqual([{ id: 'ci-1', label: 'srv-01' }, { id: 'ci-2', label: 'srv-02' }])
    expect(byName.get('owner')!.references).toEqual([{ id: 'u-1', label: 'Ada' }])
    expect(byName.get('file')!.files).toEqual([{ id: 'a-1', filename: 'q.pdf', sizeBytes: 0 }])
    // A field deleted from the library stays readable under its own name.
    expect(byName.get('gone')).toMatchObject({ label: 'gone', fieldType: 'text', value: 'legacy' })
  })
})

// ── Writing references ──────────────────────────────────────────────────────

describe('writeFormReferences', () => {
  it('writes one tenant-scoped MERGE per id, on the relation of its kind', async () => {
    await writeFormReferences(session, 't1', true, 'sr-1', [
      { field: 'ci', fieldType: 'ref_ci', ids: ['ci-1'] },
      { field: 'owner', fieldType: 'ref_user', ids: ['u-1', 'u-2'] },
      { field: 'team', fieldType: 'ref_team', ids: ['team-1'] },
    ])
    expect(queries.map((q) => /FORM_REFERS_TO_(\w+)/.exec(q.query)![1])).toEqual(['CI', 'USER', 'USER', 'TEAM'])
    for (const q of queries) expect(q.params).toMatchObject({ entityId: 'sr-1', tenantId: 't1' })
    expect(queries[2]!.params).toMatchObject({ id: 'u-2', field: 'owner' })
  })

  it('an unknown kind fails loudly instead of dropping the relation', async () => {
    await expect(writeFormReferences(session, 't1', true, 'sr-1', [{ field: 'x', fieldType: 'text', ids: ['1'] }]))
      .rejects.toThrow(/text is not a reference type/)
  })
})

// ── Correcting an answer ────────────────────────────────────────────────────

describe('writeFormAnswer', () => {
  /**
   * A form where `cost` is asked only in production, `total` is computed and
   * `sys` is a multiple choice whose membership shows `detail`.
   */
  const DEF = form([
    { field: 'env' },
    { field: 'cost', visibleWhen: { match: 'all', rules: [{ field: 'env', op: 'eq', value: 'prod' }] } },
    { field: 'total' },
    { field: 'sys' },
    { field: 'detail', visibleWhen: { match: 'all', rules: [{ field: 'sys', op: 'eq', value: 'crm' }] } },
  ], 4)
  const LIBRARY = [
    row('env', 'enum', { vocabulary: 'env' }),
    row('cost', 'number'),
    row('total', 'number', { formula: 'total' }),
    row('sys', 'multi_enum', { vocabulary: 'systems' }),
    row('detail', 'text'),
  ]

  function graph(props: Record<string, unknown> | null, opts: { library?: Array<Record<string, unknown>>; revision?: boolean; written?: boolean } = {}) {
    const library = opts.library ?? LIBRARY
    onQueryOne = (q, p) => {
      if (q.includes('RETURN properties(r) AS props')) return props ? { props } : null
      if (q.includes('SET r += $props')) {
        return opts.written === false ? null : { before: props, after: { ...props, ...(p['props'] as object) } }
      }
      return null
    }
    onQuery = (q, p) => {
      if (q.includes('WHERE f.name IN $names')) return library.filter((r) => (p['names'] as string[]).includes(String(r['name'])))
      if (q.includes('r.definition AS definition')) return opts.revision === false ? [] : [{ definition: JSON.stringify(DEF) }]
      return []
    }
  }
  const TICKET = { catalog_item_id: 'item-1', form_revision: 4, env: 'prod', cost: 2000, sys: ['mail', 'crm'], detail: 'x' }

  it('a request that does not exist in this tenant is NOT FOUND', async () => {
    graph(null)
    expect(await errorKey(() => writeFormAnswer(session, 't1', 'sr-x', 'env', 'dev'))).toBe('errors.notFound')
  })

  it('a missing frozen revision is an error, not a guess with today\'s form', async () => {
    graph(TICKET, { revision: false })
    expect(await errorKey(() => writeFormAnswer(session, 't1', 'sr-1', 'env', 'dev'))).toBe('errors.formField.revisionMissing')
  })

  it('a list property stays a list for the conditions: a field shown by membership can be corrected', async () => {
    graph(TICKET)
    // `detail` is visible because "crm" is IN the list; a joined string would hide it.
    const res = await writeFormAnswer(session, 't1', 'sr-1', 'detail', 'y')
    expect((res.after as Record<string, unknown>)['detail']).toBe('y')
  })

  it('clears an answer the form no longer asks, even when that field left the library', async () => {
    graph(TICKET, { library: LIBRARY.filter((r) => r['name'] !== 'cost') })
    // The first library read is for `env`; the whole-form read lacks `cost`.
    const res = await writeFormAnswer(session, 't1', 'sr-1', 'env', 'dev')
    const written = queries.find((q) => q.query.includes('SET r += $props'))!.params['props']
    expect(written).toMatchObject({ env: 'dev', cost: null })
    expect((res.after as Record<string, unknown>)['cost']).toBeNull()
  })

  it('an already-empty hidden answer is left alone (nothing to clear)', async () => {
    graph({ ...TICKET, cost: null })
    await writeFormAnswer(session, 't1', 'sr-1', 'env', 'dev')
    const written = queries.find((q) => q.query.includes('SET r += $props'))!.params['props'] as Record<string, unknown>
    expect(written).not.toHaveProperty('cost')
  })

  it('a formula that fails while recomputing refuses the correction', async () => {
    graph(TICKET)
    vi.mocked(runFormulaScript).mockResolvedValue({ ok: false, error: 'boom' } as never)
    expect(await errorKey(() => writeFormAnswer(session, 't1', 'sr-1', 'cost', '10'))).toBe('errors.formField.formulaFailed')
    expect(queries.some((q) => q.query.includes('SET r += $props'))).toBe(false)
  })

  it('a request deleted between the read and the write is NOT FOUND', async () => {
    graph(TICKET, { written: false })
    expect(await errorKey(() => writeFormAnswer(session, 't1', 'sr-1', 'detail', 'z'))).toBe('errors.notFound')
  })
})
