/**
 * THE SLA COVERAGE CHECK WHEN IT CANNOT BE MADE.
 *
 * Before a ticket is created, the page asks whether an SLA policy covers it.
 * If the answer does not come (no data), the check FAILS: the creation stops
 * with an error, because creating the ticket anyway would be creating it
 * blind — exactly what the check exists to prevent. The question is always
 * asked fresh, never from the cache: policies change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { useSlaCoverageCheck, type SlaCoverageDecision, type SlaCoverageInput } from './useSlaCoverageCheck'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const INPUT: SlaCoverageInput = {
  entityType: 'problem', priority: 'high', priorityLabel: 'High',
  category: null, categoryLabel: null, teamId: 'team-1', teamName: 'DBA',
}

function Harness({ onResult, onError }: { onResult: (d: SlaCoverageDecision) => void; onError: (e: unknown) => void }) {
  const check = useSlaCoverageCheck()
  return <button type="button" onClick={() => void check(INPUT).then(onResult, onError)}>create</button>
}

beforeEach(() => { apolloFinto.reset() })

describe('useSlaCoverageCheck when the answer does not come', () => {
  it('fails, so the ticket is not created blind; the question was asked fresh', async () => {
    apolloFinto.query.mockResolvedValue({ data: undefined })
    const onResult = vi.fn()
    const onError = vi.fn()
    const { user } = renderWithProviders(<Harness onResult={onResult} onError={onError} />)
    await user.click(screen.getByRole('button', { name: 'create' }))
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect((onError.mock.calls[0]![0] as Error).message).toBe('slaCoverage: no data')
    expect(onResult).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.query).toHaveBeenCalledWith(expect.objectContaining({
      variables: { entityType: 'problem', priority: 'high', category: null, teamId: 'team-1' },
      fetchPolicy: 'network-only',
    }))
  })
})
