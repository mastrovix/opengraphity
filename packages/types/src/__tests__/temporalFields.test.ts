/**
 * «QUESTO CAMPO È UNA DATA?» — la domanda che si faceva in due posti con due
 * risposte diverse, e sul server non si faceva affatto (20 set 2026).
 *
 * Il difetto che l'ha fatta nascere: il costruttore di report mandava SEMPRE
 * un periodo («per giorno»), anche su un istogramma raggruppato per stato. Il
 * Cypher diventava `date.truncate('day', datetime(n.status))` e Neo4j
 * rispondeva «Text cannot be parsed to a DateTime "completed"» — a
 * esecuzione, cioè quando il report era già salvato.
 */
import { describe, it, expect } from 'vitest'
import { isTemporalField } from '../temporalFields.js'

describe('isTemporalField', () => {
  it('il tipo dichiarato dal metamodello decide: date e datetime sì', () => {
    expect(isTemporalField('consegna', 'date')).toBe(true)
    expect(isTemporalField('consegna', 'datetime')).toBe(true)
  })

  it('un campo del cliente che data non è, no — anche se si chiama come una', () => {
    expect(isTemporalField('data_prevista', 'text')).toBe(false)
  })

  it('i campi del prodotto si riconoscono dal NOME: il metamodello ITIL non li tipizza', () => {
    for (const n of ['created_at', 'resolved_at', 'completed_at', 'due_at', 'deployed_at']) {
      expect(isTemporalField(n, null), n).toBe(true)
    }
    expect(isTemporalField('scheduled_start', null)).toBe(true)
    expect(isTemporalField('window_end', null)).toBe(true)
  })

  it('STATO NON È UNA DATA: è il campo su cui il periodo faceva cadere il report', () => {
    expect(isTemporalField('status', null)).toBe(false)
    expect(isTemporalField('state', null)).toBe(false)
    expect(isTemporalField('severity', null)).toBe(false)
    expect(isTemporalField('environment', 'enum')).toBe(false)
  })
})
