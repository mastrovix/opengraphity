import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { gql } from '@apollo/client'
import { Sidebar } from './Sidebar'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock, anomalyStatsMock, anomalyStatsErrorMock } from '@/test/mocks/gql'

// Stesso documento (privato) di Sidebar.tsx: il MockLink confronta la query stampata.
const MY_PENDING_APPROVALS_COUNT = gql`
  query MyPendingApprovalsCount {
    myPendingApprovals { id }
  }
`
function pendingMock(n = 0): GqlMock {
  return {
    request: { query: MY_PENDING_APPROVALS_COUNT },
    result: { data: { myPendingApprovals: Array.from({ length: n }, (_, i) => ({ __typename: 'ApprovalRequest', id: `a${i}` })) } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

function renderSidebar(role: string, opts: { route?: string; collapsed?: boolean; mocks?: GqlMock[] } = {}) {
  const onToggle = vi.fn()
  const utils = renderWithProviders(
    <Sidebar collapsed={opts.collapsed ?? false} width={240} onToggle={onToggle} />,
    { route: opts.route ?? '/dashboard', mocks: opts.mocks ?? [meMock(role), anomalyStatsMock(0), pendingMock(0)] },
  )
  return { ...utils, onToggle }
}

const nav = () => screen.getByRole('navigation', { name: 'Main menu' })

describe('Sidebar — visibilità per ruolo', () => {
  it('utente non admin: nessun gruppo Teams & Users / Configuration / ADMIN', async () => {
    renderSidebar('operator')
    // le voci comuni ci sono subito
    expect(within(nav()).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard')
    expect(within(nav()).getByRole('button', { name: 'ITIL Processes' })).toBeInTheDocument()
    // dopo il caricamento di `me` (mock a delay 0) i gruppi admin restano assenti
    await new Promise((r) => setTimeout(r, 10))
    expect(within(nav()).queryByRole('button', { name: 'Teams & Users' })).not.toBeInTheDocument()
    expect(within(nav()).queryByRole('button', { name: 'Configuration' })).not.toBeInTheDocument()
    expect(within(nav()).queryByText('ADMIN')).not.toBeInTheDocument()
    expect(within(nav()).queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument()
  })

  it('admin: gruppi Teams & Users, Configuration e sezione ADMIN con Settings', async () => {
    renderSidebar('admin')
    expect(await within(nav()).findByRole('button', { name: 'Teams & Users' })).toBeInTheDocument()
    expect(within(nav()).getByRole('button', { name: 'Configuration' })).toBeInTheDocument()
    expect(within(nav()).getByText('ADMIN')).toBeInTheDocument()
    expect(within(nav()).getByRole('link', { name: 'Audit Log' })).toHaveAttribute('href', '/admin/audit')
    expect(within(nav()).getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('finché `me` non risponde (o è null) nessuna voce admin', async () => {
    renderSidebar('x', { mocks: [meMock(null), anomalyStatsMock(0), pendingMock(0)] })
    await new Promise((r) => setTimeout(r, 20))
    expect(within(nav()).queryByRole('button', { name: 'Teams & Users' })).not.toBeInTheDocument()
  })
})

describe('Sidebar — gruppi collassabili', () => {
  it('un gruppo chiuso ha aria-expanded=false; il click lo apre e mostra le voci', async () => {
    const { user } = renderSidebar('operator')
    const itil = within(nav()).getByRole('button', { name: 'ITIL Processes' })
    expect(itil).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav()).queryByRole('link', { name: 'Incidents' })).not.toBeInTheDocument()

    await user.click(itil)
    expect(itil).toHaveAttribute('aria-expanded', 'true')
    const panel = document.getElementById(itil.getAttribute('aria-controls')!)!
    expect(within(panel).getByRole('link', { name: 'Incidents' })).toHaveAttribute('href', '/incidents')
    expect(within(panel).getByRole('link', { name: 'Changes' })).toHaveAttribute('href', '/changes')

    await user.click(itil)
    expect(itil).toHaveAttribute('aria-expanded', 'false')
  })

  it('il gruppo che contiene la route corrente parte aperto', () => {
    renderSidebar('operator', { route: '/problems/42' })
    const itil = within(nav()).getByRole('button', { name: 'ITIL Processes' })
    expect(itil).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav()).getByRole('button', { name: 'Reporting' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('sidebar collassata: i gruppi diventano link icona con title, il bottone di espansione ha aria-expanded=false', async () => {
    const { user, onToggle } = renderSidebar('operator', { collapsed: true })
    expect(within(nav()).queryByRole('button', { name: 'ITIL Processes' })).not.toBeInTheDocument()
    expect(within(nav()).getByTitle('ITIL Processes')).toHaveAttribute('href', '/incidents')
    const expand = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    await user.click(expand)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('sidebar espansa: il bottone "Collapse sidebar" ha aria-expanded=true', () => {
    renderSidebar('operator')
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('Sidebar — badge', () => {
  it('anomalie critiche > 0 → badge con conteggio e nome accessibile', async () => {
    const { user } = renderSidebar('operator', { mocks: [meMock('operator'), anomalyStatsMock(3), pendingMock(0)] })
    await user.click(within(nav()).getByRole('button', { name: 'Analysis' }))
    expect(await screen.findByLabelText('3 critical anomalies')).toHaveTextContent('3')
  })

  it('errore nel caricamento anomalie → badge "!" con messaggio nel title (mai nascosto)', async () => {
    const { user } = renderSidebar('operator', { mocks: [meMock('operator'), anomalyStatsErrorMock('stats down'), pendingMock(0)] })
    await user.click(within(nav()).getByRole('button', { name: 'Analysis' }))
    const badge = await screen.findByLabelText('Error loading anomalies')
    expect(badge).toHaveTextContent('!')
    expect(badge).toHaveAttribute('title', 'stats down')
  })

  it('approvazioni pendenti → badge sulla voce Approvals', async () => {
    renderSidebar('operator', { mocks: [meMock('operator'), anomalyStatsMock(0), pendingMock(2)] })
    expect(await screen.findByLabelText('2 pending')).toHaveTextContent('2')
  })
})
