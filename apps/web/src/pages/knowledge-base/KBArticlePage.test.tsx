import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { gql } from '@apollo/client'
import { KBArticlePage } from './KBArticlePage'
import { renderWithProviders, type GqlMock } from '@/test/utils'

// Documenti privati di KBArticlePage.tsx / AttachmentsSection.tsx, replicati per il MockLink.
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

describe('KBArticlePage', () => {
  it('mostra "Loading..." finché la query è in corso', () => {
    renderWithProviders(<KBArticlePage />, { ...ROUTE, mocks: [{ request: { query: GET_ARTICLE, variables: { slug: 'reset-vpn' } }, delay: Number.POSITIVE_INFINITY }] })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('Article not found')).not.toBeInTheDocument()
  })

  it('errore di rete/API → QueryError con retry, NON "articolo non trovato" (F-09)', async () => {
    const err: GqlMock = { request: { query: GET_ARTICLE, variables: { slug: 'reset-vpn' } }, error: new Error('kb service down') }
    renderWithProviders(<KBArticlePage />, { ...ROUTE, mocks: [err] })
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('kb service down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('Article not found')).not.toBeInTheDocument()
  })

  it('articolo null (slug inesistente) → "Article not found"', async () => {
    renderWithProviders(<KBArticlePage />, { ...ROUTE, mocks: [articleMock(null)] })
    expect(await screen.findByText('Article not found')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load data')).not.toBeInTheDocument()
  })

  it('articolo trovato → titolo, categoria, markdown, tag, correlati (senza sé stesso) e link indietro', async () => {
    renderWithProviders(<KBArticlePage />, { ...ROUTE, mocks: [articleMock(ARTICLE), relatedMock, attachmentsMock] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Reset della password VPN' })).toBeInTheDocument()
    expect(screen.getByText('how-to')).toBeInTheDocument()
    expect(screen.getByText('portale').tagName).toBe('STRONG')   // markdown renderizzato
    expect(screen.getByText('vpn')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/knowledge-base')
    expect(screen.getByRole('button', { name: /Yes \(3\)/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /No \(1\)/ })).toBeInTheDocument()

    const related = await screen.findByRole('link', { name: /Configurare la VPN/ })
    expect(related).toHaveAttribute('href', '/knowledge-base/config-vpn')
    expect(screen.getAllByText('Reset della password VPN')).toHaveLength(1)   // il correlato uguale all'articolo è escluso
  })
})
