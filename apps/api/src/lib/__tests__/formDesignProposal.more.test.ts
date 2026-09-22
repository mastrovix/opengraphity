/**
 * lib/formDesignProposal.ts — the filter in front of the AI form proposal,
 * the cases the first suite does not reach.
 *
 * Why these behaviours matter: whatever the model writes, the proposal the
 * designer shows must be something the real mutations accept, and whatever
 * is dropped must be SAID (a `scartati` entry), never silently lost. A
 * vocabulary with a bad name or a single value, a script on a field type
 * that cannot run it, a visibility rule on an unknown operator, a section
 * id that collides with an existing one: each would otherwise fail the
 * save AFTER the fields were created and the model call was paid for.
 */
import { describe, it, expect } from 'vitest'
import { validaProposta, type CatalogoPerProposta } from '../formDesignProposal.js'

function catalogo(over: Partial<CatalogoPerProposta> = {}): CatalogoPerProposta {
  return {
    campiLibreria: new Map([
      ['ambiente', { fieldType: 'enum', label: 'Environment' }],
      ['allegato', { fieldType: 'attachment', label: 'Attachment' }],
    ]),
    vocabolari: new Map([['environment', ['production', 'staging']]]),
    tipiCI: new Set(['Server']),
    categorie: ['hardware'],
    priorita: ['low', 'high'],
    workflowPerNome: new Map(),
    scriptingAcceso: true,
    consentiNuovi: true,
    maxCampiPerModulo: 20,
    campiGiaNelModulo: [],
    nomiRiservati: new Set(['title']),
    idSezioniEsistenti: [],
    ...over,
  }
}

function campo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    riuso: null, tipo: 'text', etichetta_it: 'Model', etichetta_en: 'Model',
    aiuto_it: null, aiuto_en: null, vocabolario: null, tipi_ci: [],
    formula: null, script_validazione: null, obbligatorio: false, larghezza: 'full',
    visibile_nella_richiesta: true, solo_lettura: false, visibile_quando: null, perche: '',
    ...over,
  }
}

const doc = (campi: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  voce: null, vocabolari_nuovi: [], note: [],
  sezioni: [{ titolo_it: 'Device', titolo_en: 'Device', colonne: 1, campi }],
  ...over,
})
const keys = (p: ReturnType<typeof validaProposta>) => p.scartati.map((s) => s.key)

describe('new vocabularies', () => {
  it('an invalid name, an existing vocabulary and fewer than two values are each discarded with a reason', () => {
    const p = validaProposta(doc([campo()], {
      vocabolari_nuovi: [
        { nome: '9bad', etichetta: '', valori: ['a', 'b'] },
        { nome: '', etichetta: '', valori: ['a', 'b'] },
        { nome: 'environment', etichetta: 'Env', valori: ['a', 'b'] },
        { nome: 'size', etichetta: '', valori: ['only'] },
      ],
    }), catalogo())
    expect(p.vocabolariNuovi).toEqual([])
    expect(p.scartati.slice(0, 4)).toEqual([
      { cosa: '9bad', key: 'proposal.discard.vocabularyName', params: { name: '9bad' } },
      // Nothing to name the discard after: the dash keeps the row readable.
      { cosa: '—', key: 'proposal.discard.vocabularyName', params: { name: '' } },
      { cosa: 'environment', key: 'proposal.discard.vocabularyExists', params: { name: 'environment' } },
      { cosa: 'size', key: 'proposal.discard.vocabularyValues', params: { name: 'size' } },
    ])
  })

  it('a valid vocabulary is kept with de-duplicated values, the name as label when none is given, and usable by a choice field', () => {
    const p = validaProposta(doc([campo({ tipo: 'enum', etichetta_it: 'Size', vocabolario: 'SIZE' })], {
      vocabolari_nuovi: [{ nome: 'Size', etichetta: '', valori: ['s', 'm', 's', ' '], perche: 'asked' }],
    }), catalogo())
    expect(p.vocabolariNuovi).toEqual([{ name: 'size', label: 'size', values: ['s', 'm'], why: 'asked' }])
    expect(p.campiNuovi[0]).toMatchObject({ name: 'size', fieldType: 'enum', vocabulary: 'size' })
  })
})

