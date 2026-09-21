/**
 * IL PERIODO SI SALVA SOLO SE C'È UNA DATA (20 set 2026).
 *
 * `buildInput` mandava `groupByGranularity: granularita || 'day'` — SEMPRE,
 * qualunque grafico, qualunque campo. Un istogramma «Incident per stato»
 * nasceva con «per giorno» addosso, e il costruttore di query lo prendeva
 * sul serio: `toString(date(datetime(n0.status)))`. Neo4j rispondeva «Text
 * cannot be parsed to a DateTime "completed"» — non al salvataggio, che
 * riusciva, ma all'ESECUZIONE: aprendo il report, o di notte quando lo
 * schedulatore lo manda per email.
 *
 * Il valore non era la scelta di nessuno: la tendina del periodo è nascosta
 * quando il campo non è una data, ma `granularita` restava nello stato dal
 * grafico di prima e partiva lo stesso. È la stessa trappola dello stato che
 * l'interfaccia ha smesso di mostrare — già vista con la misura su una
 * tabella e coi campi nascosti dei moduli.
 */
import { describe, it, expect } from 'vitest'
import { periodoDaSalvare } from '../components/ReportChartConfig'

describe('il periodo che finisce nella sezione salvata', () => {
  it('su una data si manda', () => {
    expect(periodoDaSalvare('month', 'resolved_at')).toBe('month')
    expect(periodoDaSalvare('year', 'created_at', 'datetime')).toBe('year')
  })

  it('SU UNO STATO no: è il caso che faceva cadere il report', () => {
    expect(periodoDaSalvare('day', 'status')).toBeNull()
    expect(periodoDaSalvare('month', 'state')).toBeNull()
    expect(periodoDaSalvare('day', 'severity', 'enum')).toBeNull()
  })

  it('senza campo di raggruppamento no', () => {
    expect(periodoDaSalvare('day', '')).toBeNull()
  })

  it('un campo data del CLIENTE lo dice il suo tipo, non il nome', () => {
    expect(periodoDaSalvare('month', 'data_di_consegna', 'date')).toBe('month')
    expect(periodoDaSalvare('month', 'data_di_consegna', 'text')).toBeNull()
  })

  it('chi non ha scelto un periodo ma raggruppa per data tiene «per giorno», come sempre', () => {
    expect(periodoDaSalvare('', 'created_at')).toBe('day')
  })
})
