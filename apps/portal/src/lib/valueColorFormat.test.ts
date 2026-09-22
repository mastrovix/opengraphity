/**
 * IL COLORE DI UN VALORE E LE DATE.
 *
 * Il portale colorava la priorità con una mappa `high/medium/low` scritta
 * nella pagina, e ogni valore del cliente restava grigio (verifica «Cosa
 * resta cablato», ondata 1). Ora il colore lo dà il Dizionario, e qui si
 * traduce nella palette del portale — mai in un esadecimale: il tema resta
 * uno solo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { valueColorStyle } from './valueColor'
import { fmtDate, fmtDateLong, fmtDateTime, fmtDateTimeLong, fmtRelative } from './format'
import { VALUE_COLORS } from '@opengraphity/types'

afterEach(() => { vi.restoreAllMocks() })

describe('valueColorStyle', () => {
  it('ogni colore del vocabolario ha la sua famiglia, tutte con le tre tinte', () => {
    for (const c of VALUE_COLORS) {
      const s = valueColorStyle(c)
      expect(s.base, c).toBeTruthy()
      expect(s.text, c).toBeTruthy()
      expect(s.tint, c).toBeTruthy()
    }
  })

  it('nessun colore scelto = neutro, e non è un errore', () => {
    // «Nessuno gliel'ha dato» e «me ne hanno dato uno che non conosco» sono
    // due fatti diversi.
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const niente of [null, undefined]) {
      expect(valueColorStyle(niente)).toEqual(valueColorStyle('neutral'))
    }
    expect(errore).not.toHaveBeenCalled()
  })

  it('un colore che non esiste si DICE, e intanto si mostra neutro', () => {
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(valueColorStyle('fucsia')).toEqual(valueColorStyle('neutral'))
    expect(errore).toHaveBeenCalledWith('[valueColor] unknown dictionary color "fucsia"')
  })

  it('un esadecimale non è un colore del Dizionario: si rifiuta come gli altri', () => {
    // Nel dato sta il NOME di una famiglia, mai un colore: cosi' il tema
    // resta uno e accessibile.
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(valueColorStyle('#ff0000')).toEqual(valueColorStyle('neutral'))
    expect(errore).toHaveBeenCalled()
  })

  it('un nome che viene dal prototipo non passa per una famiglia', () => {
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const dalPrototipo of ['toString', 'constructor']) {
      expect(valueColorStyle(dalPrototipo), dalPrototipo).toEqual(valueColorStyle('neutral'))
    }
    expect(errore).toHaveBeenCalledTimes(2)
  })
})

describe('le date', () => {
  it('formatta giorno, mese e anno, e le forme lunghe aggiungono l\'ora', () => {
    const iso = '2026-09-08T08:30:00Z'
    expect(fmtDate(iso)).toMatch(/2026/)
    expect(fmtDateLong(iso)).toMatch(/2026/)
    expect(fmtDateTime(iso)).toMatch(/\d{2}:\d{2}/)
    expect(fmtDateTimeLong(iso)).toMatch(/\d{2}:\d{2}/)
  })

  it('niente data = niente testo, non "Invalid Date"', () => {
    for (const niente of [null, undefined, '']) {
      expect(fmtDate(niente)).toBe('')
      expect(fmtDateTime(niente)).toBe('')
    }
  })

  it('una data che non si sa leggere torna com\'è arrivata', () => {
    // Meglio il valore grezzo di «Invalid Date»: almeno si capisce che cosa
    // e' arrivato dal server.
    expect(fmtDate('ieri')).toBe('ieri')
    expect(fmtRelative('ieri')).toBe('ieri')
  })

  it('il tempo relativo guarda indietro e avanti, nell\'unità chiesta', () => {
    const treOreFa = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const fraDueGiorni = new Date(Date.now() + 2 * 86_400_000).toISOString()
    expect(fmtRelative(treOreFa)).toMatch(/3/)
    expect(fmtRelative(fraDueGiorni, 'day')).toMatch(/2/)
  })
})
