/**
 * CONFIGURATION ▸ DIAGNOSTICS: what is missing or broken in the tenant's
 * configuration, and where it is fixed.
 *
 * Since 20 Sep 2026 the list lives here instead of in a banner on every page
 * (the owner's decision); every page keeps only a badge with the number,
 * which leads here. So this page must actually show the list — or say, in
 * words, that there is nothing to fix: an empty page cannot tell «all clear»
 * from «did not answer». The panel's own rendering is tested with the panel.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_CONFIGURATION_ISSUES } from '@/graphql/queries'
import { ConfigurationDiagnosticsPage } from './ConfigurationDiagnosticsPage'

const issuesMock = (configurationIssues: unknown[]) => ({
  request: { query: GET_CONFIGURATION_ISSUES },
  result: { data: { configurationIssues } },
})

const STALE_KEYS = {
  kind: 'matrix_stale_keys', severity: 'warning', where: '/settings/domain-matrices', gaps: [],
  params: [{ name: 'matrix', value: 'priority' }, { name: 'count', value: '1' }],
}

describe('ConfigurationDiagnosticsPage', () => {
  it('lists what there is to fix, under its title, with the way to where it is fixed', async () => {
    const { user } = renderWithProviders(<ConfigurationDiagnosticsPage />, { mocks: [meMock('admin'), issuesMock([STALE_KEYS])] })
    expect(screen.getByRole('heading', { name: 'Configuration diagnostics' })).toBeInTheDocument()
    expect(screen.getByText('What is missing or inconsistent in this organization’s configuration, and where to fix it.')).toBeInTheDocument()
    expect(await screen.findByText('There is 1 thing to fix in the configuration')).toBeInTheDocument()
    expect(screen.getByText('Matrix «priority»: 1 key left over from a rename.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go and fix it' }))
    await attendiURL('/settings/domain-matrices')
  })

  it('with nothing to fix, the page says so in words', async () => {
    renderWithProviders(<ConfigurationDiagnosticsPage />, { mocks: [meMock('admin'), issuesMock([])] })
    expect(await screen.findByRole('region', { name: 'There is nothing to fix in the configuration.' })).toBeInTheDocument()
  })
})
