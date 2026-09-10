import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { EventHistorySection } from './EventHistorySection'
import { renderWithProviders } from '@/test/utils'
import { EVENT_HISTORY_KINDS, type EventHistoryEntry, type EventHistoryKind } from '@/types/events'

const INCIDENT = { id: 'inc1', number: 'INC-0042', title: 'CPU saturation' }
const CHANGE   = { id: 'chg1', code: 'CHG-0007', title: 'Freeze DB' }
const CI       = { id: 'ci1', name: 'web-01', type: 'server' }
const USER     = { id: 'u2', name: 'Anna Bianchi' }

let seq = 0
/** Voce del monitoraggio, senza riferimenti: ogni test aggiunge ciò che la frase cita. */
function entry(kind: EventHistoryKind, over: Partial<EventHistoryEntry> = {}): EventHistoryEntry {
  seq += 1
  return {
    id: `h${seq}`, at: new Date(Date.now() - seq * 60_000).toISOString(), kind,
    outcome: null, actorId: 'monitoring', actor: null, incident: null, change: null, ci: null, severity: null, note: null,
    ...over,
  }
}

const rows = () => screen.getAllByTestId('history-entry')
/** La riga di un kind (una sola per test). */
function rowOf(kind: string): HTMLElement {
  const found = rows().filter((r) => r.dataset['kind'] === kind)
  if (found.length !== 1) throw new Error(`attese 1 riga per "${kind}", trovate ${found.length}`)
  return found[0]!
}
const textOf = (kind: string) => rowOf(kind).textContent ?? ''

