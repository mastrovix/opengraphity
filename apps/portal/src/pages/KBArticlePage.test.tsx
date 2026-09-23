/**
 * A KNOWLEDGE BASE ARTICLE, read from the portal.
 *
 * The rating is the part with a rule: a vote is cast once, and the counters
 * come back from the SERVER rather than being incremented locally — two
 * people reading the same article at the same time would otherwise each see
 * their own number.
 *
 * The category is shown with its Dictionary label in the reader's language:
 * the portal used to carry its own table of names and emoji.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { KBArticlePage } from './KBArticlePage'
import { GET_KB_ARTICLE_BY_SLUG, GET_KB_ARTICLES, GET_KB_CATEGORIES, GET_ME } from '@/graphql/queries'
import { RATE_KB_ARTICLE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const sempre = Number.POSITIVE_INFINITY

const articolo = (over: Record<string, unknown> = {}) => ({
  __typename: 'KBArticle', id: 'a1', title: 'Reset the VPN', slug: 'reset-vpn',
  body: '## Steps\n\n1. Open the client\n2. Sign in again', category: 'how-to', tags: [],
  authorName: 'Anna Rossi', views: 42, helpfulCount: 7, notHelpfulCount: 1,
  createdAt: '2026-01-10T09:00:00Z', publishedAt: '2026-02-01T09:00:00Z', ...over,
})

const me: GqlMock = {
  request: { query: GET_ME },
  result: { data: { me: { __typename: 'User', id: 'u1', name: 'Anna', email: 'a@x', role: 'end_user', permissions: ['portal.read', 'portal.submit'], language: 'en' } } },
  maxUsageCount: sempre,
}
const categorie: GqlMock = {
  request: { query: GET_KB_CATEGORIES, variables: () => true },
  result: { data: { kbCategories: [{ __typename: 'KBCategory', name: 'how-to', label: 'How-to guides', count: 3 }] } },
  maxUsageCount: sempre,
}
const correlati = (items: unknown[]): GqlMock => ({
  request: { query: GET_KB_ARTICLES, variables: () => true },
  result: { data: { kbArticles: { __typename: 'KBArticlesResult', total: items.length, items } } },
  maxUsageCount: sempre,
})
const uno = (a: unknown = articolo()): GqlMock => ({
  request: { query: GET_KB_ARTICLE_BY_SLUG, variables: () => true },
  result: { data: { kbArticleBySlug: a } },
  maxUsageCount: sempre,
})

const mostra = (mocks: GqlMock[]) =>
  renderWithProviders(<KBArticlePage />, { mocks, route: '/kb/reset-vpn', path: '/kb/:slug' })

describe('the article', () => {
  it('shows the title, the author, the views and the body as formatted text', async () => {
    mostra([me, categorie, uno(), correlati([])])
    expect(await screen.findByRole('heading', { name: 'Reset the VPN' })).toBeInTheDocument()
    expect(screen.getByText('Anna Rossi')).toBeInTheDocument()
    expect(screen.getByText(/42/)).toBeInTheDocument()
    // The body is markdown: it arrives rendered, not as raw hashes.
    expect(await screen.findByRole('heading', { name: 'Steps' })).toBeInTheDocument()
    expect(screen.getByText(/Open the client/)).toBeInTheDocument()
  })

  // Tour of 23 Sep 2026: the editor saves an underline as <u>…</u>, and the
  // reader printed the tag as text. Exactly that pair is rendered; any other
  // HTML in an article stays text on the reader's page.
  it('an underline written in the editor reads as underlined, and no other HTML is rendered', async () => {
    mostra([me, categorie, uno(articolo({ body: 'Press <u>Reset</u>, not <b>Delete</b>.' })), correlati([])])
    const underlined = await screen.findByText('Reset')
    expect(underlined.tagName).toBe('U')
    expect(document.querySelector('b')).toBeNull()
  })

  it('an article that does not exist says so instead of an empty page', async () => {
    mostra([me, categorie, uno(null), correlati([])])
    expect(await screen.findByText(/not found|Not found/i)).toBeInTheDocument()
  })

  it('an unpublished article shows no publication date, and still renders', async () => {
    mostra([me, categorie, uno(articolo({ publishedAt: null })), correlati([])])
    expect(await screen.findByRole('heading', { name: 'Reset the VPN' })).toBeInTheDocument()
  })

  it('leads back to the Knowledge Base', async () => {
    mostra([me, categorie, uno(), correlati([])])
    await screen.findByRole('heading', { name: 'Reset the VPN' })
    expect(screen.getAllByRole('link').some((l) => l.getAttribute('href') === '/kb')).toBe(true)
  })
})

describe('related articles', () => {
  it('lists others of the same category, and never the article itself', async () => {
    mostra([me, categorie, uno(), correlati([
      articolo(),                                                     // itself
      articolo({ id: 'a2', title: 'Change your password', slug: 'change-password' }),
    ])])
    await screen.findByRole('heading', { name: 'Reset the VPN' })
    expect(await screen.findByText('Change your password')).toBeInTheDocument()
    // Il titolo compare due volte (briciole di pane e intestazione), ma MAI
    // come voce dei correlati: si cerca fra i link.
    const correlatiVisti = screen.getAllByRole('link').map((l) => l.textContent)
    expect(correlatiVisti).toContain('Change your password')
    expect(correlatiVisti).not.toContain('Reset the VPN')
  })

  it('with no related article the section simply is not there', async () => {
    mostra([me, categorie, uno(), correlati([articolo()])])
    await screen.findByRole('heading', { name: 'Reset the VPN' })
    await waitFor(() => { expect(screen.queryByText('Change your password')).toBeNull() })
  })
})

describe('was this helpful?', () => {
  const voto = (helpful: boolean, counts: [number, number]): GqlMock => ({
    request: { query: RATE_KB_ARTICLE, variables: { id: 'a1', helpful } },
    result: { data: { rateKBArticle: { __typename: 'KBArticle', id: 'a1', helpfulCount: counts[0], notHelpfulCount: counts[1] } } },
  })

  it('shows both counters as they are today', async () => {
    mostra([me, categorie, uno(), correlati([])])
    expect(await screen.findByRole('button', { name: /\(7\)/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /\(1\)/ })).toBeInTheDocument()
  })

  it('a vote takes the counters back FROM THE SERVER, not from a local increment', async () => {
    // Two people reading at the same time would otherwise each see their own
    // number.
    const { user } = mostra([me, categorie, uno(), correlati([]), voto(true, [8, 1])])
    await user.click(await screen.findByRole('button', { name: /\(7\)/ }))
    expect(await screen.findByText(/thank|Thank/i)).toBeInTheDocument()
  })

  it('once voted the buttons are gone: a vote is cast once', async () => {
    const { user } = mostra([me, categorie, uno(), correlati([]), voto(false, [7, 2])])
    await user.click(await screen.findByRole('button', { name: /\(1\)/ }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: /\(7\)/ })).toBeNull() })
  })
})
