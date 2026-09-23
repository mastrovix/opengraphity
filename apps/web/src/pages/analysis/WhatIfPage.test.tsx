/**
 * WHAT-IF: a CI is found by name and reads with its TYPE'S LABEL (D53, tour
 * of 23 Sep 2026) — the search dropdown showed «database_instance», the
 * internal key, where the CMDB shows «Database Instance».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { WhatIfPage } from './WhatIfPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
// The path graph is D3: what matters here is WHICH path the row opens.
vi.mock('@/components/MiniPathGraph', () => ({
  MiniPathGraph: ({ pathNames }: { pathNames: string[] }) => <div data-testid="mini-path">{pathNames.join(' > ')}</div>,
}))

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [] }
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [
    { id: 'db-1', name: 'orders-db', type: 'database_instance' },
    { id: 'srv-1', name: 'orders-app-01', type: 'server' },
  ] } }
})

describe('WhatIfPage — the CI search', () => {
  it('each CI found reads with the label of its type, not the internal key', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.type(screen.getByRole('textbox', { name: /Search CI by name/i }), 'orders')
    const option = screen.getByRole('button', { name: /orders-db/ })
    expect(within(option).getByText('Database Instance')).toBeInTheDocument()
    expect(within(option).queryByText('database_instance')).not.toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /orders-app-01/ })).getByText('Server')).toBeInTheDocument()
  })

  it('choosing a CI puts its name in the box', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    const box = screen.getByRole('textbox', { name: /Search CI by name/i })
    await user.type(box, 'orders')
    await user.click(screen.getByRole('button', { name: /orders-db/ }))
    expect(box).toHaveValue('orders-db')
  })
})

const ci = (id: string, name: string, type: string, over: Record<string, unknown> = {}) => ({
  id, name, type, environment: null, status: 'active', impactLevel: 'high', impactPath: ['orders-db', name], isRedundant: false, ...over,
})
const RESULT = {
  targetCI: ci('db-1', 'orders-db', 'database_instance', { impactLevel: 'target', impactPath: [] }),
  action: 'impact',
  impactedCIs: [
    ci('srv-1', 'orders-app-01', 'server', { environment: 'production', impactLevel: 'critical' }),
    ci('db-2', 'reports-db', 'database_instance'),
  ],
  impactedServices: [],
  impactedTeams: [{ id: 't1', name: 'DBA', role: 'owner', impactedCICount: 2 }],
  totalImpacted: 2, riskScore: 70, hasRedundancy: false, openIncidents: 1,
}

describe('WhatIfPage — the analysis', () => {
  it('runs on the chosen CI, with the chosen action and depth', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: /Search CI by name/i }), 'orders')
    await user.click(screen.getByRole('button', { name: /orders-db/ }))
    await user.click(screen.getByRole('button', { name: 'Analyze removal' }))
    expect(screen.getByRole('button', { name: 'Analyze removal' })).toHaveAttribute('aria-pressed', 'true')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Analysis depth' }), '3')
    await user.click(screen.getByRole('button', { name: 'Analyze' }))
    expect(apolloFinto.chiamata('WhatIfAnalysis')).toEqual({ ciId: 'db-1', action: 'remove', depth: 3 })
  })

  it('the impacted CIs read with their type label (D53), not the internal key', () => {
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: RESULT }
    renderWithProviders(<WhatIfPage />)
    expect(screen.getByText('If orders-db becomes unavailable: impacted CIs 2, services 0, teams 1. Risk 70/100.')).toBeInTheDocument()
    const row = screen.getByRole('row', { name: /reports-db/ })
    expect(within(row).getByText('Database Instance')).toBeInTheDocument()
    expect(within(row).queryByText('database_instance')).not.toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: /orders-app-01/ })).getByText('Server')).toBeInTheDocument()
  })

  it('a row opens the path to the CI hit, and the CI itself', async () => {
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: RESULT }
    const { user } = renderWithProviders(<WhatIfPage />)
    const row = screen.getByRole('row', { name: /orders-app-01/ })
    await user.click(within(row).getByTitle('View path'))
    expect(screen.getByTestId('mini-path')).toHaveTextContent('orders-db > orders-app-01')
    await user.click(within(row).getByText('orders-app-01'))
    await attendiURL('/ci/server/srv-1')
  })

  it('the services and teams tabs: an empty list says so, a team shows how many of its CIs are hit', async () => {
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: RESULT }
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(screen.getByRole('button', { name: 'Services (0)' }))
    expect(screen.getByText('No impacted services')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Teams (1)' }))
    const team = screen.getByRole('row', { name: /DBA/ })
    expect(within(team).getByText('2')).toBeInTheDocument()
  })
})
