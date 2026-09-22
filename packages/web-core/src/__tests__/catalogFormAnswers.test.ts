/**
 * WHAT GETS SENT WHEN A CATALOG FORM IS SUBMITTED.
 *
 * These three functions sit next to the renderer because the rule has to be
 * identical in the workspace and in the portal: two copies drift, and the
 * drift shows up as a server error in the face of whoever is filling the
 * form in.
 *
 * Every rule here was learnt from the server refusing something:
 *  - only the fields VISIBLE right now are sent. A field hidden by a
 *    condition is refused as a gate, so sending it is a guaranteed error.
 *  - notes are never sent: a note is an instruction, not a question. The
 *    first browser run ended exactly there — "the field istruzioni_hw is a
 *    note: it carries no answer" — because the page sent everything it saw.
 *  - computed fields are not sent: the value belongs to the formula, and the
 *    API recomputes it. It is in the answers to show the total and to let
 *    the conditions see it.
 *  - tables are not answers: their rows travel separately, because a row is
 *    not a value.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogFormDefinition } from '@opengraphity/types'
import {
  visibleCatalogFormItems, catalogFormAnswersToSend, catalogFormTableAnswers,
  type CatalogFormFieldView,
} from '../CatalogFormRenderer.js'

const field = (name: string, fieldType = 'text', over: Partial<CatalogFormFieldView> = {}): CatalogFormFieldView =>
  ({ name, fieldType, label: name, required: false, ...over })

const form = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): CatalogFormDefinition =>
  ({ version: 1, revision: 1, sections: [{ id: 's1', title: { it: 'Sezione', en: 'Section' }, items, ...over }] } as unknown as CatalogFormDefinition)

describe('visibleCatalogFormItems', () => {
  it('an item with no condition is always shown', () => {
    expect(visibleCatalogFormItems(form([{ field: 'a' }, { field: 'b' }]), {}).map((i) => i.field)).toEqual(['a', 'b'])
  })

  it('a condition decides on the CURRENT answers', () => {
    const def = form([
      { field: 'tipo' },
      { field: 'seriale', visibleWhen: { rules: [{ field: 'tipo', operator: 'equals', value: 'hardware' }] } },
    ])
    expect(visibleCatalogFormItems(def, { tipo: 'software' }).map((i) => i.field)).toEqual(['tipo'])
    expect(visibleCatalogFormItems(def, { tipo: 'hardware' }).map((i) => i.field)).toEqual(['tipo', 'seriale'])
  })

  it('a field not offered to the portal disappears only for an end user', () => {
    const def = form([{ field: 'a' }, { field: 'interno', endUser: false }])
    expect(visibleCatalogFormItems(def, {}).map((i) => i.field)).toEqual(['a', 'interno'])
    expect(visibleCatalogFormItems(def, {}, true).map((i) => i.field)).toEqual(['a'])
  })

  it('a hidden SECTION takes its fields with it', () => {
    const def = {
      version: 1, revision: 1,
      sections: [
        { id: 's1', title: { it: 'Uno' }, items: [{ field: 'tipo' }] },
        { id: 's2', title: { it: 'Due' }, visibleWhen: { rules: [{ field: 'tipo', operator: 'equals', value: 'hardware' }] }, items: [{ field: 'seriale' }] },
      ],
    } as unknown as CatalogFormDefinition
    expect(visibleCatalogFormItems(def, {}).map((i) => i.field)).toEqual(['tipo'])
    expect(visibleCatalogFormItems(def, { tipo: 'hardware' }).map((i) => i.field)).toEqual(['tipo', 'seriale'])
  })
})

describe('catalogFormAnswersToSend', () => {
  const fields = [
    field('titolo'), field('istruzioni', 'note'), field('quantita', 'number'),
    field('totale', 'number', { formula: 'quantita * 2' }),
    field('righe', 'table'), field('tag', 'multi_enum'),
  ]

  it('sends a plain answer as a value, and a multi-valued one as values', () => {
    const out = catalogFormAnswersToSend(form([{ field: 'titolo' }, { field: 'tag' }]), fields, { titolo: 'Nuovo PC', tag: ['a', 'b'] })
    expect(out).toEqual([{ name: 'titolo', value: 'Nuovo PC' }, { name: 'tag', values: ['a', 'b'] }])
  })

  it('a note is never sent: it carries no answer', () => {
    expect(catalogFormAnswersToSend(form([{ field: 'istruzioni' }, { field: 'titolo' }]), fields, { titolo: 'x' }))
      .toEqual([{ name: 'titolo', value: 'x' }])
  })

  it('a COMPUTED field is not sent: the value belongs to the formula and the API recomputes it', () => {
    const out = catalogFormAnswersToSend(form([{ field: 'quantita' }, { field: 'totale' }]), fields, { quantita: 3, totale: 6 })
    expect(out).toEqual([{ name: 'quantita', value: '3' }])
  })

  it('a formula that is only whitespace does not make a field computed', () => {
    const withBlank = [field('x', 'text', { formula: '   ' })]
    expect(catalogFormAnswersToSend(form([{ field: 'x' }]), withBlank, { x: 'v' })).toEqual([{ name: 'x', value: 'v' }])
  })

  it('a TABLE is not an answer: its rows travel on their own', () => {
    expect(catalogFormAnswersToSend(form([{ field: 'righe' }, { field: 'titolo' }]), fields, { titolo: 'x' }))
      .toEqual([{ name: 'titolo', value: 'x' }])
  })

  it('a field hidden by a condition is NOT sent: the server refuses it as a gate', () => {
    const def = form([
      { field: 'titolo' },
      { field: 'quantita', visibleWhen: { rules: [{ field: 'titolo', operator: 'equals', value: 'bulk' }] } },
    ])
    // The answer is still in the map — it was typed before the condition
    // flipped — and must not go out anyway.
    expect(catalogFormAnswersToSend(def, fields, { titolo: 'singolo', quantita: 9 }))
      .toEqual([{ name: 'titolo', value: 'singolo' }])
  })

  it('a visible field with no answer is sent as null, not omitted', () => {
    // Omitting it would leave a previous value in place on an edit: null
    // says "the person left this empty".
    expect(catalogFormAnswersToSend(form([{ field: 'titolo' }]), fields, {}))
      .toEqual([{ name: 'titolo', value: null }])
    expect(catalogFormAnswersToSend(form([{ field: 'titolo' }]), fields, { titolo: null as unknown as string }))
      .toEqual([{ name: 'titolo', value: null }])
  })

  it('non-string values become strings: the API takes text', () => {
    expect(catalogFormAnswersToSend(form([{ field: 'quantita' }]), fields, { quantita: 0 }))
      .toEqual([{ name: 'quantita', value: '0' }])
    expect(catalogFormAnswersToSend(form([{ field: 'tag' }]), fields, { tag: [1, 2] as unknown as string[] }))
      .toEqual([{ name: 'tag', values: ['1', '2'] }])
  })

  it('a field the library does not know is still sent: the type table is not a gate', () => {
    expect(catalogFormAnswersToSend(form([{ field: 'sconosciuto' }]), fields, { sconosciuto: 'v' }))
      .toEqual([{ name: 'sconosciuto', value: 'v' }])
  })

  it('the end-user view is applied here too: what the portal does not show, it does not send', () => {
    const def = form([{ field: 'titolo' }, { field: 'quantita', endUser: false }])
    expect(catalogFormAnswersToSend(def, fields, { titolo: 'x', quantita: 1 }, true))
      .toEqual([{ name: 'titolo', value: 'x' }])
  })
})

describe('catalogFormTableAnswers', () => {
  const fields = [field('righe', 'table'), field('titolo')]
  const def = form([{ field: 'titolo' }, { field: 'righe' }])

  it('sends the rows of a visible table, by column name', () => {
    expect(catalogFormTableAnswers(def, fields, {}, { righe: [{ modello: 'X1', quantita: '2' }] }))
      .toEqual([{ name: 'righe', rows: [{ modello: 'X1', quantita: '2' }] }])
  })

  it('copies the rows instead of passing the caller\'s own objects', () => {
    const rows = [{ modello: 'X1' }]
    const out = catalogFormTableAnswers(def, fields, {}, { righe: rows })
    expect(out[0]!.rows[0]).not.toBe(rows[0])
    expect(out[0]!.rows[0]).toEqual(rows[0])
  })

  it('empty rows are dropped: the server drops them anyway, sending them is noise', () => {
    expect(catalogFormTableAnswers(def, fields, {}, { righe: [
      { modello: '', quantita: '  ' }, { modello: null as unknown as string }, { modello: 'X1' },
    ] })).toEqual([{ name: 'righe', rows: [{ modello: 'X1' }] }])
  })

  it('a table with nothing in it is left out entirely', () => {
    expect(catalogFormTableAnswers(def, fields, {}, { righe: [{ modello: '' }] })).toEqual([])
    expect(catalogFormTableAnswers(def, fields, {}, {})).toEqual([])
  })

  it('a table hidden by a condition is not sent: it was never asked', () => {
    const conditional = form([
      { field: 'titolo' },
      { field: 'righe', visibleWhen: { rules: [{ field: 'titolo', operator: 'equals', value: 'bulk' }] } },
    ])
    expect(catalogFormTableAnswers(conditional, fields, { titolo: 'singolo' }, { righe: [{ modello: 'X1' }] })).toEqual([])
    expect(catalogFormTableAnswers(conditional, fields, { titolo: 'bulk' }, { righe: [{ modello: 'X1' }] })).toHaveLength(1)
  })

  it('a field that is not a table is never in here, whatever rows are passed', () => {
    expect(catalogFormTableAnswers(def, fields, {}, { titolo: [{ x: '1' }] })).toEqual([])
  })
})
