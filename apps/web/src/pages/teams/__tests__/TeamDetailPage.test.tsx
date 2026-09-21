/**
 * Giro nel browser del 14 set 2026 (#48): dal dettaglio del team non si
 * aggiungevano membri, e la pagina mostrava «TENANT ID», un dato interno.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { GET_TEAM, GET_USERS } from '@/graphql/queries'
import { SET_TEAM_MEMBER } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { TeamDetailPage } from '../TeamDetailPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({ useDomainVocabularies: () => ({ entriesOf: () => [], labelOf: (_v: string, value: string) => value }) }))

const u = (id: string, name: string) => ({ __typename: 'User', id, name, email: `${id}@x`, role: 'operator' })
const team = {
  __typename: 'Team', id: 'team-1', name: 'Rete', description: null, type: null, sourcing: 'internal', createdAt: '2026-09-01T00:00:00Z',
  isChangeManager: false, manager: null, members: [u('u-1', 'Anna Membro')], ownedCIs: [], supportedCIs: [],
}

describe('TeamDetailPage — membri', () => {
  it('non mostra il tenant; aggiunge un utente che non è già membro', async () => {
    const seen: unknown[] = []
    const mocks: GqlMock[] = [
      { request: { query: GET_TEAM, variables: { id: 'team-1' } }, result: { data: { team } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: GET_USERS }, result: { data: { users: [{ ...u('u-1', 'Anna Membro'), createdAt: 'x', teams: [] }, { ...u('u-2', 'Bruno Nuovo'), createdAt: 'x', teams: [] }] } } },
      { request: { query: SET_TEAM_MEMBER, variables: (v) => { seen.push(v); return true } }, result: { data: { setTeamMember: { __typename: 'Team', id: 'team-1' } } } },
    ]
    const { user } = renderWithProviders(<TeamDetailPage />, { mocks, route: '/teams/team-1', path: '/teams/:id' })
    await user.click(await screen.findByRole('button', { name: '+ Add member' }))
    expect(screen.queryByText(/tenant id/i)).toBeNull()
    await user.click(await screen.findByRole('button', { name: /Bruno Nuovo/ }))
    expect(screen.queryByRole('button', { name: /^Anna Membro/ })).toBeNull()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ teamId: 'team-1', userId: 'u-2', member: true })
  })

  it('toglie un membro dalla riga', async () => {
    const seen: unknown[] = []
    const mocks: GqlMock[] = [
      { request: { query: GET_TEAM, variables: { id: 'team-1' } }, result: { data: { team } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: SET_TEAM_MEMBER, variables: (v) => { seen.push(v); return true } }, result: { data: { setTeamMember: { __typename: 'Team', id: 'team-1' } } } },
    ]
    const { user } = renderWithProviders(<TeamDetailPage />, { mocks, route: '/teams/team-1', path: '/teams/:id' })
    await user.click(await screen.findByRole('button', { name: 'Remove Anna Membro from the team' }))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ teamId: 'team-1', userId: 'u-1', member: false })
  })
})
