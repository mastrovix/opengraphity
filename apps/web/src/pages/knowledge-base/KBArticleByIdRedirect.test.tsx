/**
 * A KNOWLEDGE BASE ARTICLE REACHED BY ITS ID (B-21/A-20).
 *
 * Notifications and approvals point to an article by its ID, while the
 * article page opens by slug: without this route the «article published»
 * notification was not clickable. The route must find the slug and go there
 * without leaving itself in the history (Back returns to the notification,
 * not to a blank redirect), and must say so when the article is gone —
 * never show a blank page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { renderWithProviders, attendiURL, LocationSpy } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { inFlight, resetInFlight } from '@/test/apolloInFlight'
import { KBArticleByIdRedirect } from './KBArticleByIdRedirect'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
})

const mount = () => renderWithProviders(<KBArticleByIdRedirect />, { route: '/kb-articles/kb-42', path: '/kb-articles/:id' })

describe('KBArticleByIdRedirect', () => {
  it('opens the article by its slug', async () => {
    apolloFinto.risposte['KBArticleSlug'] = { kbArticle: { id: 'kb-42', slug: 'reset-a-password' } }
    mount()
    expect(apolloFinto.chiamata('KBArticleSlug')).toEqual({ id: 'kb-42' })
    await attendiURL('/knowledge-base/reset-a-password')
  })

  it('the redirect does not stay in the history: Back returns to where the link was', async () => {
    apolloFinto.risposte['KBArticleSlug'] = { kbArticle: { id: 'kb-42', slug: 'reset-a-password' } }
    function Article() {
      const navigate = useNavigate()
      return <button type="button" onClick={() => navigate(-1)}>back from the article</button>
    }
    render(
      <MemoryRouter initialEntries={['/notifications', '/kb-articles/kb-42']} initialIndex={1}>
        <Routes>
          <Route path="/kb-articles/:id" element={<KBArticleByIdRedirect />} />
          <Route path="/knowledge-base/:slug" element={<Article />} />
          <Route path="*" element={<LocationSpy />} />
        </Routes>
      </MemoryRouter>,
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: 'back from the article' }))
    await attendiURL('/notifications')
  })

  it('while the article is looked up, it waits instead of saying it is missing', () => {
    inFlight.add('KBArticleSlug')
    mount()
    expect(screen.queryByText('Article not found')).not.toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/kb-articles/kb-42')
  })

  it('an article that no longer exists is said, with a way back to the knowledge base', async () => {
    apolloFinto.risposte['KBArticleSlug'] = { kbArticle: null }
    const { user } = mount()
    expect(screen.getByText('Article not found')).toBeInTheDocument()
    expect(screen.getByText('The article kb-42 no longer exists, or it was never published.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to the knowledge base' }))
    await attendiURL('/knowledge-base')
  })

  it('mounted without an id, the message never reads "undefined"', () => {
    apolloFinto.risposte['KBArticleSlug'] = { kbArticle: null }
    renderWithProviders(<KBArticleByIdRedirect />, { route: '/kb-articles' })
    expect(screen.getByText(/no longer exists, or it was never published/)).not.toHaveTextContent('undefined')
  })

  it('an article without a slug cannot be opened, and is said to be missing', () => {
    apolloFinto.risposte['KBArticleSlug'] = { kbArticle: { id: 'kb-42', slug: '' } }
    mount()
    expect(screen.getByText('Article not found')).toBeInTheDocument()
  })

  it('a failed lookup shows the error with a retry', async () => {
    apolloFinto.erroriQuery['KBArticleSlug'] = new Error('knowledge base unavailable')
    const { user } = mount()
    expect(screen.getByText('knowledge base unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
