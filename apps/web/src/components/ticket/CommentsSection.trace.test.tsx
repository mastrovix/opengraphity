/**
 * Verifica «Cosa resta cablato», ondata 6: l'autore modifica o cancella il
 * proprio commento, l'admin qualunque, e ciò che è successo resta visibile.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { CommentsSection, canChangeComment, type TicketComment } from './CommentsSection'
import { renderWithProviders } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { UPDATE_COMMENT } from '@/graphql/mutations'
import i18n from '@/i18n/i18n'

const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string
const comment = (over: Partial<TicketComment>): TicketComment =>
  ({ id: 'c1', text: 'testo', createdAt: new Date().toISOString(), author: { id: 'u-1', name: 'Test User' }, isInternal: true, ...over })

describe('chi può toccare un commento', () => {
  it('l\'autore il proprio, l\'admin qualunque, nessuno uno cancellato', () => {
    const me = { id: 'u-1' }
    expect(canChangeComment(comment({}), me, false)).toBe(true)
    expect(canChangeComment(comment({ author: { id: 'u-2', name: 'Altro' } }), me, false)).toBe(false)
    expect(canChangeComment(comment({ author: null, authorKind: 'automation' }), me, true)).toBe(true)
    expect(canChangeComment(comment({ deletedAt: '2026-09-15T10:00:00Z' }), me, true)).toBe(false)
  })
})

describe('CommentsSection — modifica e cancellazione', () => {
  it('un commento cancellato mostra chi e quando, senza testo né azioni; uno modificato lo dice', async () => {
    renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={vi.fn()} comments={[
      comment({ id: 'a', text: '', deletedAt: '2026-09-15T10:00:00Z', deletedByName: 'Anna' }),
      comment({ id: 'b', text: 'corretto', editedAt: '2026-09-15T11:00:00Z', editedByName: 'Anna' }),
    ]} />, { mocks: [meMock('operator')] })
    expect(await screen.findByTestId('comment-deleted')).toHaveTextContent(/Anna/)
    expect(screen.getByTestId('comment-edited')).toHaveTextContent(/Anna/)
    await waitFor(() => expect(screen.getAllByRole('button', { name: T('detail.editComment') })).toHaveLength(1))
  })

  it('l\'autore modifica il suo commento: il testo nuovo va all\'API e la pagina ricarica', async () => {
    const onChanged = vi.fn()
    const mocks = [meMock('operator'), {
      request: { query: UPDATE_COMMENT, variables: { id: 'c1', body: 'testo corretto' } },
      result: { data: { updateComment: { __typename: 'EntityComment', id: 'c1', body: 'testo corretto', editedAt: 'T', editedByName: 'Test User' } } },
    }]
    const { user } = renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={vi.fn()} onChanged={onChanged} comments={[comment({})]} />, { mocks })
    await user.click(await screen.findByRole('button', { name: T('detail.editComment') }))
    const boxes = screen.getAllByPlaceholderText(T('detail.commentPlaceholder'))
    await user.clear(boxes[0]!)
    await user.type(boxes[0]!, 'testo corretto')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
