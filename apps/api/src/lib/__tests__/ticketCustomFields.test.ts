/**
 * Verifica «Cosa resta cablato», ondata 4: i campi personalizzati dei ticket.
 * Prima un campo aggiunto nel designer ITIL non arrivava da nessuna parte; ora
 * passa da qui da ogni canale, validato come la modifica fatta a mano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
const runValidationScript = vi.fn(async () => null as string | null)
vi.mock('../metamodelScript.js', () => ({ runValidationScript: (...a: unknown[]) => runValidationScript(...a) }))

const { resolveCustomFieldWrites, customFieldValues, customFieldValueMap, parseRestCustomFields, restCustomFieldValues } = await import('../ticketCustomFields.js')
type Def = Parameters<typeof customFieldValues>[0][number]

const def = (over: Partial<Def>): Def => ({
  name: 'x', label: 'X', fieldType: 'string', required: false, enumValues: [], enumTypeName: null,
  validationScript: null, visibleToEndUser: false, order: 1,
  visibility: { mode: 'always' }, editability: { mode: 'visible' }, ...over,
})
const DEFS: Def[] = [
  def({ name: 'outcome', label: 'Esito', fieldType: 'enum', enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome', required: true, visibleToEndUser: true }),
  def({ name: 'cost_center', label: 'Centro di costo', order: 2 }),
  def({ name: 'effort', label: 'Ore', fieldType: 'number', order: 3, validationScript: 'if (value > 100) throw new Error("too much")' }),
]

const failure = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(GraphQLError)
  return e as GraphQLError
}
const keyOf = (e: GraphQLError) => (e.extensions['i18n'] as { key: string }).key

beforeEach(() => { vi.clearAllMocks(); runValidationScript.mockResolvedValue(null) })

describe('resolveCustomFieldWrites', () => {
  it('in creazione: valori convertiti al tipo, vuoto = null', async () => {
    const out = await resolveCustomFieldWrites('t1', 'change', DEFS, [
      { name: 'outcome', value: 'successful' }, { name: 'cost_center', value: '' }, { name: 'effort', value: '12.5' },
    ], { current: null })
    expect(out).toEqual({ outcome: 'successful', cost_center: null, effort: 12.5 })
  })

  it('un campo che il cliente non ha è rifiutato, non scartato', async () => {
    expect(keyOf(await failure(resolveCustomFieldWrites('t1', 'change', DEFS, [{ name: 'esito', value: 'ok' }], { current: null })))).toBe('errors.customField.unknown')
  })

  it('un valore fuori vocabolario è rifiutato nominando gli ammessi', async () => {
    const e = await failure(resolveCustomFieldWrites('t1', 'change', DEFS, [{ name: 'outcome', value: 'riuscita' }], { current: null }))
    expect(keyOf(e)).toBe('errors.stepField.valueNotInVocabulary')
    expect(e.message).toContain('successful, failed')
  })

  it('obbligatorio: in creazione deve esserci; in modifica solo toglierlo è un errore', async () => {
    expect(keyOf(await failure(resolveCustomFieldWrites('t1', 'change', DEFS, [], { current: null })))).toBe('errors.customField.required')
    await expect(resolveCustomFieldWrites('t1', 'change', DEFS, [{ name: 'cost_center', value: 'IT' }], { current: { outcome: 'failed' } })).resolves.toEqual({ cost_center: 'IT' })
    expect(keyOf(await failure(resolveCustomFieldWrites('t1', 'change', DEFS, [{ name: 'outcome', value: null }], { current: { outcome: 'failed' } })))).toBe('errors.customField.required')
  })

  it('dal portale: un campo non offerto all\'utente finale è rifiutato, e l\'obbligo vale solo per quelli offerti', async () => {
    const withHidden = [...DEFS, def({ name: 'internal_code', label: 'Codice interno', required: true, order: 9 })]
    expect(keyOf(await failure(resolveCustomFieldWrites('t1', 'incident', withHidden, [{ name: 'outcome', value: 'failed' }, { name: 'internal_code', value: 'A' }], { current: null, endUser: true })))).toBe('errors.customField.notForEndUser')
    await expect(resolveCustomFieldWrites('t1', 'incident', withHidden, [{ name: 'outcome', value: 'failed' }], { current: null, endUser: true })).resolves.toEqual({ outcome: 'failed' })
  })

  it('lo script di validazione vede il ticket intero e il suo rifiuto ferma la scrittura', async () => {
    runValidationScript.mockResolvedValueOnce('too much')
    const e = await failure(resolveCustomFieldWrites('t1', 'change', DEFS, [{ name: 'effort', value: '200' }], { current: { outcome: 'failed', title: 'T' } }))
    expect(keyOf(e)).toBe('errors.customField.script')
    expect(runValidationScript).toHaveBeenCalledWith(DEFS[2]!.validationScript, { input: { outcome: 'failed', title: 'T', effort: 200 }, value: 200 }, 'change.effort.validation_script', 't1', 'tenant')
  })

  it('lo stesso campo due volte è un errore', async () => {
    expect(keyOf(await failure(resolveCustomFieldWrites('t1', 'change', DEFS, [{ name: 'cost_center', value: 'A' }, { name: 'cost_center', value: 'B' }], { current: {} })))).toBe('errors.customField.duplicate')
  })
})

describe('lettura e REST', () => {
  it('i valori escono come testo, con i campi vuoti a null; il portale vede solo quelli offerti', () => {
    const props = { outcome: 'failed', effort: 3, cost_center: '' }
    expect(customFieldValues(DEFS, props).map((v) => [v.name, v.value])).toEqual([['outcome', 'failed'], ['cost_center', null], ['effort', '3']])
    expect(customFieldValues(DEFS, props, { onlyVisibleToEndUser: true }).map((v) => v.name)).toEqual(['outcome'])
    expect(restCustomFieldValues(DEFS, props)).toEqual({ outcome: 'failed', cost_center: null, effort: '3' })
    expect(customFieldValueMap([{ name: 'a', value: '1' }])).toEqual({ a: '1' })
  })

  it('REST: oggetto {nome: valore}; chiave assente = il canale non li manda; forme sbagliate rifiutate', () => {
    expect(parseRestCustomFields({})).toBeUndefined()
    expect(parseRestCustomFields({ customFields: { outcome: 'failed', effort: 3, ok: true, cost_center: null } }))
      .toEqual([{ name: 'outcome', value: 'failed' }, { name: 'effort', value: '3' }, { name: 'ok', value: 'true' }, { name: 'cost_center', value: null }])
    expect(() => parseRestCustomFields({ customFields: [] })).toThrow(/must be an object/)
    expect(() => parseRestCustomFields({ customFields: { a: { b: 1 } } })).toThrow(/must be a string/)
  })
})

/** Secondo giro UI del 15 set 2026: in quali fasi un campo si vede e si modifica. */
describe('resolveCustomFieldWrites — le fasi del campo', () => {
  const OUTCOME = def({ name: 'outcome', label: 'Esito', fieldType: 'enum', enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome', required: true,
    visibility: { mode: 'from', step: 'review' }, editability: { mode: 'steps', steps: ['review'] } })

  it('all\'apertura (fase iniziale) un campo «da review in poi» non si chiede: né obbligatorio né scrivibile', async () => {
    const opening = { current: 'assessment', visited: ['assessment'] }
    expect(await resolveCustomFieldWrites('t1', 'change', [OUTCOME], [{ name: 'outcome', value: null }], { current: null, stepContext: opening })).toEqual({})
    const e = await failure(resolveCustomFieldWrites('t1', 'change', [OUTCOME], [{ name: 'outcome', value: 'successful' }], { current: null, stepContext: opening }))
    expect(keyOf(e)).toBe('errors.customField.notInStep')
  })

  it('in review si scrive; chiuso si legge ma non si cambia (rimandarlo uguale va bene)', async () => {
    expect(await resolveCustomFieldWrites('t1', 'change', [OUTCOME], [{ name: 'outcome', value: 'failed' }], { current: {}, stepContext: { current: 'review', visited: ['assessment', 'review'] } }))
      .toEqual({ outcome: 'failed' })
    const closed = { current: 'closed', visited: ['assessment', 'review', 'closed'] }
    const e = await failure(resolveCustomFieldWrites('t1', 'change', [OUTCOME], [{ name: 'outcome', value: 'successful' }], { current: { outcome: 'failed' }, stepContext: closed }))
    expect(keyOf(e)).toBe('errors.customField.notEditableInStep')
    expect(await resolveCustomFieldWrites('t1', 'change', [OUTCOME], [{ name: 'outcome', value: 'failed' }], { current: { outcome: 'failed' }, stepContext: closed })).toEqual({})
  })

  it('customFieldValues dice, per la fase del ticket, se il campo si vede e si modifica', () => {
    const [v] = customFieldValues([OUTCOME], { outcome: 'failed' }, { stepContext: { current: 'closed', visited: ['review', 'closed'] } })
    expect(v).toMatchObject({ name: 'outcome', visible: true, editable: false })
  })
})
