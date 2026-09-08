/**
 * Setup globale dei test del portale (vitest + jsdom + Testing Library):
 * matcher jest-dom, Keycloak finto (`keycloak-js` e `@/lib/keycloak`), stub
 * delle API browser assenti in jsdom, i18n forzato a `en`.
 */
import '@testing-library/jest-dom/vitest'
import { vi, beforeAll, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import i18n from '@/i18n/i18n'

vi.mock('keycloak-js', async () => {
  const m = await import('./mocks/keycloak')
  return { default: m.FakeKeycloak }
})

vi.mock('@/lib/keycloak', async () => {
  const m = await import('./mocks/keycloak')
  return {
    keycloak:      m.mockKeycloak,
    getKeycloak:   () => m.mockKeycloak,
    initKeycloak:  vi.fn(async () => true),
    getTenantSlug: () => 'test-tenant',
  }
})

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }),
  })
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: ResizeObserverStub })
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', { writable: true, value: () => 'blob:test' })
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: () => {} })
}

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
  document.getElementById('portal-error-host')?.remove()
})