describe('EventHistorySection', () => {
  it('cicli: prima vista (sintesi), nuovo ciclo, rientro e cambio severità con il badge', () => {
    const entries = [
      entry('severity_changed', { severity: 'critical', note: 'warning' }),
      entry('cycle_resolved',   { severity: 'warning' }),
      entry('cycle_firing',     { severity: 'warning' }),
      entry('first_seen',       { severity: 'info' }),
    ]
    renderWithProviders(<EventHistorySection entries={entries} total={4} />)
    expect(screen.getByRole('button', { name: /History/ })).toHaveTextContent('4')
    expect(rows()).toHaveLength(4)
    expect(textOf('first_seen')).toMatch(/^First seen by monitoring with severity Info\./)
    expect(textOf('cycle_firing')).toMatch(/^Firing again \(new cycle\) with severity Warning\./)
    expect(textOf('cycle_resolved')).toMatch(/^Cleared by the source; last severity Warning\./)
    // la severità precedente (nota) è nella frase, non ripetuta sotto
    expect(textOf('severity_changed')).toMatch(/^Severity changed from Warning to Critical\./)
    expect(rowOf('severity_changed').querySelectorAll('div').length).toBe(3)   // frase + istante, nessuna nota
    // istante: data formattata e "N min fa"
    expect(within(rowOf('first_seen')).getByText(/ago$/)).toBeInTheDocument()
    expect(screen.queryByText(/Showing the latest/)).not.toBeInTheDocument()
  })

  it('correlazione: esito con l\'etichetta breve e link all\'incident; senza incident la frase non lo cita', () => {
    const entries = [
      entry('correlated', { outcome: 'skipped_orphan' }),
      entry('correlated', { outcome: 'opened', incident: INCIDENT }),
      entry('auto_resolve_skipped', { incident: INCIDENT, note: 'incident already resolved by hand' }),
      entry('auto_resolved', { incident: INCIDENT }),
    ]
    renderWithProviders(<EventHistorySection entries={entries} total={4} />)
    const [orphan, opened, skipped, resolved] = rows() as [HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    expect(orphan).toHaveTextContent('Correlation: no CI recognised.')
    expect(within(orphan).queryByRole('link')).not.toBeInTheDocument()
    expect(opened).toHaveTextContent('Correlation: incident opened — incident INC-0042.')
    expect(within(opened).getByRole('link', { name: 'INC-0042' })).toHaveAttribute('href', '/incidents/inc1')
    expect(skipped).toHaveTextContent('Incident INC-0042 not resolved automatically.')
    expect(within(skipped).getByText('incident already resolved by hand')).toBeInTheDocument()   // la nota (motivo)
    expect(resolved).toHaveTextContent('Incident INC-0042 resolved automatically: the source cleared the alarm.')
  })

  it('silenzio, instabilità e tempesta: link alla change, nota "N passaggi", link all\'incident di tempesta', () => {
    const entries = [
      entry('stable'),
      entry('flapping', { note: '6 transitions in 10 min' }),
      entry('storm', { incident: { id: 'inc9', number: 'INC-0099', title: 'Storm' } }),
      entry('unsuppressed', { change: CHANGE }),
      entry('suppressed', { change: CHANGE }),
    ]
    renderWithProviders(<EventHistorySection entries={entries} total={5} />)
    expect(textOf('suppressed')).toMatch(/^Suppressed by change CHG-0007 in its release window\./)
    expect(within(rowOf('suppressed')).getByRole('link', { name: 'CHG-0007' })).toHaveAttribute('href', '/changes/chg1')
    expect(textOf('unsuppressed')).toMatch(/^Suppression by change CHG-0007 lifted\./)
    expect(textOf('flapping')).toMatch(/^Marked as flapping: no incident opened or closed until it stays stable\./)
    expect(within(rowOf('flapping')).getByText('6 transitions in 10 min')).toBeInTheDocument()
    expect(textOf('stable')).toMatch(/^Stable again: normal correlation resumes\./)
    expect(textOf('storm')).toMatch(/^Grouped into the storm incident INC-0099\./)
    expect(within(rowOf('storm')).getByRole('link', { name: 'INC-0099' })).toHaveAttribute('href', '/incidents/inc9')
  })

  it('azioni manuali: nome dell\'utente, link al CI, nota della risoluzione, alias tradotto', () => {
    const entries = [
      entry('reevaluated',              { actorId: 'u2', actor: USER }),
      entry('incident_opened_manually', { actorId: 'u2', actor: USER, incident: INCIDENT }),
      entry('linked_ci',                { actorId: 'u2', actor: USER, ci: CI, note: 'alias' }),
      entry('resolved_manually',        { actorId: 'u2', actor: USER, note: 'false positive' }),
      entry('acknowledged',             { actorId: 'u2', actor: USER }),
    ]
    renderWithProviders(<EventHistorySection entries={entries} total={5} />)
    expect(textOf('acknowledged')).toMatch(/^Acknowledged by Anna Bianchi\./)
    expect(textOf('resolved_manually')).toMatch(/^Resolved manually by Anna Bianchi\./)
    expect(within(rowOf('resolved_manually')).getByText('false positive')).toBeInTheDocument()
    expect(textOf('linked_ci')).toMatch(/^Linked to CI web-01 by Anna Bianchi\./)
    expect(within(rowOf('linked_ci')).getByRole('link', { name: 'web-01' })).toHaveAttribute('href', '/ci/server/ci1')
    expect(within(rowOf('linked_ci')).getByText('Alias created: the source will recognise the CI on its own.')).toBeInTheDocument()
    expect(textOf('incident_opened_manually')).toMatch(/^Incident INC-0042 opened by Anna Bianchi\./)
    expect(within(rowOf('incident_opened_manually')).getByRole('link', { name: 'INC-0042' })).toHaveAttribute('href', '/incidents/inc1')
    expect(textOf('reevaluated')).toMatch(/^Re-evaluation requested by Anna Bianchi\./)
  })

  it('ogni kind del vocabolario ha una frase (nessuna voce resta "sconosciuta")', () => {
    const entries = EVENT_HISTORY_KINDS.map((k) => entry(k, { severity: 'warning', incident: INCIDENT, change: CHANGE, ci: CI, outcome: 'opened' }))
    renderWithProviders(<EventHistorySection entries={entries} total={entries.length} />)
    expect(rows()).toHaveLength(EVENT_HISTORY_KINDS.length)
    expect(screen.queryByText(/Unknown entry/)).not.toBeInTheDocument()
  })

  it('fail-loud: kind sconosciuto → "Unknown entry" visibile e console.error; riferimenti mancanti detti in chiaro', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const entries = [
      entry('teleported' as EventHistoryKind, { note: 'raw note' }),
      entry('storm'),                                   // incident cancellato
      entry('suppressed'),                              // change mancante
      entry('first_seen'),                              // sintesi senza severità
      entry('correlated', { outcome: 'weird' as never, incident: INCIDENT }),
      entry('acknowledged', { actorId: 'u-gone' }),     // utente cancellato: resta l'id
    ]
    renderWithProviders(<EventHistorySection entries={entries} total={6} />)
    expect(textOf('teleported')).toMatch(/^Unknown entry: teleported\./)
    expect(within(rowOf('teleported')).getByText('raw note')).toBeInTheDocument()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[EVENT_HISTORY_ICON] valore sconosciuto: "teleported"'))
    expect(textOf('storm')).toMatch(/^Grouped into the storm incident incident not recorded\./)
    expect(within(rowOf('storm')).queryByRole('link')).not.toBeInTheDocument()
    expect(textOf('suppressed')).toMatch(/^Suppressed by change change not recorded in its release window\./)
    expect(textOf('first_seen')).toMatch(/^First seen by monitoring with severity severity not recorded\./)
    expect(textOf('correlated')).toMatch(/^Correlation: unknown outcome: weird — incident INC-0042\./)
    expect(textOf('acknowledged')).toMatch(/^Acknowledged by u-gone\./)
  })

  it('più voci del caricato: "mostrate le ultime N di M"; nessuna voce: testo vuoto esplicito', () => {
    const { unmount } = renderWithProviders(<EventHistorySection entries={[entry('first_seen', { severity: 'info' })]} total={250} />)
    expect(screen.getByText('Showing the latest 1 of 250 entries.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /History/ })).toHaveTextContent('250')
    unmount()
    renderWithProviders(<EventHistorySection entries={[]} total={0} />)
    expect(screen.getByText('No entries.')).toBeInTheDocument()
  })
})
