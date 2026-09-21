/** F13 (revisione del 14 set 2026): commenti su change e richieste, con il modello unico. */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { EntityCommentsSection } from './EntityCommentsSection'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { GET_ENTITY_COMMENTS } from '@/graphql/queries'
import { ADD_ENTITY_COMMENT } from '@/graphql/mutations'
import i18n from '@/i18n/i18n'

const T = (k: string) => i18n.t(k) as string
const row = { __typename: 'EntityComment', id: 'c1', body: 'Rollback pronto', isInternal: true, authorId: 'u1', authorName: 'Anna Neri', authorEmail: 'a@x', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
let added = false
const mocks: GqlMock[] = [
  { request: { query: GET_ENTITY_COMMENTS, variables: { entityType: 'change', entityId: 'chg-1' } }, result: { data: { comments: [row] } }, maxUsageCount: Number.POSITIVE_INFINITY },
  {
    request: { query: ADD_ENTITY_COMMENT, variables: { entityType: 'change', entityId: 'chg-1', body: 'Finestra confermata', isInternal: true } },
    result: () => { added = true; return { data: { addComment: { ...row, id: 'c2', body: 'Finestra confermata' } } } },
  },
]

describe('EntityCommentsSection', () => {
  it('mostra i commenti della change e ne aggiunge uno con il tipo di ticket', async () => {
    const { user } = renderWithProviders(<EntityCommentsSection entityType="change" entityId="chg-1" />, { mocks })
    await user.click(await screen.findByRole('button', { name: new RegExp(T('detail.sections.comments')) }))
    expect(await screen.findByText('Rollback pronto')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText(T('detail.commentPlaceholder')), 'Finestra confermata')
    await user.click(screen.getByRole('button', { name: T('detail.sendInternalNote') }))
    await expect.poll(() => added).toBe(true)
  })
})
