/**
 * The Knowledge Base home: search, browse by category, page through the
 * published articles, and — for whoever may write — start a new article
 * (14 Sep 2026 walk-through, #45: there was no way to write one from here).
 *
 * What a reader loses if these regress: a search that does not reach the
 * server (or keeps an old page number and shows an empty page), a category
 * filter that cannot be removed, a list that silently shows nothing when the
 * server fails. KnowledgeBasePage.test.tsx pins the vocabulary labels and
 * colours; this file pins the navigation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { meFixture } from '@/test/mocks/gql'
import { colors } from '@/lib/tokens'
import { KnowledgeBasePage } from './KnowledgeBasePage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const article = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Article ${id}`, slug: `slug-${id}`, category: 'how-to', tags: [], status: 'published',
  authorName: 'Bob', views: 3, helpfulCount: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z',
  ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetMe'] = { me: meFixture('admin') }
  apolloFinto.risposte['KBCategories'] = { kbCategories: [{ name: 'how-to', count: 3 }, { name: 'faq', count: 1 }, { name: 'empty', count: 0 }] }
  apolloFinto.risposte['KBArticles'] = { kbArticles: { total: 40, items: [
    article('a1', { tags: ['vpn', 'network', 'remote', 'extra'] }),
    article('a2'),
  ] } }
})

const lastArticlesVars = () => apolloFinto.chiamata('KBArticles')

describe('KnowledgeBasePage — navigation', () => {
  it('whoever may write gets «New article», which opens the editor on a new article', () => {
    renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    expect(screen.getByRole('link', { name: /New article/ })).toHaveAttribute('href', '/admin/knowledge-base?new=1')
  })

  it('a reader without kb.write is not offered «New article»', () => {
    apolloFinto.risposte['GetMe'] = { me: meFixture('reader-only') }
    renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    expect(screen.queryByRole('link', { name: /New article/ })).not.toBeInTheDocument()
  })

  it('an article card shows at most three tags and links to the article by slug', () => {
    renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    const card = screen.getByRole('link', { name: /Article a1/ })
    expect(card).toHaveAttribute('href', '/knowledge-base/slug-a1')
    expect(within(card).getByText('remote')).toBeInTheDocument()
    // A long tag list must not push the title off the card.
    expect(within(card).queryByText('extra')).not.toBeInTheDocument()
  })

  it('search goes to the server from page 1, hides the category grid, and ✕ brings everything back', async () => {
    const { user } = renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastArticlesVars()).toMatchObject({ page: 2 })

    await user.type(screen.getByRole('textbox', { name: 'Search articles...' }), 'vpn')
    // Typing alone does not search: only submitting does.
    expect(lastArticlesVars()).not.toHaveProperty('search', 'vpn')
    await user.click(screen.getByRole('button', { name: 'Search...' }))
    // A new search starts from the first page, or it could land on an empty one.
    expect(lastArticlesVars()).toEqual({ search: 'vpn', category: undefined, page: 1, pageSize: 15 })
    expect(screen.getByRole('heading', { name: '40 results for "vpn"' })).toBeInTheDocument()
    expect(screen.queryByText('Browse by category')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '✕' }))
    expect(lastArticlesVars()).toEqual({ search: undefined, category: undefined, page: 1, pageSize: 15 })
    expect(screen.getByRole('textbox', { name: 'Search articles...' })).toHaveValue('')
    expect(screen.getByText('Browse by category')).toBeInTheDocument()
  })

  it('a category tile filters the list; the chip\'s ✕ removes the filter', async () => {
    const { user } = renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    // Only categories with published articles are offered: an empty tile leads nowhere.
    expect(screen.queryByRole('button', { name: /^empty/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^faq/ }))
    expect(lastArticlesVars()).toMatchObject({ category: 'faq', page: 1 })
    expect(screen.getByText('Category:')).toBeInTheDocument()
    expect(screen.queryByText('Browse by category')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(lastArticlesVars()).toMatchObject({ category: undefined })
    expect(screen.queryByText('Category:')).not.toBeInTheDocument()
  })

  it('pages move forward and back', async () => {
    const { user } = renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastArticlesVars()).toMatchObject({ page: 3 })
    await user.click(screen.getByRole('button', { name: /Prev/ }))
    expect(lastArticlesVars()).toMatchObject({ page: 2 })
  })

  it('the search box and the category tiles show where the pointer and the focus are', () => {
    renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    const box = screen.getByRole('textbox', { name: 'Search articles...' })
    fireEvent.focus(box)
    expect(box.style.borderColor).toBe('var(--color-brand)')
    fireEvent.blur(box)
    expect(box.style.borderColor).toBe(colors.border)

    const tile = screen.getByRole('button', { name: /^faq/ })
    fireEvent.mouseEnter(tile)
    // Hover lights the tile in its category's accent colour...
    expect(tile.style.borderColor).not.toBe('')
    expect(tile.style.borderColor).not.toBe(colors.border)
    fireEvent.mouseLeave(tile)
    // ...and leaving puts back the neutral border.
    expect(tile.style.borderColor).toBe(colors.border)
  })

  it('no articles → an explicit «No articles found», not an empty page', () => {
    apolloFinto.risposte['KBArticles'] = { kbArticles: { total: 0, items: [] } }
    renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    expect(screen.getByText('No articles found')).toBeInTheDocument()
  })

  it('a server error is shown with a retry, never as «no articles»', async () => {
    apolloFinto.risposte['KBArticles'] = undefined
    apolloFinto.erroriQuery['KBArticles'] = new Error('kb down')
    const { user } = renderWithProviders(<KnowledgeBasePage />, { route: '/knowledge-base' })
    expect(screen.getByText('kb down')).toBeInTheDocument()
    expect(screen.queryByText('No articles found')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
