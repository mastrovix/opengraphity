/**
 * The "Incident" column of the event console and the sentence of the event
 * detail: what the correlation policy did with an alarm.
 *
 * Why it matters: an operator reads this cell to decide whether to act. A
 * storm without a known incident must still say "Storm" (not a dead link);
 * a suppression whose change is unknown must still say "suppressed"; an
 * outcome the API adds later must be named, not swallowed; and inside a
 * clickable row, clicking the incident link must open the incident, not the
 * event the row points to.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import { EventIncidentCell, correlationSentence } from './eventCorrelation'

const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string
const at = '2026-09-14T00:48:00Z'
const sentence = (ev: Record<string, unknown>, policy: unknown = null) =>
  correlationSentence(i18n.t, { correlationAt: at, ...ev } as never, policy as never, { statusLabel: (s) => s })
const cell = (ev: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  renderWithProviders(<EventIncidentCell event={ev as never} {...extra} />)

describe('EventIncidentCell', () => {
  it('inside a clickable row, the incident link does not trigger the row', async () => {
    const rowClick = vi.fn()
    renderWithProviders(
      <div onClick={rowClick}>
        <EventIncidentCell stopRowClick event={{ correlation: 'opened', incident: { id: 'i1', number: 'INC1' } } as never} />
      </div>,
    )
    await userEvent.click(screen.getByRole('link', { name: 'INC1' }))
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('a flapping alarm keeps the link to its incident next to the chip', () => {
    cell({ correlation: 'flapping', transitions24h: 6, incident: { id: 'i9', number: 'INC9' } })
    expect(screen.getByText(T('events.correlation.chip.flapping', { count: 6 }))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'INC9' })).toHaveAttribute('href', '/incidents/i9')
  })

  it('a storm without a known incident says "Storm" and links nowhere', () => {
    cell({ correlation: 'storm', incident: null, source: null })
    expect(screen.getByText(T('events.correlation.chip.stormUnknown'))).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    // No source: the hint uses a dash instead of "undefined".
    expect(screen.getByText(T('events.correlation.chip.stormHint', { source: '—' }))).toBeInTheDocument()
  })

  it('a storm without a CI names the source, or a dash when unknown', () => {
    cell({ correlation: 'storm_no_ci', source: null })
    expect(screen.getByText(T('events.correlation.chip.storm_no_ci'))).toBeInTheDocument()
    expect(screen.getByText(T('events.correlation.text.storm_no_ci', { source: '—' }))).toBeInTheDocument()
  })

  it('a suppression whose change is unknown is still a suppression, without a link', () => {
    cell({ correlation: 'suppressed', suppressedBy: null, incident: null })
    expect(screen.getByText(T('events.correlation.chip.suppressedUnknown'))).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('an event being re-evaluated says so', () => {
    cell({ correlation: 'pending', incident: null })
    expect(screen.getByText(T('events.correlation.chip.pending'))).toBeInTheDocument()
  })

  it('an outcome the UI does not know is named, not hidden behind a dash', () => {
    cell({ correlation: 'brand_new_outcome', incident: null })
    expect(screen.getByText('brand_new_outcome')).toBeInTheDocument()
    expect(screen.getByText(T('events.correlation.text.unknown', { value: 'brand_new_outcome' }))).toBeInTheDocument()
  })
})

describe('correlationSentence — the remaining outcomes', () => {
  const inc = { id: 'i1', number: 'INC7' }

  it('attached / reopened / auto-resolved name the incident', () => {
    expect(sentence({ correlation: 'reopened', incident: inc })).toContain('INC7')
    expect(sentence({ correlation: 'auto_resolved', incident: inc })).toContain('INC7')
    // Without an incident the number is a dash, never "undefined".
    expect(sentence({ correlation: 'attached', incident: null })).not.toContain('undefined')
  })

  it('suppressed without the change says it without inventing a code', () => {
    expect(sentence({ correlation: 'suppressed', suppressedBy: null })).toBe(T('events.correlation.text.suppressedUnknown'))
  })

  it('none and pending have their own sentence', () => {
    expect(sentence({ correlation: 'none' })).toBe(T('events.correlation.text.none'))
    expect(sentence({ correlation: 'pending' })).toBe(T('events.correlation.text.pending'))
  })

  it('a storm names the source and the incident, or says there is no incident', () => {
    expect(sentence({ correlation: 'storm', source: { name: 'Zabbix' }, incident: inc })).toContain('INC7')
    const noInc = sentence({ correlation: 'storm', source: null, incident: null })
    expect(noInc).toContain('—')
    expect(noInc).not.toContain('INC')
  })

  it('storm_no_ci names the source', () => {
    expect(sentence({ correlation: 'storm_no_ci', source: { name: 'Zabbix' } })).toContain('Zabbix')
    expect(sentence({ correlation: 'storm_no_ci', source: null })).toContain('—')
  })

  it('an unknown outcome is named', () => {
    expect(sentence({ correlation: 'brand_new_outcome' })).toBe(T('events.correlation.text.unknown', { value: 'brand_new_outcome' }))
  })
})
