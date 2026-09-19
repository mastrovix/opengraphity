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

  it('etichette che non sono date restano com\'erano (null = non è una serie)', () => {
    expect(etichetteTemporali(['alta', 'bassa'], 'it')).toBeNull()
    expect(etichetteTemporali(['2026-01-01', 'alta'], 'it')).toBeNull()
    expect(etichetteTemporali([], 'it')).toBeNull()
  })
})
