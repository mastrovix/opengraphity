/**
 * L'AVVIO DEL PORTALE.
 *
 * `initKeycloak` fallisce per: nessun tenant nel sottodominio, `VITE_KEYCLOAK_URL`
 * o `VITE_KEYCLOAK_CLIENT_ID` mancanti, realm sconosciuto, Keycloak
 * irraggiungibile — e il messaggio porta già la causa. Senza questo `catch`
 * chi apre il portale vede una pagina bianca, che e' il modo peggiore di
 * dire «non funziona».
 *
 * Il dettaglio si scrive come TESTO: puo' contenere l'hostname o l'indirizzo
 * che qualcuno ha digitato, e un portale che interpreta HTML e' un portale
 * che si buca.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const initKeycloak = vi.hoisted(() => vi.fn())
const login = vi.hoisted(() => vi.fn())
const startTokenRefreshLoop = vi.hoisted(() => vi.fn())
const render = vi.hoisted(() => vi.fn())
const createRoot = vi.hoisted(() => vi.fn(() => ({ render })))

vi.mock('@/lib/keycloak', () => ({ initKeycloak, keycloak: { login }, getKeycloak: () => ({ login }) }))
vi.mock('@/lib/tokenRefresh', () => ({ startTokenRefreshLoop }))
vi.mock('@/lib/apollo', () => ({ apolloClient: { link: {}, cache: {} } }))
vi.mock('react-dom/client', () => ({ createRoot }))
vi.mock('@/index.css', () => ({}))

/** Carica `main.tsx` da zero su un #root pulito, e lascia sfogare la catena di promesse. */
async function avvia() {
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
  await import('./main')
  await new Promise((r) => setTimeout(r, 0))
  return document.getElementById('root')!
}

beforeEach(() => {
  initKeycloak.mockReset(); login.mockReset()
  startTokenRefreshLoop.mockReset(); render.mockReset(); createRoot.mockReset()
  createRoot.mockReturnValue({ render })
})
afterEach(() => { document.body.innerHTML = '' })

describe('avvio riuscito', () => {
  it('tiene fresco il token e monta l\'applicazione', async () => {
    // Senza il ciclo, il portale funziona solo nella finestra fra il login e
    // la prima scadenza del token (E-05).
    initKeycloak.mockResolvedValue(true)
    await avvia()
    expect(startTokenRefreshLoop).toHaveBeenCalledOnce()
    expect(render).toHaveBeenCalledOnce()
  })
})

describe('quando non si parte', () => {
  it('non autenticato va al login, e non monta niente', async () => {
    initKeycloak.mockResolvedValue(false)
    await avvia()
    expect(login).toHaveBeenCalledOnce()
    expect(render).not.toHaveBeenCalled()
    expect(startTokenRefreshLoop).not.toHaveBeenCalled()
  })

  it('un avvio fallito SCRIVE il motivo invece di lasciare la pagina bianca', async () => {
    initKeycloak.mockRejectedValue(new Error('VITE_KEYCLOAK_URL is not configured'))
    const root = await avvia()
    expect(root.textContent).toContain('VITE_KEYCLOAK_URL is not configured')
    expect(root.children.length).toBeGreaterThan(0)
    expect(render).not.toHaveBeenCalled()
  })

  it('un rifiuto che non e\' un Error si legge lo stesso', async () => {
    initKeycloak.mockRejectedValue({ error: 'invalid_request' })
    const root = await avvia()
    expect(root.textContent).not.toBe('')
  })

  it('il dettaglio e\' TESTO: puo\' riportare l\'indirizzo che qualcuno ha digitato', async () => {
    initKeycloak.mockRejectedValue(new Error('<img src=x onerror="alert(1)"> host < unknown'))
    const root = await avvia()
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(root.textContent).toContain('host < unknown')
  })

  it('la schermata sostituisce quello che c\'era', async () => {
    initKeycloak.mockRejectedValue(new Error('down'))
    document.body.innerHTML = '<div id="root"><p>vecchio</p></div>'
    const root = await avvia()
    expect(root.textContent).not.toContain('vecchio')
  })
})
