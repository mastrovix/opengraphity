import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { NotFoundPage } from './NotFoundPage'
import { renderWithProviders } from '@/test/utils'

describe('NotFoundPage', () => {
  it('mostra 404, il titolo, il path richiesto e il link alla home', () => {
    renderWithProviders(<NotFoundPage />, { route: '/does/not/exist' })
    expect(screen.getByText('404')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByText('The address /does/not/exist does not exist in the portal.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/')
  })

  it('il link alla home naviga alla root', async () => {
    const { user } = renderWithProviders(<NotFoundPage />, { route: '/nope' })
    await user.click(screen.getByRole('link', { name: 'Back to home' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/')
  })
})