describe('fields', () => {
  it('a field without any label is discarded, named after its type or a dash', () => {
    const p = validaProposta(doc([campo({ etichetta_it: '', etichetta_en: '' }), campo({ etichetta_it: '', etichetta_en: '', tipo: '' })]), catalogo())
    expect(p.sezioni).toEqual([])
    expect(p.scartati).toEqual([
      { cosa: 'text', key: 'proposal.discard.noLabel', params: {} },
      { cosa: '—', key: 'proposal.discard.noLabel', params: {} },
    ])
  })

  it('an English-only label fills both languages', () => {
    const p = validaProposta(doc([campo({ etichetta_it: '', etichetta_en: 'Serial number' })]), catalogo())
    expect(p.campiNuovi[0]).toMatchObject({ name: 'serial_number', labelIt: 'Serial number', labelEn: 'Serial number' })
  })

  it('a validation script on a type that stores no property (a reference) is dropped and said', () => {
    const p = validaProposta(doc([campo({ tipo: 'ref_team', etichetta_it: 'Team', script_validazione: 'return true' })]), catalogo())
    expect(p.campiNuovi[0]!.validationScript).toBeNull()
    expect(keys(p)).toContain('proposal.discard.scriptNotAllowed')
  })

  it('a validation script on a property type is kept', () => {
    const p = validaProposta(doc([campo({ tipo: 'number', etichetta_it: 'Cost', script_validazione: 'return input.value > 0' })]), catalogo())
    expect(p.campiNuovi[0]!.validationScript).toBe('return input.value > 0')
  })

  it('scripts are refused when the tenant has scripting off', () => {
    const p = validaProposta(doc([campo({ tipo: 'number', etichetta_it: 'Cost', script_validazione: 'return true' })]), catalogo({ scriptingAcceso: false }))
    expect(p.campiNuovi[0]!.validationScript).toBeNull()
    expect(p.scartati).toContainEqual({ cosa: 'Cost', key: 'proposal.discard.scriptingOff', params: { kind: 'validation' } })
  })

  it('width half is honoured, anything else is full; non-boolean flags fall back to their defaults', () => {
    const p = validaProposta(doc([
      campo({ etichetta_it: 'A', larghezza: 'half', obbligatorio: 'yes', visibile_nella_richiesta: 'no', solo_lettura: 1 }),
      campo({ etichetta_it: 'B', larghezza: 'huge' }),
    ]), catalogo())
    expect(p.sezioni[0]!.items.map((i) => [i.width, i.required, i.endUser, i.readOnly])).toEqual([
      ['half', false, true, false],
      ['full', false, true, false],
    ])
  })

  it('a field already in the form is citable by its library label in a condition', () => {
    const p = validaProposta(doc([
      campo({ etichetta_it: 'Reason', tipo: 'textarea', visibile_quando: { match: 'any', rules: [{ field: 'Environment', op: 'eq', value: 'production' }] } }),
    ]), catalogo({ campiGiaNelModulo: ['ambiente', 'not_in_library'] }))
    // match "any" is preserved: turning it into "all" would hide the field in cases the user wanted it shown.
    expect(JSON.parse(p.sezioni[0]!.items[0]!.visibleWhen!)).toEqual({ match: 'any', rules: [{ field: 'ambiente', op: 'eq', value: 'production' }] })
  })
})

describe('sections', () => {
  it('a section without a title takes the label of its first field; two columns are kept', () => {
    const p = validaProposta({ sezioni: [{ titolo_it: '', titolo_en: '', colonne: 2, campi: [campo({ etichetta_it: '', etichetta_en: 'Laptop' })] }] }, catalogo())
    expect(p.sezioni[0]).toMatchObject({ titleIt: 'Laptop', titleEn: 'Laptop', columns: 2 })
  })

  it('a section with only an English title uses it for both languages; unknown column counts become 1', () => {
    const p = validaProposta({ sezioni: [{ titolo_en: 'Access', colonne: 3, campi: [campo()] }] }, catalogo())
    expect(p.sezioni[0]).toMatchObject({ titleIt: 'Access', titleEn: 'Access', columns: 1 })
  })

  it('section ids avoid ids already in the form and each other', () => {
    const p = validaProposta({ sezioni: [{ titolo_it: 'A', campi: [campo({ etichetta_it: 'One' })] }, { titolo_it: 'B', campi: [campo({ etichetta_it: 'Two' })] }] },
      catalogo({ idSezioniEsistenti: ['ai_1', 'ai_3'] }))
    expect(p.sezioni.map((s) => s.id)).toEqual(['ai_2', 'ai_4'])
  })

  it('when every ai_N id is taken, a time-based id is used instead of a duplicate', () => {
    const taken = Array.from({ length: 998 }, (_, i) => `ai_${String(i + 1)}`)
    const p = validaProposta(doc([campo()]), catalogo({ idSezioniEsistenti: taken }))
    const id = p.sezioni[0]!.id
    expect(taken).not.toContain(id)
    expect(id).toMatch(/^ai_\d{1,8}$/)
  })
})

