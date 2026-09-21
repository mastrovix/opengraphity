/**
 * F12 (revisione del 14 set 2026): il dettaglio del CI mostrava incident e
 * change, ma non i problem che hanno quel CI fra gli impattati.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { CIIncidentsCard } from './CIIncidentsCard'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { GET_CI_PROBLEMS } from '@/graphql/queries'
import { workflowDefinitionMock } from '@/test/mocks/gql'

const problemsMock: GqlMock = {
  request: { query: GET_CI_PROBLEMS, variables: { ciId: 'ci-1' } },
  result: { data: { ciProblems: [{ __typename: 'Problem', id: 'p-1', number: 'PRB00000007', title: 'Memory leak', priority: 'high', status: 'new', createdAt: 'a', updatedAt: 'a' }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

describe('CIIncidentsCard kind=problem', () => {
  it('elenca i problem del CI con il loro numero', async () => {
    const { user } = renderWithProviders(<CIIncidentsCard ciId="ci-1" kind="problem" />, { mocks: [problemsMock, workflowDefinitionMock('problem')] })
    expect(await screen.findByText('1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Problem/ }))
    expect(await screen.findByText('PRB00000007')).toBeInTheDocument()
  })
})
