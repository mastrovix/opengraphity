/**
 * COMMENTS ON CHANGES AND REQUESTS (F13): who wrote them, and what happens
 * after a change to the list.
 *
 * The generic comments API returns the author as an id. Monitoring and the
 * automations write comments too, and those must read as «Monitoring» or
 * «Automation: <rule>», never as a person called «monitoring». A person with no
 * display name is shown by e-mail rather than as a blank. After a deletion the
 * section reads the comments again, so the list shows who deleted what; a
 * failed «add» says why instead of losing the text in silence.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_ENTITY_COMMENTS } from '@/graphql/queries'
import { ADD_ENTITY_COMMENT, DELETE_COMMENT } from '@/graphql/mutations'
import { EntityCommentsSection } from './EntityCommentsSection'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const VARS = { entityType: 'service_request', entityId: 'req-1' }
const row = (over: Record<string, unknown>) => ({
  __typename: 'EntityComment', id: 'c1', body: 'text', isInternal: true, authorId: 'u-9', authorName: 'Someone', authorEmail: 'someone@acme.com',
  createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', editedAt: null, editedByName: null, deletedAt: null, deletedByName: null, ...over,
})
const list = (comments: unknown[]): GqlMock => ({ request: { query: GET_ENTITY_COMMENTS, variables: VARS }, result: { data: { comments } } })

async function openComments(mocks: GqlMock[]) {
  const view = renderWithProviders(<EntityCommentsSection entityType="service_request" entityId="req-1" />, { mocks: [meMock('operator', { maxUsageCount: Number.POSITIVE_INFINITY }), ...mocks] })
  await view.user.click(await screen.findByRole('button', { name: /Comments/ }))
  return view
}

describe('EntityCommentsSection — who wrote it', () => {
  it('monitoring and automations are named as such; a person without a name is shown by e-mail', async () => {
    await openComments([list([
      row({ id: 'm', body: 'CPU back to normal', authorId: 'monitoring', authorName: 'monitoring' }),
      row({ id: 'a', body: 'Routed to the desk', authorId: 'automation', authorName: 'Route hardware' }),
      row({ id: 's', body: 'Closed after 5 days', authorId: 'system', authorName: 'Auto-close' }),
      row({ id: 'p', body: 'I will call the user', authorId: 'u-7', authorName: '', authorEmail: 'anna@acme.com' }),
    ])])
    expect(await screen.findByText('CPU back to normal')).toBeInTheDocument()
    expect(screen.getByText('Monitoring')).toBeInTheDocument()
    expect(screen.getByText('Automation: Route hardware')).toBeInTheDocument()
    expect(screen.getByText('Automation: Auto-close')).toBeInTheDocument()
    expect(screen.getByText('anna@acme.com')).toBeInTheDocument()
    // The raw actor ids never pass for a person.
    expect(screen.queryByText('monitoring')).toBeNull()
    // Only the three that are not written by a person have the robot avatar.
    expect(screen.getAllByTestId('comment-bot-avatar')).toHaveLength(3)
  })
})

describe('EntityCommentsSection — after a change', () => {
  it('an added comment is confirmed, and shows once the comments are read again', async () => {
    const { user } = await openComments([
      list([]),
      { request: { query: ADD_ENTITY_COMMENT, variables: { ...VARS, body: 'Parts ordered', isInternal: true } },
        result: { data: { addComment: row({ id: 'c9', body: 'Parts ordered', authorId: 'u-1', authorName: 'Test User' }) } } },
      list([row({ id: 'c9', body: 'Parts ordered', authorId: 'u-1', authorName: 'Test User' })]),
    ])
    await user.type(await screen.findByPlaceholderText(PLACEHOLDER), 'Parts ordered')
    await user.click(screen.getByRole('button', { name: 'Add note' }))
    expect(await screen.findByText('Parts ordered')).toBeInTheDocument()
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Comment added')
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('')
  })

  it('after a deletion the comments are read again, and the list says who deleted it', async () => {
    const { user } = await openComments([
      list([row({ id: 'c1', body: 'Wrong ticket, sorry', authorId: 'u-1', authorName: 'Test User' })]),
      { request: { query: DELETE_COMMENT, variables: { id: 'c1' } }, result: { data: { deleteComment: true } } },
      list([row({ id: 'c1', body: 'Wrong ticket, sorry', authorId: 'u-1', authorName: 'Test User', deletedAt: '2026-09-02T10:00:00Z', deletedByName: 'Test User' })]),
    ])
    await user.click(await screen.findByRole('button', { name: 'Delete comment' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByTestId('comment-deleted')).toHaveTextContent('Comment deleted by Test User')
    expect(screen.queryByText('Wrong ticket, sorry')).toBeNull()
  })

  it('a refused comment says why, and the text stays in the box to be sent again', async () => {
    await refuseAComment()
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('the request is closed'))
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('Any news?')
  })

  /**
   * Found by this test (tour of 23 Sep 2026), fixed: `submit` awaited `onAdd`
   * without a catch, and Apollo 4 rejects a refused mutation even after its
   * `onError` has said why — every refused comment, here and on incidents and
   * problems, ended in an «Uncaught (in promise)» on top of the toast.
   */
  it('a refused comment leaves no unhandled promise rejection behind', async () => {
    await collectingUnhandledRejections(async (seen) => {
      await refuseAComment()
      await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('the request is closed'))
      // Node reports an unhandled rejection at the end of the turn it happened in: one more turn is enough.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(seen).toEqual([])
    })
  })
})

const PLACEHOLDER = 'Write a comment... Use @ to mention'

async function refuseAComment() {
  const view = await openComments([
    list([]),
    { request: { query: ADD_ENTITY_COMMENT, variables: { ...VARS, body: 'Any news?', isInternal: true } }, error: new Error('the request is closed') },
  ])
  await view.user.type(await screen.findByPlaceholderText(PLACEHOLDER), 'Any news?')
  await view.user.click(screen.getByRole('button', { name: 'Add note' }))
  return view
}

/** Runs `body` while collecting the promise rejections nobody handled (Vitest leaves them to a listener of the test). */
async function collectingUnhandledRejections(body: (seen: unknown[]) => Promise<void>): Promise<void> {
  const seen: unknown[] = []
  const listener = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    await body(seen)
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    process.off('unhandledRejection', listener)
  }
}
