/**
 * THE CHANGE CALENDAR MODEL: WHERE A WINDOW IS DRAWN.
 *
 * `barreDellaSettimana` decides in which columns of a week row a window
 * appears. Its column search starts from "nothing found yet" (-1), not from
 * Monday (0): with 0 a window that touches none of the days drawn would be
 * drawn from the first one, i.e. on a day it does not belong to. These tests
 * pin the two edges the main suite does not reach: a row with no days, and a
 * row whose days are not contiguous (a window in the gap belongs to none).
 */
import { describe, it, expect } from 'vitest'
import { barreDellaSettimana, conSovrapposizioni, type VoceCalendario } from '../changeCalendarModel'

const voce = (code: string, start: Date, end: Date): VoceCalendario => ({
  changeId: `id-${code}`, code, title: 'T', changeType: 'normal', priority: 'medium',
  currentStep: 'scheduled', kind: 'release', stepTitle: 'Deploy', taskCode: 'TASK1',
  ciId: 'ci-1', ciName: 'srv-01', start: start.toISOString(), end: end.toISOString(),
})

// Monday 14 and Wednesday 16 September 2026: Tuesday is not drawn.
const MONDAY = new Date(2026, 8, 14)
const WEDNESDAY = new Date(2026, 8, 16)

describe('barreDellaSettimana at the edges', () => {
  it('a row with no days has no bars', () => {
    const v = conSovrapposizioni([voce('CHG1', new Date(2026, 8, 14, 22), new Date(2026, 8, 14, 23))])
    expect(barreDellaSettimana(v, [])).toEqual([])
  })

  it('a window that falls on none of the days drawn gets no bar, not one on the first day', () => {
    const tuesday = conSovrapposizioni([voce('CHG2', new Date(2026, 8, 15, 10), new Date(2026, 8, 15, 12))])
    expect(barreDellaSettimana(tuesday, [MONDAY, WEDNESDAY])).toEqual([])
  })

  it('on the same row, a window on a day that is drawn lands on its own column', () => {
    const wednesday = conSovrapposizioni([voce('CHG3', new Date(2026, 8, 16, 10), new Date(2026, 8, 16, 12))])
    expect(barreDellaSettimana(wednesday, [MONDAY, WEDNESDAY])).toMatchObject([{ colonna: 1, span: 1, continuaPrima: false, continuaDopo: false }])
  })
})
