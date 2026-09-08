import { describe, it, expect, afterEach } from 'vitest'
import { api, apiUrl, authHeader, GRAPHQL_URI } from './api'
import { mockKeycloak, TEST_TOKEN } from '@/test/mocks/keycloak'

afterEach(() => { mockKeycloak.token = TEST_TOKEN })

describe('lib/api', () => {
  it('GRAPHQL_URI viene da VITE_API_URL e la base REST è la stessa origin senza /graphql', () => {
    expect(GRAPHQL_URI).toBe('/graphql')
    expect(api.baseUrl).toBe('')
  })

  it('apiUrl compone path relativi; un path senza "/" iniziale è un errore', () => {
    expect(apiUrl('/api/attachments')).toBe('/api/attachments')
    expect(apiUrl('/api/logs/client')).toBe('/api/logs/client')
    expect(() => apiUrl('api/attachments')).toThrow('apiUrl: il path deve iniziare con "/" (ricevuto "api/attachments")')
  })

  it('authHeader legge il token Keycloak corrente: presente → Bearer, assente → header vuoto', () => {
    expect(authHeader()).toEqual({ authorization: `Bearer ${TEST_TOKEN}` })
    mockKeycloak.token = undefined
    expect(authHeader()).toEqual({})
    mockKeycloak.token = 'fresh'
    expect(authHeader()).toEqual({ authorization: 'Bearer fresh' })
  })
})
