/**
 * REPORT BUILDER against the REAL Apollo client.
 *
 * `CustomReportsPage.test.tsx` uses the fake Apollo of `@/test/apolloFinto`,
 * which hands the page an answer exactly as the test writes it. Running a
 * report depends on what the real client does with an answer, so it is
 * pinned here with `MockedProvider`: a run fills the sections with their
 * results — and a second run of the same report must fill them again. Apollo
 * hands back the SAME object for an identical answer, and the page only fills
 * the sections when that object changes.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { gql } from '@apollo/client'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { EXECUTE_REPORT, GET_REPORT_TEMPLATES } from '@/graphql/queries'
import { CustomReportsPage } from './CustomReportsPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ReportChartRenderer', () => ({
  ReportChartRenderer: ({ title, data }: { title: string; data: string }) => <figure aria-label={title}>{data}</figure>,
}))

// The page's own document for teams (not exported): the same text.
const GET_TEAMS_SLIM = gql`query GetTeamsSlim { teams { id name } }`

const REPORT = {
  __typename: 'ReportTemplate', id: 'r1', name: 'Weekly incidents', description: null, icon: null, visibility: 'private',
  scheduleEnabled: false, scheduleCron: null, scheduleChannelId: null, scheduleRecipients: [], scheduleFormat: null, lastScheduledRun: null,
  createdAt: '2026-09-01T08:00:00Z', createdBy: null, sharedWith: [],
  sections: [{
    __typename: 'ReportSection', id: 's1', order: 1, title: 'Incidents by priority', chartType: 'bar',
    groupByNodeId: null, groupByField: null, groupByGranularity: null, metric: 'count', metricField: null,
    limit: null, sortDir: null, nodes: [], edges: [],
  }],
}

function mocks() {
  const runs = { count: 0 }
  const list: GqlMock[] = [
    { request: { query: GET_REPORT_TEMPLATES }, result: { data: { reportTemplates: [REPORT] } }, maxUsageCount: Number.POSITIVE_INFINITY },
    { request: { query: GET_TEAMS_SLIM }, result: { data: { teams: [] } }, maxUsageCount: Number.POSITIVE_INFINITY },
    {
      request: { query: EXECUTE_REPORT, variables: { templateId: 'r1', language: 'en' } },
      // The same data at every run: nothing changed in the graph between the two.
      result: () => {
        runs.count++
        return { data: { executeReport: { __typename: 'ReportResult', sections: [
          { __typename: 'SectionResult', sectionId: 's1', title: 'Incidents by priority', chartType: 'bar', data: '[{"label":"high","value":4}]', total: 4, error: null, errorKey: null },
        ] } } }
      },
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
  ]
  return { list, runs }
}

/** Runs the report from its card in the list, and waits for the answer to be in. */
async function openAndRun() {
  const { list, runs } = mocks()
  const view = renderWithProviders(<CustomReportsPage />, { mocks: list })
  let card: HTMLElement | null = await screen.findByText('Weekly incidents')
  while (card && !within(card).queryByRole('button', { name: '▶ Run' })) card = card.parentElement
  await view.user.click(within(card!).getByRole('button', { name: '▶ Run' }))
  await waitFor(() => expect(runs.count).toBe(1))
  await waitFor(() => expect(screen.getByRole('button', { name: '▶ Run' })).toBeEnabled())
  return { ...view, runs }
}

describe('Report Builder — running a report, with the real Apollo client', () => {
  it('a run fills the sections with their results', async () => {
    await openAndRun()
    expect(await screen.findByRole('figure', { name: 'Incidents by priority' })).toHaveTextContent('[{"label":"high","value":4}]')
    expect(screen.queryByText('Click "▶ Run" to load the data')).toBeNull()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the results were filled
  // only when the query's data object changed, and Apollo returns the same
  // object for an identical answer: a second run left every section on
  // «Click ▶ Run to load the data».
  it('a second run of the same report fills the sections again', async () => {
    const { user, runs } = await openAndRun()
    await screen.findByRole('figure', { name: 'Incidents by priority' })
    await user.click(screen.getByRole('button', { name: '▶ Run' }))
    await waitFor(() => expect(runs.count).toBe(2))
    await waitFor(() => expect(screen.getByRole('button', { name: '▶ Run' })).toBeEnabled())
    expect(screen.getByRole('figure', { name: 'Incidents by priority' })).toBeInTheDocument()
  })
})
