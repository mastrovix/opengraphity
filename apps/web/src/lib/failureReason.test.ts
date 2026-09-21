/**
 * lib/failureReason.ts — la ripetizione si scioglie in lettura, perché il
 * `failedReason` di un job già fallito non cambia più (BullMQ lo salva
 * nell'istante del fallimento).
 *
 * Il caso della prima prova è il job vero: `events-maintenance` del 16
 * settembre 2026 alle 03:10, 1605 caratteri con la stessa frase del driver
 * Neo4j ripetuta cinque volte.
 */
import { describe, it, expect } from 'vitest'
import { motivoLeggibile } from './failureReason'

const CAUSA_NEO4J = 'Failed to connect to server. Please ensure that your database is listening on the '
  + 'correct host and port and that you have compatible encryption settings both on Neo4j server and '
  + 'driver. Note that the default encryption setting has changed in Neo4j 4.0. Caused by: connect '
  + 'ECONNREFUSED 172.19.0.15:7687'

const PASSATE = ['closed_windows', 'pending', 'flapping', 'storms', 'gauges']
const JOB_VERO = `[events-maintenance] events-maintenance: ${PASSATE.map((p) => `${p}: ${CAUSA_NEO4J}`).join('; ')}`

describe('motivoLeggibile', () => {
  it('il job vero: cinque passate, una causa sola, il prefisso conservato', () => {
    expect(JOB_VERO).toHaveLength(1605)
    const letto = motivoLeggibile(JOB_VERO)
    expect(letto).toBe(`[events-maintenance] events-maintenance: closed_windows, pending, flapping, storms, gauges: ${CAUSA_NEO4J}`)
    // La causa compare UNA volta, e nessuna etichetta è stata perduta.
    expect(letto.match(/ECONNREFUSED/g)).toHaveLength(1)
    for (const p of PASSATE) expect(letto).toContain(p)
    expect(letto.length).toBeLessThan(JOB_VERO.length / 3)
  })

  it('cause diverse restano separate, nel loro ordine', () => {
    const raw = 'closed_windows: connect ECONNREFUSED; pending: 2/2 pending events failed; gauges: connect ECONNREFUSED'
    expect(motivoLeggibile(raw)).toBe('closed_windows, gauges: connect ECONNREFUSED; pending: 2/2 pending events failed')
  })

  it('un motivo già leggibile torna identico: nessuna ripetizione, una voce sola, o un testo di altra forma', () => {
    const giaAccorpato = `[events-maintenance] events-maintenance: closed_windows, pending: ${CAUSA_NEO4J}`
    expect(motivoLeggibile(giaAccorpato)).toBe(giaAccorpato)

    const dueCauseDiverse = 'storms: redis down; gauges: neo4j down'
    expect(motivoLeggibile(dueCauseDiverse)).toBe(dueCauseDiverse)

    const unaSola = '[maintenance] backup_database: ENOSPC: no space left on device'
    expect(motivoLeggibile(unaSola)).toBe(unaSola)

    // Nessuna etichetta: un errore qualunque non si tocca.
    const libero = 'Error: Request failed with status code 500; retry later'
    expect(motivoLeggibile(libero)).toBe(libero)

    expect(motivoLeggibile('')).toBe('')
  })

  it('una forma non riconosciuta a metà elenco torna indietro intera, non a pezzi', () => {
    // La seconda voce ha un prefisso suo: non è l'elenco che sappiamo leggere.
    const strano = `pending: ${CAUSA_NEO4J}; [altro] gauges: ${CAUSA_NEO4J}`
    expect(motivoLeggibile(strano)).toBe(strano)
  })
})
