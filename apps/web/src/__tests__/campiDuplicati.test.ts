/**
 * UNA VOCE PER CAMPO NELLE TENDINE, anche con un metamodello sporco.
 *
 * Il difetto, visto nel browser su c-test: nelle condizioni e nelle azioni
 * delle business rule «Priorità» compariva due volte, e con lei «Impatto» e
 * «Urgenza». La causa vera era nel dato — la migrazione
 * `20260920_1720` teneva `scope` nella chiave del suo MERGE e si è duplicata
 * cinque campi — e il rimedio sta lì (migrazione `20261005_1010` + il rilievo
 * `metamodel_duplicate_field` nella diagnostica). Questo test tiene ferma la
 * DIFESA del client: due definizioni con lo stesso nome non diventano due
 * voci, perché sul nodo il campo è uno solo.
 */
import { describe, it, expect } from 'vitest'
import { unoPerNome } from '@/hooks/useEntityFields'

describe('un nome, una voce', () => {
  it('tiene la prima definizione e scarta le altre con lo stesso nome', () => {
    const campi = [
      { name: 'title',    label: 'Titolo' },
      { name: 'priority', label: 'Priorità' },
      { name: 'priority', label: 'Priorità (copia)' },
      { name: 'impact',   label: 'Impatto' },
      { name: 'impact',   label: 'Impatto (copia)' },
    ]
    const out = unoPerNome(campi)
    expect(out.map((f) => f.name)).toEqual(['title', 'priority', 'impact'])
    // La PRIMA, non l'ultima: è quella che le migrazioni successive hanno aggiornato.
    expect(out.find((f) => f.name === 'priority')?.label).toBe('Priorità')
  })

  it('non tocca una lista già pulita', () => {
    const campi = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    expect(unoPerNome(campi)).toEqual(campi)
  })

  it('una lista vuota resta vuota', () => {
    expect(unoPerNome([])).toEqual([])
  })
})
