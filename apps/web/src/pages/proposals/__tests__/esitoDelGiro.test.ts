/**
 * «HO CLICCATO ANALYZE NOW MA NON DÀ NULLA» (20 set 2026).
 *
 * Segnalazione del proprietario, riprodotta end-to-end nel browser. Il giro
 * aveva funzionato: su `opengrafo` il modello era stato chiamato e aveva
 * prodotto QUATTRO proposte. Due erano già sulla pagina, due sono state
 * BUTTATE dal tetto giornaliero — e la pagina diceva «Niente di nuovo da
 * proporre».
 *
 * Era falso in un modo che costa: chi legge crede che non ci fosse niente da
 * dire, mentre il modello è stato pagato e due proposte sono sparite. I
 * motivi arrivavano già dall'API; la pagina li buttava.
 */
import { describe, it, expect } from 'vitest'
import { esitoDelGiro } from '../ProposalsPage'

/** Una `t` finta che mostra chiave e conteggio: qui si prova la LOGICA, non le frasi. */
const t = (chiave: string, o?: Record<string, unknown>): string => {
  const c = o?.['count']
  const r = o?.['reasons']
  return `${chiave}(${String(c ?? '')}${r ? `:${String(r)}` : ''})`
}
const s = (name: string, value: string) => ({ name, value })

describe('quando non nasce niente, si dice PERCHÉ', () => {
  it('il caso vero di opengrafo: 2 già presenti, 2 buttate dal tetto', () => {
    const msg = esitoDelGiro(0, [s('gia_presente', '2'), s('tetto_giornaliero', '2')], t)
    expect(msg).toContain('runSkipped.gia_presente(2)')
    expect(msg).toContain('runSkipped.tetto_giornaliero(2)')
    // Il totale prodotto dal modello: quattro, non zero.
    expect(msg).toContain('runSkipped.intro(4')
    // E soprattutto NON si dice più «niente da proporre».
    expect(msg).not.toContain('runNothing')
  })

  it('«niente di nuovo» resta solo quando è VERO: nessuno scarto', () => {
    expect(esitoDelGiro(0, [], t)).toContain('runNothing')
  })

  it('uno scarto a zero non è uno scarto', () => {
    expect(esitoDelGiro(0, [s('gia_presente', '0')], t)).toContain('runNothing')
  })

  it('un valore non numerico non inventa un conteggio', () => {
    expect(esitoDelGiro(0, [s('gia_presente', 'boh')], t)).toContain('runNothing')
  })
})

describe('quando qualcosa nasce', () => {
  it('si dice quante, e anche quelle che non ce l\'hanno fatta', () => {
    const msg = esitoDelGiro(3, [s('tetto_aperte', '1')], t)
    expect(msg).toContain('runCreated(3)')
    expect(msg).toContain('runSkipped.tetto_aperte(1)')
  })

  it('senza scarti, il messaggio resta quello di prima', () => {
    expect(esitoDelGiro(2, [], t)).toBe('pages.proposals.runCreated(2)')
  })
})
