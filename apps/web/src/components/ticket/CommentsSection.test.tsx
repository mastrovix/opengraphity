/**
 * CommentsSection — revisione del 14 set 2026 · F1.
 *
 * I commenti del dettaglio sono gli stessi che l'utente finale vede dal
 * portale: ognuno dice se è una nota interna o una risposta pubblica, e chi
 * scrive sceglie. La scelta di partenza è la nota interna.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { CommentsSection, type TicketComment } from './CommentsSection'
import { renderWithProviders } from '@/test/utils'
import i18n from '@/i18n/i18n'

const T = (k: string) => i18n.t(k) as string
const comment = (over: Partial<TicketComment>): TicketComment =>
  ({ id: 'c1', text: 'testo', createdAt: new Date().toISOString(), author: { id: 'u1', name: 'Anna Neri' }, isInternal: true, ...over })

describe('CommentsSection', () => {
  it('ogni commento dice se è una nota interna o una risposta pubblica', () => {
    renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={vi.fn()} comments={[
      comment({ id: 'a', isInternal: true }),
      comment({ id: 'b', isInternal: false }),
    ]} />)
    const badges = screen.getAllByTestId('comment-visibility').map((b) => b.textContent)
    expect(badges.sort()).toEqual([T('detail.commentInternal'), T('detail.commentPublic')].sort())
  })

  it('senza scelta invia una nota interna; scegliendo la risposta pubblica passa isInternal false', async () => {
    const onAdd = vi.fn()
    const { user } = renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={onAdd} comments={[]} />)
    const box = screen.getByPlaceholderText(T('detail.commentPlaceholder'))

    await user.type(box, 'nota')
    await user.click(screen.getByRole('button', { name: T('detail.sendInternalNote') }))
    expect(onAdd).toHaveBeenLastCalledWith('nota', true)

    const group = screen.getByRole('group', { name: T('detail.commentVisibility') })
    await user.click(within(group).getByLabelText(T('detail.commentAsPublic')))
    await user.type(box, 'risposta')
    await user.click(screen.getByRole('button', { name: T('detail.sendPublicReply') }))
    expect(onAdd).toHaveBeenLastCalledWith('risposta', false)
  })
})
