/**
 * Revisione del 14 set 2026 · F5: il portale mostra le categorie della
 * Knowledge Base con l'etichetta del Dizionario (vocabolario `kb_category`)
 * nella lingua di chi legge, invece del nome interno con un'emoji scelta da
 * una tabella scritta qui.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { KBListPage } from './KBListPage'
import { GET_KB_ARTICLES, GET_KB_CATEGORIES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const seen: Record<string, unknown>[] = []
const categories: GqlMock = {
  request: { query: GET_KB_CATEGORIES, variables: (v) => { seen.push(v); return true } },
  result: { data: { kbCategories: [
    { __typename: 'KBCategory', name: 'how-to', label: 'How-to guides', count: 2 },
    { __typename: 'KBCategory', name: 'faq', label: 'FAQ', count: 0 },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
const articles: GqlMock = {
  request: { query: GET_KB_ARTICLES, variables: () => true },
  result: { data: { kbArticles: { __typename: 'KBArticlesResult', total: 1, items: [{
    __typename: 'KBArticle', id: 'a1', title: 'Reset VPN', slug: 'reset-vpn', body: 'body', category: 'how-to', views: 3, publishedAt: null,
  }] } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

describe('KBListPage — categorie dal Dizionario', () => {
  it('etichetta nella lingua di chi legge, solo categorie con articoli, e la stessa etichetta sull\'articolo', async () => {
    renderWithProviders(<KBListPage />, { mocks: [categories, articles] })
    expect(await screen.findByRole('button', { name: /How-to guides/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /FAQ/ })).toBeNull()
    await waitFor(() => expect(screen.getAllByText('How-to guides').length).toBe(2))
    expect(seen[0]).toMatchObject({ language: expect.any(String) })
  })
})

/**
 * Giro nel browser del 14 set 2026: «1 articles» e, cercando, «1 risultati per
 * …» con «Cancella» — testi scritti a mano in italiano in un portale inglese.
 */
describe('KBListPage — conteggi e ricerca nella lingua di chi legge', () => {
  it('«1 article» al singolare', async () => {
    const one: GqlMock = { ...categories, result: { data: { kbCategories: [{ __typename: 'KBCategory', name: 'how-to', label: 'How-to guides', count: 1 }] } } }
    renderWithProviders(<KBListPage />, { mocks: [one, articles] })
    expect(await screen.findByText('1 article')).toBeInTheDocument()
  })

  it('la ricerca dice i risultati in inglese', async () => {
    const { user } = renderWithProviders(<KBListPage />, { mocks: [categories, articles] })
    const box = await screen.findByRole('searchbox').catch(() => screen.getAllByRole('textbox')[0]!)
    await user.type(box, 'vpn{Enter}')
    expect(await screen.findByText(/1 result for/)).toBeInTheDocument()
    expect(screen.queryByText(/risultati per|Cancella/)).toBeNull()
  })
})

/**
 * FILTRI E INDIRIZZO.
 *
 * La ricerca e la categoria stanno nell'URL: un articolo trovato si condivide
 * col collega mandandogli il link, e il tasto «indietro» torna dove si era.
 */
describe('KBListPage — la categoria e l\'indirizzo', () => {
  it('scegliere una categoria la scrive nell\'URL e lo dice in pagina', async () => {
    const { user } = renderWithProviders(<KBListPage />, { mocks: [categories, articles] })
    await user.click(await screen.findByRole('button', { name: /How-to guides/ }))
    await waitFor(() => { expect(screen.getByTestId('location').textContent).toContain('category=how-to') })
    // Si dice che si sta guardando UNA categoria, e si può tornare indietro (H-13).
    expect(await screen.findByRole('button', { name: 'All categories' })).toBeInTheDocument()
  })

  it('togliere la categoria pulisce l\'indirizzo', async () => {
    const { user } = renderWithProviders(<KBListPage />, { mocks: [categories, articles] })
    await user.click(await screen.findByRole('button', { name: /How-to guides/ }))
    await user.click(await screen.findByRole('button', { name: 'All categories' }))
    await waitFor(() => { expect(screen.getByTestId('location').textContent).not.toContain('category=') })
  })

  it('una ricerca finisce nell\'URL, e cancellarla lo ripulisce', async () => {
    const { user } = renderWithProviders(<KBListPage />, { mocks: [categories, articles] })
    const box = await screen.findByRole('searchbox').catch(() => screen.getAllByRole('textbox')[0]!)
    await user.type(box, 'vpn{Enter}')
    await waitFor(() => { expect(screen.getByTestId('location').textContent).toContain('search=vpn') })
    await user.click(await screen.findByRole('button', { name: 'Clear' }))
    await waitFor(() => { expect(screen.getByTestId('location').textContent).not.toContain('search=') })
  })

  it('un indirizzo con una categoria dentro apre già filtrato', async () => {
    // Il link che si manda al collega deve aprire quello che si vedeva.
    renderWithProviders(<KBListPage />, { mocks: [categories, articles], route: '/kb?category=how-to' })
    expect(await screen.findByRole('button', { name: 'All categories' })).toBeInTheDocument()
  })
})
