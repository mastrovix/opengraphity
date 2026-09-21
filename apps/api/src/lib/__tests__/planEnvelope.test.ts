/**
 * L'INVILUPPO DI UN PIANO è un INDICE, e un indice sbagliato non si vede:
 * fa sparire dal calendario delle change una finestra che esiste.
 *
 * È per questo che è pinnato riga per riga. Il filtro del calendario è
 * `window_start < to AND window_end > from`: se l'inviluppo fosse più STRETTO
 * del vero, un rilascio che cade in quella settimana non comparirebbe, e
 * nessun errore lo direbbe — si leggerebbe un calendario vuoto come «quella
 * notte non si rilascia niente». Se fosse più largo, comparirebbe una change
 * che non c'entra: fastidioso, ma visibile.
 *
 * Quindi l'inviluppo deve coprire TUTTE le finestre, validazioni comprese, e
 * non allargarsi su date che nessuna finestra vera occupa (17 set 2026).
 */
import { describe, it, expect } from 'vitest'
import { planEnvelope } from '../deployWindows.js'
import type { DeployStep } from '../deployWindows.js'

const passo = (title: string, val: [string, string], rel: [string, string]): DeployStep => ({
  title,
  validationWindow: { start: val[0], end: val[1] },
  releaseWindow:    { start: rel[0], end: rel[1] },
})

describe('planEnvelope', () => {
  it('prende la prima data e l\'ultima fra TUTTE le finestre', () => {
    expect(planEnvelope([
      passo('B', ['2026-09-22T08:00:00Z', '2026-09-22T09:00:00Z'], ['2026-09-22T22:00:00Z', '2026-09-22T23:00:00Z']),
      passo('A', ['2026-09-21T06:00:00Z', '2026-09-21T07:00:00Z'], ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z']),
    ])).toEqual({ start: '2026-09-21T06:00:00.000Z', end: '2026-09-22T23:00:00.000Z' })
  })

  it('la VALIDAZIONE conta: comincia prima del rilascio, e il calendario la mostra', () => {
    // Con l'inviluppo calcolato solo sui rilasci, una settimana che contiene
    // la validazione e non il rilascio non troverebbe questo piano.
    const e = planEnvelope([passo('P', ['2026-09-18T18:00:00Z', '2026-09-18T19:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])])
    expect(e).toEqual({ start: '2026-09-18T18:00:00.000Z', end: '2026-09-21T23:00:00.000Z' })
  })

  it('un solo passo: l\'inviluppo è la sua finestra più esterna', () => {
    expect(planEnvelope([passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-22T02:00:00Z'])]))
      .toEqual({ start: '2026-09-21T20:00:00.000Z', end: '2026-09-22T02:00:00.000Z' })
  })

  it('nessun passo, nessun inviluppo (e non una data inventata)', () => {
    expect(planEnvelope([])).toBeNull()
  })

  it('date vuote: niente inviluppo, il piano resta fuori dal calendario', () => {
    expect(planEnvelope([passo('P', ['', ''], ['', ''])])).toBeNull()
  })

  it('una finestra A ROVESCIO non allarga l\'inviluppo', () => {
    // Fine prima dell'inizio: un intervallo che nessuna finestra vera occupa.
    // Prendendola per buona l'inviluppo coprirebbe giorni in cui non succede
    // niente, e il calendario mostrerebbe la change in settimane sbagliate.
    expect(planEnvelope([
      passo('rotto', ['2026-09-30T10:00:00Z', '2026-09-01T10:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z']),
    ])).toEqual({ start: '2026-09-21T22:00:00.000Z', end: '2026-09-21T23:00:00.000Z' })
  })

  it('una data illeggibile si ignora, le altre no', () => {
    expect(planEnvelope([
      passo('P', ['non-una-data', 'nemmeno'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z']),
    ])).toEqual({ start: '2026-09-21T22:00:00.000Z', end: '2026-09-21T23:00:00.000Z' })
  })

  it('un offset diverso da Z si normalizza: il confronto nel database è fra stringhe', () => {
    // `window_start` si confronta con una stringa ISO in Cypher: se qui
    // restasse «+02:00» l'ordine sarebbe alfabetico e senza senso.
    const e = planEnvelope([passo('P', ['2026-09-21T22:00:00+02:00', '2026-09-21T23:00:00+02:00'], ['2026-09-22T00:00:00+02:00', '2026-09-22T01:00:00+02:00'])])
    expect(e!.start).toBe('2026-09-21T20:00:00.000Z')
    expect(e!.end).toBe('2026-09-21T23:00:00.000Z')
  })
})
