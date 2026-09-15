/** Secondo giro UI del 15 set 2026: il portale restava nella lingua dell'organizzazione anche per chi aveva scelto l'italiano. */
import { describe, it, expect, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { GET_ME, GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { SET_MY_LANGUAGE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { PortalLanguageSelect } from './PortalLanguageSelect'

const me = (language: string | null): GqlMock => ({
  request: { query: GET_ME },
  result: { data: { me: { __typename: 'User', id: 'u1', name: 'Anna', email: 'anna@x.it', role: 'end_user', permissions: ['portal.read'], language } } },
})
const settings: GqlMock = {
  request: { query: GET_TENANT_LANGUAGE_SETTINGS },
  result: { data: { tenantLanguageSettings: { __typename: 'TenantLanguageSettings', available: ['en', 'it'], defaultLanguage: 'en', fallback: 'en' } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

describe('PortalLanguageSelect', () => {
  afterEach(async () => { await i18n.changeLanguage('en') })

  it('scegliere l\'italiano lo salva sulla persona e cambia la lingua del portale', async () => {
    const saved: unknown[] = []
    const save: GqlMock = {
      request: { query: SET_MY_LANGUAGE, variables: (v) => { saved.push(v); return true } },
      result: { data: { setMyLanguage: { __typename: 'User', id: 'u1', language: 'it' } } },
    }
    const { user } = renderWithProviders(<PortalLanguageSelect />, { mocks: [me(null), settings, save, me('it')] })
    const select = await screen.findByRole('combobox', { name: 'Language' })
    await waitFor(() => expect(select).toHaveValue('organization'))
    await user.selectOptions(select, 'it')
    await waitFor(() => expect(i18n.language).toBe('it'))
    expect(saved).toEqual([{ language: 'it' }])
  })
})