describe('visibility conditions', () => {
  const withRule = (rules: unknown, match: unknown = 'all') => doc([
    campo({ riuso: 'ambiente', tipo: 'enum', etichetta_it: 'Environment' }),
    campo({ etichetta_it: 'Reason', tipo: 'textarea', visibile_quando: { match, rules } }),
  ])

  it('an empty rule list means no condition, and nothing is discarded', () => {
    const p = validaProposta(withRule([]), catalogo())
    expect(p.sezioni[0]!.items[1]!.visibleWhen).toBeNull()
    expect(p.scartati).toEqual([])
  })

  it('a rule without a field, or on the field itself, is discarded whole', () => {
    const p1 = validaProposta(withRule([{ field: '', op: 'eq', value: 'x' }]), catalogo())
    expect(p1.scartati).toContainEqual({ cosa: 'reason', key: 'proposal.discard.conditionField', params: { name: '—' } })
    const p2 = validaProposta(withRule([{ field: 'reason', op: 'filled' }]), catalogo())
    expect(keys(p2)).toContain('proposal.discard.conditionField')
    expect(p2.sezioni[0]!.items[1]!.visibleWhen).toBeNull()
  })

  it('an unknown operator with no text is reported with a dash', () => {
    const p = validaProposta(withRule([{ field: 'ambiente', op: '' }]), catalogo())
    expect(p.scartati).toContainEqual({ cosa: 'reason', key: 'proposal.discard.conditionOp', params: { op: '—' } })
  })

  it('a condition on a library attachment cannot be evaluated', () => {
    const p = validaProposta(doc([
      campo({ riuso: 'allegato', etichetta_it: 'Attachment' }),
      campo({ etichetta_it: 'Reason', tipo: 'textarea', visibile_quando: { rules: [{ field: 'allegato', op: 'filled' }] } }),
    ]), catalogo())
    expect(p.scartati).toContainEqual({ cosa: 'reason', key: 'proposal.discard.conditionSubject', params: { name: 'allegato', fieldType: 'attachment' } })
  })

  it('valueless operators drop any value; several rules are all kept; a missing match defaults to all', () => {
    const p = validaProposta(withRule([{ field: 'ambiente', op: 'filled', value: 'ignored' }, { field: 'Environment', op: 'ne', value: 'staging' }], undefined), catalogo())
    expect(JSON.parse(p.sezioni[0]!.items[1]!.visibleWhen!)).toEqual({
      match: 'all',
      rules: [{ field: 'ambiente', op: 'filled' }, { field: 'ambiente', op: 'ne', value: 'staging' }],
    })
  })
})

describe('catalog item header and notes', () => {
  it('an unknown priority becomes null and is said; description and why are carried; a missing name means no header', () => {
    const p = validaProposta(doc([campo()], {
      voce: { nome: 'Laptop', descrizione: '  A company laptop ', priorita: 'urgent', richiede_approvazione: 'yes', perche: 'asked' },
      note: ['  check the budget  ', '', 42],
    }), catalogo())
    expect(p.voce).toEqual({
      name: 'Laptop', description: 'A company laptop', category: null, priority: null,
      requiresApproval: false, workflowDefinitionId: null, workflowDefinitionName: null, why: 'asked',
    })
    expect(p.scartati).toContainEqual({ cosa: 'Laptop', key: 'proposal.discard.priorityUnknown', params: { name: 'urgent' } })
    expect(p.note).toEqual(['check the budget'])

    expect(validaProposta(doc([campo()], { voce: { nome: '  ' } }), catalogo()).voce).toBeNull()
  })

  it('a known priority is kept and an empty description is null', () => {
    const p = validaProposta(doc([campo()], { voce: { nome: 'X', priorita: 'low', descrizione: '' } }), catalogo())
    expect(p.voce).toMatchObject({ priority: 'low', description: null })
  })
})
