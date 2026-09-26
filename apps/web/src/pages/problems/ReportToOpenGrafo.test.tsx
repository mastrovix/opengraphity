/**
 * «SEGNALA A OPENGRAFO» (26 Sep 2026).
 *
 * What a user loses if this regresses: a button where nothing can be sent;
 * a report sent without seeing what leaves; an empty note sent; no trace
 * that the Problem was reported.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { GET_OPENGRAFO_REPORT_DRAFT } from '@/graphql/queries/problem'
import { REPORT_PROBLEM_TO_OPENGRAFO } from '@/graphql/mutations/problem'
import { ReportToOpenGrafo } from './ReportToOpenGrafo'

const draftMock: GqlMock = {
  request: { query: GET_OPENGRAFO_REPORT_DRAFT, variables: { problemId: 'p1' } },
  result: { data: { openGrafoReportDraft: [
    { __typename: 'ProposalParam', name: 'tenant', value: 'acme' },
    { __typename: 'ProposalParam', name: 'queue', value: 'sla-jobs' },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
const sendMock = (note: string): GqlMock => ({
  request: { query: REPORT_PROBLEM_TO_OPENGRAFO, variables: { problemId: 'p1', note } },
  result: { data: { reportProblemToOpenGrafo: { __typename: 'OpenGrafoReportState', canReport: false, reportedAt: '2026-09-26T12:00:00Z' } } },
})

describe('ReportToOpenGrafo', () => {
  it('nothing when the Problem cannot be reported', () => {
    renderWithProviders(<ReportToOpenGrafo problemId="p1" state={{ canReport: false, reportedAt: null }} onSent={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Report to OpenGrafo' })).toBeNull()
    expect(screen.queryByText(/Reported to OpenGrafo/)).toBeNull()
  })

  it('once reported, the date instead of the button', () => {
    renderWithProviders(<ReportToOpenGrafo problemId="p1" state={{ canReport: false, reportedAt: '2026-09-26T12:00:00Z' }} onSent={vi.fn()} />)
    expect(screen.getByText(/Reported to OpenGrafo on/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Report to OpenGrafo' })).toBeNull()
  })

  it('the dialog shows what leaves, asks for a note, and sends it trimmed', async () => {
    const onSent = vi.fn()
    const { user } = renderWithProviders(
      <ReportToOpenGrafo problemId="p1" state={{ canReport: true, reportedAt: null }} onSent={onSent} />,
      { mocks: [draftMock, sendMock('Retries keep failing')] },
    )
    await user.click(screen.getByRole('button', { name: 'Report to OpenGrafo' }))
    expect(await screen.findByText('sla-jobs')).toBeInTheDocument()
    const send = screen.getByRole('button', { name: 'Send to OpenGrafo' })
    expect(send).toBeDisabled()
    await user.type(screen.getByRole('textbox'), '  Retries keep failing  ')
    expect(send).toBeEnabled()
    await user.click(send)
    await vi.waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
  })
})
