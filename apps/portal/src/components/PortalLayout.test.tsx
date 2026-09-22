/**
 * THE PORTAL SHELL: who is reading, in which language, and whether they may
 * be here at all.
 *
 * `portal.read` is a permission of the role (wave 7): without it the portal
 * says so instead of rendering pages whose every query would come back
 * refused.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { PortalLayout } from './PortalLayout'
import { RequireSubmit } from './RequireSubmit'
import { GET_ME, GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import i18n from '@/i18n/i18n'

const sempre = Number.POSITIVE_INFINITY

const me = (permissions: string[], over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_ME },
  result: { data: { me: { __typename: 'User', id: 'u1', name: 'Anna Rossi', email: 'anna@acme.example', role: 'end_user', permissions, language: null, ...over } } },
  maxUsageCount: sempre,
})
const lingue = (defaultLanguage: string | null): GqlMock => ({
  request: { query: GET_TENANT_LANGUAGE_SETTINGS },
  result: { data: { tenantLanguageSettings: { __typename: 'LanguageSettings', available: ['en', 'it'], defaultLanguage, fallback: 'en' } } },
  maxUsageCount: sempre,
})

describe('PortalLayout', () => {
  it('shows who is reading, and the footer', async () => {
    renderWithProviders(<PortalLayout />, { mocks: [me(['portal.read']), lingue(null)] })
    expect(await screen.findByText('Anna Rossi')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(String(new Date().getFullYear())))).toBeInTheDocument()
  })

  it('names the tab in the active language: it used to be Italian even in English', async () => {
    renderWithProviders(<PortalLayout />, { mocks: [me(['portal.read']), lingue(null)] })
    await screen.findByText('Anna Rossi')
    expect(document.title).not.toBe('')
    expect(document.title).toBe(i18n.t('portal.documentTitle'))
  })

  it('without portal.read it says so, and renders no page underneath', async () => {
    renderWithProviders(<PortalLayout />, { mocks: [me([]), lingue(null)] })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('before `me` arrives it does NOT flash the refusal', async () => {
    // Showing "no access" while the answer is in flight would make every
    // page start with an error.
    const lento: GqlMock = { ...me(['portal.read']), delay: 50 }
    renderWithProviders(<PortalLayout />, { mocks: [lento, lingue(null)] })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the customer\'s language wins when the person has not chosen one', async () => {
    renderWithProviders(<PortalLayout />, { mocks: [me(['portal.read']), lingue('it')] })
    await waitFor(() => { expect(i18n.language).toBe('it') })
    await i18n.changeLanguage('en')
  })

  it('the PERSON\'s choice wins over the customer\'s', async () => {
    // It used to live only in the web's browser storage, so somebody who had
    // chosen Italian there still got the organization's language here.
    renderWithProviders(<PortalLayout />, { mocks: [me(['portal.read'], { language: 'it' }), lingue('en')] })
    await waitFor(() => { expect(i18n.language).toBe('it') })
    await i18n.changeLanguage('en')
  })

  it('nobody having configured one leaves the bootstrap language alone', async () => {
    renderWithProviders(<PortalLayout />, { mocks: [me(['portal.read']), lingue(null)] })
    await screen.findByText('Anna Rossi')
    expect(i18n.language).toBe('en')
  })
})

describe('RequireSubmit', () => {
  it('renders the page for somebody who may open a request', async () => {
    renderWithProviders(<RequireSubmit><p>the form</p></RequireSubmit>, { mocks: [me(['portal.read', 'portal.submit'])] })
    expect(await screen.findByText('the form')).toBeInTheDocument()
  })

  it('without portal.submit it SAYS so instead of showing a form the API would refuse', async () => {
    renderWithProviders(<RequireSubmit><p>the form</p></RequireSubmit>, { mocks: [me(['portal.read'])] })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('the form')).toBeNull()
    expect(screen.getByRole('link')).toBeInTheDocument()   // a way back home
  })

  it('while the answer is in flight it shows nothing, not a refusal', async () => {
    renderWithProviders(<RequireSubmit><p>the form</p></RequireSubmit>, { mocks: [{ ...me(['portal.submit']), delay: 50 }] })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('the form')).toBeNull()
  })
})
