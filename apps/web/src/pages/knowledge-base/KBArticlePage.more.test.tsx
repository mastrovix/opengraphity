/**
 * The article page beyond reading: the «Was this helpful?» vote and the
 * retry after a failed load. What a reader loses if these regress:
 *  - the vote must reach the API with the right article and direction (the
 *    helpful counters rank articles in the portal search);
 *  - a vote that FAILED must say so and must not also thank the reader (a
 *    "thank you" on a lost vote is a lie the reader cannot detect), nor leave
 *    an unhandled promise rejection behind;
 *  - after a network error the Retry button must actually read the article
 *    again, or the page is a dead end until a full reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { gql } from '@apollo/client'
import { toast } from 'sonner'
import { KBArticlePage } from './KBArticlePage'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

// Private documents of KBArticlePage.tsx / AttachmentsSection.tsx, replicated for the MockLink.
const GET_ARTICLE = gql`
  query KBArticleBySlug($slug: String!) {
    kbArticleBySlug(slug: $slug) {
      id title slug body category tags status
      authorId authorName views helpfulCount notHelpfulCount
      createdAt updatedAt publishedAt
    }
  }
`
const GET_RELATED = gql`
  query KBRelated($category: String!) {
    kbArticles(category: $category, status: "published", pageSize: 5) {
      items { id title slug category views }
    }
  }
`
const GET_ATTACHMENTS = gql`
  query GetAttachments($entityType: String!, $entityId: String!) {
    attachments(entityType: $entityType, entityId: $entityId) {
      id
      filename
      mimeType
      sizeBytes
      uploadedBy
      uploadedAt
      description
      downloadUrl
    }
  }
`

const ARTICLE = {
  __typename: 'KBArticle', id: 'kb-1', title: 'Reset della password VPN', slug: 'reset-vpn', body: 'Apri il **portale** e segui i passi.',
  category: 'how-to', tags: ['vpn', 'password'], status: 'published', authorId: 'u1', authorName: 'Mario Rossi',
  views: 42, helpfulCount: 3, notHelpfulCount: 1, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z', publishedAt: '2026-09-02T10:00:00Z',
}

const articleMock = (data: typeof ARTICLE | null): GqlMock => ({
  request: { query: GET_ARTICLE, variables: { slug: 'reset-vpn' } },
  result: { data: { kbArticleBySlug: data } },
})
const relatedMock: GqlMock = {
  request: { query: GET_RELATED, variables: { category: 'how-to' } },
  result: { data: { kbArticles: { __typename: 'KBArticlePage', items: [
    { __typename: 'KBArticle', id: 'kb-2', title: 'Configurare la VPN', slug: 'config-vpn', category: 'how-to', views: 7 },
    { __typename: 'KBArticle', id: 'kb-1', title: 'Reset della password VPN', slug: 'reset-vpn', category: 'how-to', views: 42 },
  ] } } },
}
const attachmentsMock: GqlMock = {
  request: { query: GET_ATTACHMENTS, variables: { entityType: 'kb_article', entityId: 'kb-1' } },
  result: { data: { attachments: [] } },
}

const ROUTE = { route: '/knowledge-base/reset-vpn', path: '/knowledge-base/:slug' }

const RATE_ARTICLE = gql`
  mutation RateKBArticle($id: ID!, $helpful: Boolean!) {
    rateKBArticle(id: $id, helpful: $helpful) { id helpfulCount notHelpfulCount }
  }
`

const pageMocks = (...extra: GqlMock[]) => [articleMock(ARTICLE), relatedMock, attachmentsMock, ...extra]

describe('KBArticlePage: vote and retry', () => {
  it('«Yes» sends a helpful vote for this article and thanks the reader', async () => {
    const seen: unknown[] = []
    const rate: GqlMock = {
      request: { query: RATE_ARTICLE, variables: (v) => { seen.push(v); return true } },
      result: { data: { rateKBArticle: { __typename: 'KBArticle', id: 'kb-1', helpfulCount: 4, notHelpfulCount: 1 } } },
    }
    const { user } = renderWithProviders(<KBArticlePage />, { ...ROUTE, mocks: pageMocks(rate) })
    await user.click(await screen.findByRole('button', { name: /Yes \(3\)/ }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Thank you for your feedback!'))
    expect(seen).toEqual([{ id: 'kb-1', helpful: true }])
  })

  it('«No» sends a NOT helpful vote', async () => {
    const seen: unknown[] = []
    const rate: GqlMock = {
      request: { query: RATE_ARTICLE, variables: (v) => { seen.push(v); return true } },
      result: { data: { rateKBArticle: { __typename: 'KBArticle', id: 'kb-1', helpfulCount: 3, notHelpfulCount: 2 } } },
    }
    const { user } = renderWithProviders(<KBArticlePage />, { ...ROUTE, mocks: pageMocks(rate) })
    await user.click(await screen.findByRole('button', { name: /No \(1\)/ }))
    await waitFor(() => expect(seen).toEqual([{ id: 'kb-1', helpful: false }]))
  })

  it('a failed vote is reported once, the reader is NOT thanked, and no rejection is left unhandled', async () => {
    // Defect fixed with this test: the thank-you was chained on the mutation
    // promise, which Apollo 4 rejects even with `onError` set — every failed
    // vote left an unhandled rejection (a crash report, not a handled error).
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const rate: GqlMock = { request: { query: RATE_ARTICLE, variables: { id: 'kb-1', helpful: true } }, error: new Error('rating service down') }
      const { user } = renderWithProviders(<KBArticlePage />, { ...ROUTE, mocks: pageMocks(rate) })
      await user.click(await screen.findByRole('button', { name: /Yes \(3\)/ }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rating service down'))
      expect(toast.success).not.toHaveBeenCalled()
      // Give Node a turn to report a rejection nobody handled.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('Retry after a failed load reads the article again and shows it', async () => {
    const err: GqlMock = { request: { query: GET_ARTICLE, variables: { slug: 'reset-vpn' } }, error: new Error('kb service down') }
    const { user } = renderWithProviders(<KBArticlePage />, { ...ROUTE, mocks: [err, ...pageMocks()] })
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Reset della password VPN' })).toBeInTheDocument()
    expect(screen.queryByText('kb service down')).not.toBeInTheDocument()
  })
})
