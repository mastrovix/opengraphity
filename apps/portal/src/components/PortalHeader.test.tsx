import { describe, it, expect, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { PortalHeader } from './PortalHeader'
import { renderWithProviders } from '@/test/utils'
import { mockKeycloak } from '@/test/mocks/keycloak'

beforeEach(() => {
  mockKeycloak.accountManagement.mockClear()
  mockKeycloak.logout.mockClear()
})

describe('PortalHeader', () => {
  it('mostra le voci di navigazione con i link corretti e la voce attiva', () => {
    renderWithProviders(<PortalHeader userName="Mario Rossi" />, { route: '/tickets/42' })
    const nav = screen.getByRole('navigation')
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
    expect(within(nav).getByRole('link', { name: 'My tickets' })).toHaveAttribute('href', '/tickets')
    expect(within(nav).getByRole('link', { name: 'Catalog' })).toHaveAttribute('href', '/catalog')
    expect(within(nav).getByRole('link', { name: 'Knowledge Base' })).toHaveAttribute('href', '/kb')
    expect(within(nav).getByRole('link', { name: 'My tickets' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
  })

  it('avatar con le iniziali e nome utente; "?" se il nome è vuoto', () => {
    const { rerender } = renderWithProviders(<PortalHeader userName="Mario Rossi" />)
    expect(screen.getByText('MR')).toBeInTheDocument()
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument()
    rerender(<PortalHeader userName="" />)
    expect(screen.getByText('?')).toBeInTheDocument()
  })

  it('il menu utente si apre al click; "Profile" apre l\'account console Keycloak e chiude il menu', async () => {
    const { user } = renderWithProviders(<PortalHeader userName="Mario Rossi" />)
    expect(screen.queryByRole('button', { name: 'Profile' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Mario Rossi/ }))
    await user.click(screen.getByRole('button', { name: 'Profile' }))
    expect(mockKeycloak.accountManagement).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Profile' })).not.toBeInTheDocument()
  })

  it('"Logout" chiama keycloak.logout con redirect alla origin', async () => {
    const { user } = renderWithProviders(<PortalHeader userName="Mario Rossi" />)
    await user.click(screen.getByRole('button', { name: /Mario Rossi/ }))
    await user.click(screen.getByRole('button', { name: 'Logout' }))
    expect(mockKeycloak.logout).toHaveBeenCalledWith({ redirectUri: window.location.origin })
  })

  it('il menu mobile compare solo dopo l\'hamburger e si chiude scegliendo una voce', async () => {
    const { user } = renderWithProviders(<PortalHeader userName="Mario Rossi" />)
    expect(screen.getAllByRole('link', { name: 'Catalog' })).toHaveLength(1)
    await user.click(document.querySelector('.portal-hamburger') as HTMLElement)
    expect(screen.getAllByRole('link', { name: 'Catalog' })).toHaveLength(2)
    await user.click(screen.getAllByRole('link', { name: 'Catalog' })[1]!)
    expect(screen.getAllByRole('link', { name: 'Catalog' })).toHaveLength(1)
    expect(screen.getByTestId('location')).toHaveTextContent('/catalog')
  })
})
