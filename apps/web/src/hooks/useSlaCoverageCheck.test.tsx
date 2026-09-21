/**
 * Prima di creare un ticket: se nessuna policy SLA lo copre, chi lo crea lo sa
 * e decide. Da quando non esistono policy di fabbrica, senza questo avviso il
 * ticket nasceva senza SLA in silenzio.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { GET_SLA_COVERAGE } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { useSlaCoverageCheck, type SlaCoverageDecision, type SlaCoverageInput } from './useSlaCoverageCheck'

const INPUT: SlaCoverageInput = {
  entityType: 'incident', priority: 'medium', priorityLabel: 'Medium',
  category: 'hardware', categoryLabel: 'Hardware', teamId: null, teamName: null,
}
const VARS = { entityType: 'incident', priority: 'medium', category: 'hardware', teamId: null }

function coverage(result: { policyId: string; policyName: string } | null): GqlMock {
  return { request: { query: GET_SLA_COVERAGE, variables: VARS }, result: { data: { slaCoverage: result && { __typename: 'SLACoverage', ...result } } } }
}

function Harness({ input = INPUT, onResult, onError }: { input?: SlaCoverageInput; onResult: (d: SlaCoverageDecision) => void; onError: (e: unknown) => void }) {
  const check = useSlaCoverageCheck()
  return <button type="button" onClick={() => void check(input).then(onResult, onError)}>create</button>
}

function setup(mock: GqlMock) {
  const onResult = vi.fn()
  const onError = vi.fn()
  const r = renderWithProviders(<Harness onResult={onResult} onError={onError} />, { mocks: [mock] })
  return { ...r, onResult, onError }
}

describe('useSlaCoverageCheck', () => {
  it('una policy copre il ticket → «covered», nessun avviso', async () => {
    const { user, onResult } = setup(coverage({ policyId: 'p1', policyName: 'Hardware' }))
    await user.click(screen.getByText('create'))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('covered'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('nessuna policy → avviso con priorità e categoria; «Create without SLA» → «accepted»', async () => {
    const { user, onResult } = setup(coverage(null))
    await user.click(screen.getByText('create'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('No SLA policy covers this incident')
    expect(dialog).toHaveTextContent('priority «Medium» and category «Hardware»')
    await user.click(screen.getByRole('button', { name: 'Create without SLA' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('accepted'))
  })

  it('nessuna policy e «Go back» → «cancelled»: il ticket non si crea', async () => {
    const { user, onResult } = setup(coverage(null))
    await user.click(screen.getByText('create'))
    await user.click(await screen.findByRole('button', { name: 'Go back' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('cancelled'))
  })

  it('la verifica fallisce → errore, mai «covered» per ripiego', async () => {
    const { user, onResult, onError } = setup({ request: { query: GET_SLA_COVERAGE, variables: VARS }, error: new Error('rete giù') })
    await user.click(screen.getByText('create'))
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(onResult).not.toHaveBeenCalled()
  })
})

describe('useSlaCoverageCheck — problem e service request', () => {
  it('problem con team: il testo dice «problem», priorità e team (i problem non hanno categoria)', async () => {
    const input: SlaCoverageInput = { entityType: 'problem', priority: 'high', priorityLabel: 'High', category: null, categoryLabel: null, teamId: 'tm1', teamName: 'Rete' }
    const mock: GqlMock = { request: { query: GET_SLA_COVERAGE, variables: { entityType: 'problem', priority: 'high', category: null, teamId: 'tm1' } }, result: { data: { slaCoverage: null } } }
    const onResult = vi.fn()
    const { user } = renderWithProviders(<Harness input={input} onResult={onResult} onError={vi.fn()} />, { mocks: [mock] })
    await user.click(screen.getByText('create'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('No SLA policy covers this problem')
    expect(dialog).toHaveTextContent('a problem with priority «High» and team «Rete»')
    await user.click(screen.getByRole('button', { name: 'Create without SLA' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('accepted'))
  })

  it('service request: il testo dice «service request» e la priorità', async () => {
    const input: SlaCoverageInput = { entityType: 'service_request', priority: 'low', priorityLabel: 'Low', category: null, categoryLabel: null, teamId: null, teamName: null }
    const mock: GqlMock = { request: { query: GET_SLA_COVERAGE, variables: { entityType: 'service_request', priority: 'low', category: null, teamId: null } }, result: { data: { slaCoverage: null } } }
    const onResult = vi.fn()
    const { user } = renderWithProviders(<Harness input={input} onResult={onResult} onError={vi.fn()} />, { mocks: [mock] })
    await user.click(screen.getByText('create'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('No SLA policy covers this service request')
    expect(dialog).toHaveTextContent('a service request with priority «Low»')
    await user.click(screen.getByRole('button', { name: 'Go back' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('cancelled'))
  })
})
