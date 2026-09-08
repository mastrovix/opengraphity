/**
 * Setup globale dei test (vitest + jsdom + Testing Library).
 *
 * - matcher jest-dom (`toBeInTheDocument`, `toHaveAttribute`, …);
 * - `keycloak-js` e `@/lib/keycloak` sostituiti da un'istanza finta (nessuna
 *   rete, token fisso, `updateToken` risolto): nessun test dipende da Keycloak;
 * - stub delle API browser assenti in jsdom (matchMedia, ResizeObserver,
 *   scrollIntoView, createObjectURL) usate da ECharts / React Flow / D3 /
 *   export CSV;
 * - i18n dell'app forzato a `en` così le asserzioni sui testi sono deterministiche
 *   (il LanguageDetector leggerebbe navigator/localStorage).
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

// ── Stub API browser assenti in jsdom ────────────────────────────────────────

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: ResizeObserverStub })
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', { writable: true, value: () => 'blob:test' })
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: () => {} })
}

// jsdom non calcola il layout: `offsetParent` è sempre null e il focus trap di
// Modal (che scarta gli elementi non visibili) non troverebbe nulla. Un elemento
// connesso al documento è considerato visibile.
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get(this: HTMLElement) { return this.isConnected ? this.parentElement : null },
})

// ── i18n deterministico ──────────────────────────────────────────────────────

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})
