/**
 * Revisione del 14 set 2026 · F5: le categorie della Knowledge Base vengono dal
 * vocabolario `kb_category` del Dizionario, con etichetta e colore. Prima la
 * pagina aveva la sua tabella di sette categorie con emoji e colori, e mostrava
 * il nome interno (`how-to`).
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { gql } from '@apollo/client'
import { formatDate } from '@/lib/datetime'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { palette } from '@/lib/tokens'
import { KnowledgeBasePage } from './KnowledgeBasePage'

const GET_CATEGORIES = gql`
  query KBCategories { kbCategories { name count } }
`
const GET_ARTICLES = gql`
  query KBArticles($search: String, $category: String, $page: Int, $pageSize: Int) {
    kbArticles(search: $search, category: $category, status: "published", page: $page, pageSize: $pageSize) {
      items { id title slug category tags status authorName views helpfulCount createdAt updatedAt publishedAt }
      total
    }
  }
`

const categories: GqlMock = {
  request: { query: GET_CATEGORIES },
  result: { data: { kbCategories: [
    { __typename: 'KBCategory', name: 'how-to', count: 3 },
    { __typename: 'KBCategory', name: 'faq', count: 0 },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
const articles: GqlMock = {
  request: { query: GET_ARTICLES, variables: { page: 1, pageSize: 15 } },
  result: { data: { kbArticles: { __typename: 'KBArticlesResult', total: 1, items: [{
    __typename: 'KBArticle', id: 'a1', title: 'Reset VPN', slug: 'reset-vpn', category: 'how-to', tags: [], status: 'published',
    authorName: 'Bob', views: 1, helpfulCount: 0, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z',
  }] } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const vocab = {
  valuesOf: (n: string) => (n === 'kb_category' ? ['how-to', 'faq'] : null),
  labelOf: (n: string, v: string) => (n === 'kb_category' ? ({ 'how-to': 'Come fare', faq: 'Domande frequenti' } as Record<string, string>)[v] ?? null : null),
  colorOf: (n: string, v: string) => (n === 'kb_category' && v === 'how-to' ? 'success' as const : null),
  vocabularyLabelOf: () => null, entriesOf: () => null, loading: false, error: null,
}

describe('KnowledgeBasePage — categorie dal Dizionario', () => {
  it('la griglia mostra le categorie con articoli pubblicati, con la loro etichetta', async () => {
    renderWithProviders(<DomainVocabularyContext.Provider value={vocab}><KnowledgeBasePage /></DomainVocabularyContext.Provider>, { mocks: [categories, articles] })
    const grid = await screen.findByRole('button', { name: /Come fare/ })
    expect(grid).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Domande frequenti/ })).toBeNull()
  })

  it("la pastiglia dell'articolo porta etichetta e colore del Dizionario", async () => {
    renderWithProviders(<DomainVocabularyContext.Provider value={vocab}><KnowledgeBasePage /></DomainVocabularyContext.Provider>, { mocks: [categories, articles] })
    const link = await screen.findByRole('link', { name: /Reset VPN/ })
    const pill = within(link).getByText('Come fare')
    expect(pill).toHaveStyle({ background: palette.success.tint, color: palette.success.text })
  })

  // Tour of 24 Sep 2026 (G4): the list is the most recently updated first, and showed the publication dates.
  it('the date of an article is the one the list is ordered by, and says so', async () => {
    renderWithProviders(<DomainVocabularyContext.Provider value={vocab}><KnowledgeBasePage /></DomainVocabularyContext.Provider>, { mocks: [categories, articles] })
    const link = await screen.findByRole('link', { name: /Reset VPN/ })
    expect(within(link).getByText(`Updated ${formatDate('2026-09-20T00:00:00Z')}`)).toBeInTheDocument()
  })
})
