/**
 * Azioni per riga con dialoghi (D·1.1): "Risolvi" e "Collega a CI" vivono
 * dentro una riga cliccabile della console. Un click nel textarea, su un
 * risultato della ricerca o sul footer del dialogo non deve risalire alla
 * riga (navigazione al dettaglio): il Modal è in portal e ferma la propagazione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { EventActions } from './EventActions'
import { GET_ALL_CIS } from '@/graphql/queries'
import { RESOLVE_EVENT, LINK_EVENT_TO_CI, ACKNOWLEDGE_EVENT } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import type { EventRow } from '@/types/events'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const EVENT: EventRow = {
  id: 'e1', status: 'firing', severity: 'critical', title: 'Disk full on db-99', resource: 'db-99', resourceKind: 'hostname',
  count: 3, lastSeenAt: '2026-09-09T08:00:00Z', acknowledgedAt: null,
  source: { id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
  ci: null, incident: null, suppressedBy: null, correlation: 'skipped_orphan', correlationAt: '2026-09-09T08:00:00Z',
  flappingSince: null, transitions24h: 0, matchReason: 'ambiguous',
}

/** Evento completo come lo restituiscono le mutation (EventFields). */
const FULL = {
  __typename: 'Event', ...EVENT, fingerprint: 'fp', externalId: null, resourceExternalId: null, maxSeverity: 'critical',
  description: null, labels: '{}', firstSeenAt: '2026-09-09T07:00:00Z', resolvedAt: null, acknowledgedBy: null,
  source: { __typename: 'MonitoringSourceRef', ...EVENT.source }, ci: null, incident: null, suppressedBy: null,
}

const ciSearchMock = (): GqlMock => ({
  request: { query: GET_ALL_CIS, variables: { search: 'db-99', limit: 20 } },
  result: { data: { allCIs: { __typename: 'CIPage', total: 2, items: [
    { __typename: 'ConfigurationItem', id: 'ci-a', name: 'db-99', type: 'server', status: 'active', environment: 'production', description: null, createdAt: null, ownerGroup: null, supportGroup: null },
    { __typename: 'ConfigurationItem', id: 'ci-b', name: 'db-99-replica', type: 'server', status: 'active', environment: 'staging', description: null, createdAt: null, ownerGroup: null, supportGroup: null },
  ] } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

/** La cella "Azioni" dentro una riga cliccabile (come nella console). */
function renderInRow(mocks: GqlMock[], onRow = vi.fn(), onChanged = vi.fn()) {
  const utils = renderWithProviders(
    <table><tbody>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- simula la riga cliccabile della console */}
      <tr onClick={onRow}><td><EventActions event={EVENT} onChanged={onChanged} compact /></td></tr>
    </tbody></table>,
    { mocks },
  )
  return { ...utils, onRow, onChanged }
}

describe('EventActions — dialoghi dentro una riga cliccabile', () => {
  it('"Risolvi": click nel textarea e nel dialogo non navigano; l\'invio manda la nota e chiama onChanged', async () => {
    const seen: unknown[] = []
    const resolveMock: GqlMock = {
      request: { query: RESOLVE_EVENT, variables: (v) => { seen.push(v); return true } },
      result: { data: { resolveEvent: { ...FULL, status: 'resolved', resolvedAt: '2026-09-09T09:00:00Z' } } },
    }
    const { user, onRow, onChanged } = renderInRow([resolveMock])

    await user.click(screen.getByRole('button', { name: 'Resolve' }))
    const dialog = await screen.findByRole('dialog', { name: 'Resolve alarm' })
    // il dialogo è in portal: non è un discendente della tabella
    expect(dialog.closest('table')).toBeNull()

    const note = within(dialog).getByLabelText('Note (optional)')
    await user.click(note)
    await user.click(within(dialog).getByText('Disk full on db-99'))
    await user.click(dialog)
    expect(onRow).not.toHaveBeenCalled()

    await user.type(note, 'False positive after disk cleanup')
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'e1', note: 'False positive after disk cleanup' }]))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith('Alarm resolved')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onRow).not.toHaveBeenCalled()
  })

  it('"Collega a CI": ricerca, selezione di un risultato (senza navigare), invio con createAlias', async () => {
    const seen: unknown[] = []
    const linkMock: GqlMock = {
      request: { query: LINK_EVENT_TO_CI, variables: (v) => { seen.push(v); return true } },
      result: { data: { linkEventToCI: { ...FULL, matchReason: 'manual', ci: { __typename: 'ConfigurationItemRef', id: 'ci-a', name: 'db-99', type: 'server', status: 'active', health: null } } } },
    }
    const { user, onRow, onChanged } = renderInRow([ciSearchMock(), linkMock])

    await user.click(screen.getByRole('button', { name: 'Link to CI' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link to a CI' })
    expect(within(dialog).getByText('The source identifies the object as Hostname "db-99".')).toBeInTheDocument()
    const submit = within(dialog).getByRole('button', { name: 'Link to CI' })
    expect(submit).toBeDisabled()

    await user.type(within(dialog).getByLabelText('Search CI'), 'db-99')
    const results = await within(dialog).findByRole('list', { name: 'CI search results' })
    const first = (await within(results).findByText('db-99')).closest('button')!
    expect(first).toHaveTextContent('server · production')
    await user.click(first)
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(onRow).not.toHaveBeenCalled()

    // "Ricorda alias" resta selezionato di default
    expect(within(dialog).getByRole('checkbox', { name: /Remember this name/ })).toBeChecked()
    await user.click(submit)
    await waitFor(() => expect(seen).toEqual([{ eventId: 'e1', ciId: 'ci-a', createAlias: true }]))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith('Alarm linked to db-99')
    expect(onRow).not.toHaveBeenCalled()
  })

  it('errore del server → toast di errore, il dialogo resta aperto', async () => {
    const failing: GqlMock = { request: { query: RESOLVE_EVENT, variables: () => true }, error: new Error('resolve failed') }
    const { user } = renderInRow([failing])
    await user.click(screen.getByRole('button', { name: 'Resolve' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: resolve failed'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('compact: i pulsanti hanno solo l\'icona ma nome accessibile e tooltip; "Prendi in carico" non naviga', async () => {
    const ackMock: GqlMock = {
      request: { query: ACKNOWLEDGE_EVENT, variables: { id: 'e1' } },
      result: { data: { acknowledgeEvent: { ...FULL, acknowledgedAt: '2026-09-09T09:00:00Z', acknowledgedBy: { __typename: 'User', id: 'u1', name: 'Anna' } } } },
    }
    const { user, onRow } = renderInRow([ackMock])
    const ack = screen.getByRole('button', { name: 'Acknowledge' })
    expect(ack).toHaveAttribute('title', 'Acknowledge')
    expect(ack).toHaveTextContent('')
    await user.click(ack)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Alarm acknowledged'))
    expect(onRow).not.toHaveBeenCalled()
  })
})
