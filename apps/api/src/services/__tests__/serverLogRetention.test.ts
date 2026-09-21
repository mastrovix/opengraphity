/**
 * LE REGOLE DELLA RETENTION DEI LOG (20 set 2026, ondata 3).
 *
 * Il difetto da cui nasce: `:LogEntry` non è MAI stato purgato — 270.000
 * nodi, nessun lettore, nessun indice, e 269.110 di quelli fermi all'8 aprile
 * 2026. Nessuno aveva deciso per quanto tenerli, quindi la risposta di fatto
 * era «per sempre». Qui la durata si decide, e un valore scritto male ferma
 * l'avvio invece di sbagliare in silenzio alle cinque del mattino.
 */
import { describe, it, expect } from 'vitest'
import {
  leggiGiorniDiRetention, limiteDiRetention, PURGA_SERVER_CYPHER, PURGA_BROWSER_CYPHER, PURGE_BATCH_SIZE,
} from '../serverLogRetention.js'

describe('quanti giorni', () => {
  it('novanta, se nessuno ha detto altro', () => {
    expect(leggiGiorniDiRetention({})).toBe(90)
    expect(leggiGiorniDiRetention({ SERVER_LOG_RETENTION_DAYS: '' })).toBe(90)
  })

  it('quello che è scritto, se è scritto', () => {
    expect(leggiGiorniDiRetention({ SERVER_LOG_RETENTION_DAYS: '30' })).toBe(30)
  })

  it.each(['0', '-1', '7.5', 'novanta', ' '])('«%s» è un errore di configurazione, non un default', (valore) => {
    expect(() => leggiGiorniDiRetention({ SERVER_LOG_RETENTION_DAYS: valore }))
      .toThrow(/SERVER_LOG_RETENTION_DAYS/)
  })
})

describe('il limite', () => {
  it('è un istante ISO, giorni indietro da adesso', () => {
    const adesso = Date.parse('2026-09-20T12:00:00.000Z')
    expect(limiteDiRetention(adesso, 90)).toBe('2026-06-22T12:00:00.000Z')
  })

  it('rifiuta un numero di giorni che non ha senso, invece di cancellare tutto', () => {
    // Un `0` qui vorrebbe dire «cancella fino a adesso»: l'archivio intero.
    expect(() => limiteDiRetention(Date.now(), 0)).toThrow()
    expect(() => limiteDiRetention(Date.now(), -5)).toThrow()
  })
})

describe('le due query', () => {
  it('sono separate, perché i due registri datano in modo diverso', () => {
    // `:ServerLogEntry.day` è `YYYY-MM-DD`, `:LogEntry.timestamp` è un ISO
    // intero. Un confronto solo per tutt'e due cancella la cosa sbagliata.
    expect(PURGA_SERVER_CYPHER).toContain('l.day < $limiteGiorno')
    expect(PURGA_BROWSER_CYPHER).toContain('l.timestamp < $limite')
    expect(PURGA_SERVER_CYPHER).toContain(':ServerLogEntry')
    expect(PURGA_BROWSER_CYPHER).toContain(':LogEntry')
  })

  it('cancellano a LOTTI in transazioni separate', () => {
    // 270.000 nodi in una transazione sola riempiono la heap di Neo4j e
    // portano giù tutto il resto insieme alla purga.
    for (const q of [PURGA_SERVER_CYPHER, PURGA_BROWSER_CYPHER]) {
      expect(q).toContain(`IN TRANSACTIONS OF ${String(PURGE_BATCH_SIZE)} ROWS`)
      expect(q).toContain('DETACH DELETE')
    }
  })

  it('nessuna delle due cancella senza un limite', () => {
    for (const q of [PURGA_SERVER_CYPHER, PURGA_BROWSER_CYPHER]) {
      expect(q, 'una DELETE senza WHERE è un archivio perso').toMatch(/WHERE .*\$limite/)
    }
  })
})
