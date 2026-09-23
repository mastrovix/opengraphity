/**
 * THE DIAGNOSTICS PANEL: «Go and fix it» takes the administrator there.
 *
 * Each finding the API reports with a `where` offers a button to the page
 * where it is fixed. The button is the reason the finding is actionable: if it
 * does not navigate, the administrator reads what is broken and has to guess
 * where to repair it.
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_CONFIGURATION_ISSUES } from '@/graphql/queries'
import { ConfigurationIssuesPanel } from './ConfigurationIssuesPanel'

const issue = (kind: string, where: string | null, params: { name: string; value: string }[], severity = 'warning') => ({ kind, severity, params, gaps: [], where })

describe('ConfigurationIssuesPanel — going to fix a finding', () => {
  it('«Go and fix it» opens the page named by that finding, not by another one', async () => {
    const { user } = renderWithProviders(<ConfigurationIssuesPanel />, {
      route: '/settings/diagnostics',
      mocks: [meMock('admin'), {
        request: { query: GET_CONFIGURATION_ISSUES },
        result: { data: { configurationIssues: [
          issue('matrix_stale_keys', '/settings/domain-matrices', [{ name: 'matrix', value: 'priority' }, { name: 'count', value: '1' }]),
          issue('teams_without_sourcing', '/teams', [{ name: 'count', value: '1' }, { name: 'teams', value: 'Network' }, { name: 'others', value: '0' }]),
        ] } },
      }],
    })
    const finding = (await screen.findByText(/Matrix «priority»/)).closest('li')!
    await user.click(within(finding).getByRole('button', { name: 'Go and fix it' }))
    await attendiURL('/settings/domain-matrices')
  })
})

describe('ConfigurationIssuesPanel — how serious a finding is', () => {
  it('an error is marked in red and a warning in amber, so the one that breaks things is read first', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), {
        request: { query: GET_CONFIGURATION_ISSUES },
        result: { data: { configurationIssues: [
          issue('provisioning_gap', '/workflow', [{ name: 'count', value: '1' }], 'error'),
          issue('matrix_stale_keys', null, [{ name: 'matrix', value: 'priority' }, { name: 'count', value: '1' }]),
        ] } },
      }],
    })
    const warning = (await screen.findByText(/Matrix «priority»/)).closest('li')!
    const error = screen.getAllByRole('listitem').find((li) => li !== warning)!
    expect(error).toHaveStyle({ background: 'var(--color-danger-bg)' })
    expect(error.querySelector('svg')).toHaveStyle({ color: 'var(--color-danger-text)' })
    expect(warning).toHaveStyle({ background: 'var(--color-warning-bg)' })
    expect(warning.querySelector('svg')).toHaveStyle({ color: 'var(--color-warning-text)' })
  })
})
