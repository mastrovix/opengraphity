/**
 * La lista congelata delle etichette italiane.
 *
 * Non verifica il Cypher (lo fa la prova dal vivo): verifica le DECISIONI che
 * la lista incorpora, perche sono quelle che qualcuno potrebbe "semplificare"
 * senza sapere perche stanno cosi.
 */
import { describe, it, expect } from 'vitest'
import { ENUM_VALUE_LABELS_IT } from '../20260920_1700_enum_value_labels.js'
import { VOCABULARIES_WITHOUT_LABELS } from '../../../lib/enumValueLabels.js'

describe('ENUM_VALUE_LABELS_IT', () => {
  it('nessun vocabolario e in entrambe le liste', () => {
    for (const nome of Object.keys(ENUM_VALUE_LABELS_IT)) {
      expect(nome in VOCABULARIES_WITHOUT_LABELS, `"${nome}" e dichiarato sia con sia senza etichette`).toBe(false)
    }
  })

  it('nessuna etichetta vuota: un\'etichetta vuota e peggio di nessuna etichetta', () => {
    for (const [nome, etichette] of Object.entries(ENUM_VALUE_LABELS_IT)) {
      expect(Object.keys(etichette).length, `"${nome}" non ha etichette`).toBeGreaterThan(0)
      for (const [v, l] of Object.entries(etichette)) {
        expect(l.trim(), `${nome}.${v}`).not.toBe('')
      }
    }
  })

  /**
   * LA DECISIONE DA NON SEMPLIFICARE.
   *
   * Lo stesso valore vuole italiani diversi in vocabolari diversi, per
   * concordanza: impatto e rischio sono maschili, urgenza priorita e severita
   * femminili. Una tabella `low → Bassa` condivisa avrebbe scritto «impatto
   * Bassa», ed e la ragione per cui le etichette stanno PER VOCABOLARIO.
   */
  it('la concordanza: `low` e Basso per l\'impatto e Bassa per l\'urgenza', () => {
    expect(ENUM_VALUE_LABELS_IT['impact']!['low']).toBe('Basso')
    expect(ENUM_VALUE_LABELS_IT['risk']!['low']).toBe('Basso')
    expect(ENUM_VALUE_LABELS_IT['urgency']!['low']).toBe('Bassa')
    expect(ENUM_VALUE_LABELS_IT['priority']!['low']).toBe('Bassa')
    expect(ENUM_VALUE_LABELS_IT['severity']!['low']).toBe('Bassa')
  })

  it('i nomi di prodotto non si traducono: etichetta = valore', () => {
    for (const nome of ['os', 'instance_type'] as const) {
      for (const [v, l] of Object.entries(ENUM_VALUE_LABELS_IT[nome]!)) expect(l).toBe(v)
    }
  })

  it('i quattro status_* e import_severity restano senza etichette, col motivo scritto', () => {
    for (const n of ['status_incident', 'status_change', 'status_problem', 'status_service_request', 'import_severity']) {
      expect(VOCABULARIES_WITHOUT_LABELS[n], `manca il motivo per "${n}"`).toBeTruthy()
      expect(ENUM_VALUE_LABELS_IT[n]).toBeUndefined()
    }
  })
})
