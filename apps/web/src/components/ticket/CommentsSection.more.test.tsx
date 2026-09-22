/**
 * CommentsSection: deleting, abandoning an edit, and choosing who sees a new
 * comment.
 *
 * Why it matters: a delete must ask first and then leave a trace (the page
 * reloads the comments); "Cancel" on an edit must throw the edit away, not
 * save it; and the visibility of a new comment is the line between a staff
 * note and a reply the end user reads on the portal — after sending a public
 * reply the choice must fall back to "internal", so the next note does not
 * leak by distraction.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { CommentsSection, type TicketComment } from './CommentsSection'
import { renderWithProviders } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { DELETE_COMMENT } from '@/graphql/mutations'
import i18n from '@/i18n/i18n'

const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string
const comment = (over: Partial<TicketComment>): TicketComment =>
  ({ id: 'c1', text: 'original text', createdAt: new Date().toISOString(), author: { id: 'u-1', name: 'Test User' }, isInternal: true, ...over })

describe('CommentsSection — delete', () => {
  it('asks for confirmation, deletes, and lets the page reload', async () => {
    const onChanged = vi.fn()
    const mocks = [meMock('operator'), {
      request: { query: DELETE_COMMENT, variables: { id: 'c1' } },
      result: { data: { deleteComment: true } },
    }]
    const { user } = renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={vi.fn()} onChanged={onChanged} comments={[comment({})]} />, { mocks })
    await user.click(await screen.findByRole('button', { name: T('detail.deleteComment') }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: T('common.confirm') }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('declining the confirmation deletes nothing', async () => {
    const onChanged = vi.fn()
    // No DELETE_COMMENT mock: a request would surface as an unmatched-mock error.
    const { user } = renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={vi.fn()} onChanged={onChanged} comments={[comment({})]} />, { mocks: [meMock('operator')] })
    await user.click(await screen.findByRole('button', { name: T('detail.deleteComment') }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: T('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('CommentsSection — cancelling an edit', () => {
  it('Cancel restores the original text and the edit/delete actions', async () => {
    const { user } = renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={vi.fn()} comments={[comment({})]} />, { mocks: [meMock('operator')] })
    await user.click(await screen.findByRole('button', { name: T('detail.editComment') }))
    const boxes = screen.getAllByPlaceholderText(T('detail.commentPlaceholder'))
    await user.type(boxes[0]!, ' changed')
    await user.click(screen.getByRole('button', { name: T('common.cancel') }))
    expect(screen.getByText('original text')).toBeInTheDocument()
    expect(screen.queryByText(/changed/)).toBeNull()
    expect(screen.getByRole('button', { name: T('detail.editComment') })).toBeInTheDocument()
  })
})

describe('CommentsSection — visibility of a new comment', () => {
  it('a public reply is sent as public, then the choice falls back to internal', async () => {
    const onAdd = vi.fn(async () => undefined)
    const { user } = renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={onAdd} comments={[]} />, { mocks: [meMock('operator')] })
    const internal = screen.getByRole('radio', { name: T('detail.commentAsInternal') })
    const pub = screen.getByRole('radio', { name: T('detail.commentAsPublic') })
    expect(internal).toBeChecked()
    await user.click(pub)
    expect(pub).toBeChecked()
    // Switching back and forth works both ways.
    await user.click(internal)
    expect(internal).toBeChecked()
    await user.click(pub)
    await user.type(screen.getByPlaceholderText(T('detail.commentPlaceholder')), '  we are on it  ')
    await user.click(screen.getByRole('button', { name: T('detail.sendPublicReply') }))
    // The text is trimmed and the visibility is the one chosen.
    expect(onAdd).toHaveBeenCalledWith('we are on it', false)
    await waitFor(() => expect(internal).toBeChecked())
    expect(screen.getByPlaceholderText(T('detail.commentPlaceholder'))).toHaveValue('')
  })
})

describe('CommentsSection — who wrote it', () => {
  it('a comment not written by a person names its origin, never an empty "Automation:"', async () => {
    renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={vi.fn()} comments={[
      comment({ id: 'm', author: null, authorKind: 'monitoring' }),
      comment({ id: 'a', author: null, authorKind: 'automation', authorLabel: 'Escalate P1' }),
      comment({ id: 'u', author: null, authorKind: 'automation', authorLabel: null }),
      comment({ id: 'x', author: null, authorKind: null }),
    ]} />, { mocks: [meMock('operator')] })
    expect(await screen.findByText(T('detail.commentByMonitoring'))).toBeInTheDocument()
    expect(screen.getByText(T('detail.commentByAutomation', { name: 'Escalate P1' }))).toBeInTheDocument()
    expect(screen.getByText(T('detail.commentByAutomationUnnamed'))).toBeInTheDocument()
    expect(screen.getByText(T('detail.unknownUser'))).toBeInTheDocument()
    // Non-persons get the bot icon; an unknown author with no kind gets "?".
    expect(screen.getAllByTestId('comment-bot-avatar')).toHaveLength(3)
    expect(screen.getByText('?')).toBeInTheDocument()
  })

  it('an edit or deletion whose author is unknown says "unknown user" instead of a blank', async () => {
    renderWithProviders(<CommentsSection defaultOpen adding={false} onAdd={vi.fn()} comments={[
      comment({ id: 'd', deletedAt: '2026-09-15T10:00:00Z', deletedByName: null }),
      comment({ id: 'e', editedAt: '2026-09-15T11:00:00Z', editedByName: null }),
    ]} />, { mocks: [meMock('operator')] })
    expect(await screen.findByTestId('comment-deleted')).toHaveTextContent(T('detail.unknownUser'))
    expect(screen.getByTestId('comment-edited')).toHaveTextContent(T('detail.unknownUser'))
  })

  it('while the parent is sending, the button says so and stays disabled', () => {
    renderWithProviders(<CommentsSection defaultOpen adding onAdd={vi.fn()} comments={[]} />, { mocks: [meMock('operator')] })
    expect(screen.getByRole('button', { name: T('detail.sending') })).toBeDisabled()
  })
})
