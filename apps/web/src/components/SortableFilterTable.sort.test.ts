/**
 * Le SCALE si ordinano per rango, non in ordine alfabetico
 * (revisione totale · G-EVT-7).
 *
 * «Severità crescente» rispondeva critical, info, warning — un ordine che non
 * significa niente per chi guarda una console di allarmi. Il rango si dichiara
 * sulla colonna (`ColumnDef.rank`), mai indovinato dal nome del campo:
 * «resolved» è uno stato degli eventi ma anche uno stato dei ticket, e le due
 * scale non hanno lo stesso ordine.
 */
import { describe, it, expect } from 'vitest'
import { sortRowsBy } from './SortableFilterTable'

const SEVERITY = ['critical', 'warning', 'info'] as const
const righe = [
  { id: 'a', severity: 'info' },
  { id: 'b', severity: 'critical' },
  { id: 'c', severity: 'warning' },
]

describe('sortRowsBy con una scala', () => {
  it('crescente = dal più grave, non in ordine di parola', () => {
    expect(sortRowsBy(righe, 'severity', 'asc', SEVERITY).map((r) => r.severity))
      .toEqual(['critical', 'warning', 'info'])
    expect(sortRowsBy(righe, 'severity', 'desc', SEVERITY).map((r) => r.severity))
      .toEqual(['info', 'warning', 'critical'])
  })

  it('senza scala resta il confronto testuale di sempre', () => {
    expect(sortRowsBy(righe, 'severity', 'asc').map((r) => r.severity))
      .toEqual(['critical', 'info', 'warning'])
  })

  it('un valore fuori scala va in fondo invece di mescolarsi', () => {
    const conEstraneo = [...righe, { id: 'd', severity: 'urgentissimo' }]
    expect(sortRowsBy(conEstraneo, 'severity', 'asc', SEVERITY).map((r) => r.severity))
      .toEqual(['critical', 'warning', 'info', 'urgentissimo'])
  })

  it('non muta le righe di partenza', () => {
    const prima = righe.map((r) => r.id)
    sortRowsBy(righe, 'severity', 'asc', SEVERITY)
    expect(righe.map((r) => r.id)).toEqual(prima)
  })

  it('i null restano in fondo', () => {
    const conNull = [{ id: 'x', severity: null }, { id: 'y', severity: 'info' }]
    expect(sortRowsBy(conNull, 'severity', 'asc', SEVERITY).map((r) => r.id)).toEqual(['y', 'x'])
  })
})
