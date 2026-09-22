/**
 * WHAT HAPPENS WHEN THE CONSOLE CANNOT START.
 *
 * The stop page is the one screen somebody sees when the build variables are
 * wrong or Keycloak is unreachable, and it is written with `textContent` and
 * not `innerHTML` on purpose: the message can carry text we do not control,
 * and a console that interprets HTML is a console that can be broken into.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const initKeycloak = vi.hoisted(() => vi.fn())
const login = vi.hoisted(() => vi.fn())
const startTokenRefreshLoop = vi.hoisted(() => vi.fn())
const render = vi.hoisted(() => vi.fn())
const createRoot = vi.hoisted(() => vi.fn(() => ({ render })))

vi.mock('./keycloak', () => ({ initKeycloak, keycloak: { login } }))
vi.mock('./tokenRefresh', () => ({ startTokenRefreshLoop }))
vi.mock('./TenantsPage', () => ({ TenantsPage: () => null }))
vi.mock('react-dom/client', () => ({ createRoot }))
vi.mock('./index.css', () => ({}))

/** Loads `main.tsx` fresh against a clean #root and waits for its promise chain. */
async function avvia() {
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
  await import('./main')
  // The module's work hangs off a promise: let the microtasks drain.
  await new Promise((r) => setTimeout(r, 0))
  return document.getElementById('root')!
}

beforeEach(() => {
  initKeycloak.mockReset(); login.mockReset()
  startTokenRefreshLoop.mockReset(); render.mockReset(); createRoot.mockReset()
  createRoot.mockReturnValue({ render })
})
afterEach(() => { document.body.innerHTML = '' })

describe('a successful start', () => {
  it('keeps the token fresh and renders the page', async () => {
    // The refresh loop was missing once: the console worked for the first
    // few minutes after the login and then answered "Unauthorized" to every
    // action, with `jwt expired` in the API logs.
    initKeycloak.mockResolvedValue(true)
    await avvia()
    expect(startTokenRefreshLoop).toHaveBeenCalledOnce()
    expect(render).toHaveBeenCalledOnce()
  })
})

describe('when it cannot start', () => {
  it('not authenticated goes to the login, and renders nothing in the meantime', async () => {
    initKeycloak.mockResolvedValue(false)
    await avvia()
    expect(login).toHaveBeenCalledOnce()
    expect(render).not.toHaveBeenCalled()
    expect(startTokenRefreshLoop).not.toHaveBeenCalled()
  })

  it('a failed init writes why, and stops: no retry, no fallback', async () => {
    initKeycloak.mockRejectedValue(new Error('VITE_PLATFORM_REALM is not set'))
    const root = await avvia()
    expect(root.textContent).toContain('The platform console cannot start')
    expect(root.textContent).toContain('VITE_PLATFORM_REALM is not set')
    expect(render).not.toHaveBeenCalled()
  })

  it('a rejection that is not an Error is still readable', async () => {
    initKeycloak.mockRejectedValue({ error: 'invalid_request' })
    const root = await avvia()
    expect(root.textContent).toContain('The platform console cannot start')
  })

  it('the message is written as TEXT: a console that interprets HTML can be broken into', async () => {
    // It can carry text we do not control — a Keycloak error, a proxy page.
    initKeycloak.mockRejectedValue(new Error('<img src=x onerror="alert(1)"> realm < missing'))
    const root = await avvia()
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(root.textContent).toContain('realm < missing')
  })

  it('the stop page replaces whatever was there, and is announced as an error', async () => {
    initKeycloak.mockRejectedValue(new Error('down'))
    const root = await avvia()
    expect(root.querySelector('h1')?.textContent).toBe('The platform console cannot start')
    expect(root.querySelector('.errore')?.textContent).toBe('down')
  })
})
