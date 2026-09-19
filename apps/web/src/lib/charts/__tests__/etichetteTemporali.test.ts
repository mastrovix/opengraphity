/**
 * L'ASSE DI UNA SERIE SI LEGGE (19 set 2026).
 *
 * Il server manda date ISO e l'asse le stampava per intero: nove
 * «2026-01-01» sovrapposte. «Non si capisce nulla — in questi casi l'anno
 * dovrebbe essere in basso e ogni mese mostrare solo il mese, come farebbe
 * Excel.»
 */
import { describe, it, expect } from 'vitest'
import { etichetteTemporali } from '../echartsOptions'

describe('etichetteTemporali', () => {
  it('una serie mensile mostra il mese, e l\'anno solo quando cambia', () => {
    const out = etichetteTemporali(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'], 'it')
    expect(out).toEqual(['nov\n2025', 'dic', 'gen\n2026', 'feb'])
  })

  it('in inglese i mesi sono inglesi', () => {
    expect(etichetteTemporali(['2026-01-01', '2026-02-01'], 'en')).toEqual(['Jan\n2026', 'Feb'])
  })

  it('una serie giornaliera mostra giorno e mese', () => {
    const out = etichetteTemporali(['2026-04-06', '2026-04-07'], 'it')
    expect(out![0]).toBe('6 apr\n2026')
    expect(out![1]).toBe('7 apr')
  })

  it('il primo gennaio non scivola a dicembre dell\'anno prima', () => {
    // Costruire la data a mezzanotte locale la sposterebbe indietro nei fusi
    // a ovest: si usa mezzogiorno UTC.
    expect(etichetteTemporali(['2026-01-01'], 'it')).toEqual(['gen\n2026'])
  })

  it('una serie annuale mostra solo l\'anno: «gen» sopra ogni anno sarebbe rumore', () => {
    expect(etichetteTemporali(['2024-01-01', '2025-01-01', '2026-01-01'], 'it')).toEqual(['2024', '2025', '2026'])
  })

  it('un solo mese di gennaio non diventa una serie annuale', () => {
    // Gennaio e febbraio: è mensile, non annuale.
    expect(etichetteTemporali(['2026-01-01', '2026-02-01'], 'it')).toEqual(['gen\n2026', 'feb'])
  })

  it('etichette che non sono date restano com\'erano (null = non è una serie)', () => {
    expect(etichetteTemporali(['alta', 'bassa'], 'it')).toBeNull()
    expect(etichetteTemporali(['2026-01-01', 'alta'], 'it')).toBeNull()
    expect(etichetteTemporali([], 'it')).toBeNull()
  })
})

/**
 * SENZA UN ASSE CONDIVISO l'etichetta sta su una riga e porta sempre l'anno:
 * in una torta ogni fetta è per conto sua, e «gen» da solo non dice di quale
 * anno sia. «Ma anche per le torte non ha senso vedere la data completa»
 * (19 set 2026).
 */
describe('etichette a una riga (torte, barre orizzontali)', () => {
  it('per mese: mese e anno, senza a capo', () => {
    expect(etichetteTemporali(['2026-01-01', '2026-02-01'], 'it', { unaRiga: true }))
      .toEqual(['gen 2026', 'feb 2026'])
  })

  it('per anno: solo l\'anno', () => {
    expect(etichetteTemporali(['2025-01-01', '2026-01-01'], 'it', { unaRiga: true }))
      .toEqual(['2025', '2026'])
  })

  it('per giorno: giorno, mese e anno', () => {
    expect(etichetteTemporali(['2026-04-06'], 'it', { unaRiga: true })).toEqual(['6 apr 2026'])
  })
})
