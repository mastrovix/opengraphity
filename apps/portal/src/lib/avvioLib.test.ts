/**
 * COME IL PORTALE SI COLLEGA: Keycloak, il rinnovo del token e Apollo.
 *
 * Tre involucri sottili su `@opengraphity/web-core`, e in tutti e tre quello
 * che conta e' cosa il portale DECIDE, non cosa delega:
 *
 *  - nessun ripiego. Un `VITE_KEYCLOAK_URL` mancante ricadeva su
 *    `window.location.origin` e un client id mancante su «opengrafo-portal»:
 *    una build configurata male si nascondeva dietro una pagina d'errore di
 *    Keycloak invece di dire quale variabile manca.
 *  - un tenant sospeso e' DEFINITIVO: si ferma e lo dice, invece di
 *    rimbalzare fra portale e Keycloak per sempre (17 set 2026).
 *  - un errore non si inghiotte MAI: il portale non ha una gestione per
 *    pagina, quindi un errore ignorato si legge «nessun ticket» o «non
 *    trovato».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createKeycloak = vi.hoisted(() => vi.fn(() => ({ initKeycloak: vi.fn(), getKeycloak: vi.fn(), keycloak: { token: 'tok' } })))
const createTokenRefresh = vi.hoisted(() => vi.fn(() => ({ refreshToken: vi.fn(), isSessionInvalid: vi.fn(), forceLogin: vi.fn(), startTokenRefreshLoop: vi.fn() })))
const createApolloClient = vi.hoisted(() => vi.fn(() => ({ __client: true })))
const mostraSchermataDiStop = vi.hoisted(() => vi.fn())
const requireTenantSlug = vi.hoisted(() => vi.fn(() => 'c-one'))
const notifyError = vi.hoisted(() => vi.fn())
const notifyInfo = vi.hoisted(() => vi.fn())

vi.mock('@opengraphity/web-core', () => ({
  createKeycloak, createTokenRefresh, createApolloClient, mostraSchermataDiStop, requireTenantSlug,
  createApiBase: () => ({ baseUrl: '', apiUrl: (p: string) => p, authHeader: () => ({}) }),
  createClientLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  createAttachments: () => ({ uploadFormDraftFile: vi.fn(), uploadAttachment: vi.fn(), downloadAttachment: vi.fn() }),
  apiBaseFromGraphqlUri: (u: string) => u.replace(/\/graphql$/, ''),
}))
vi.mock('./notify', () => ({ notifyError, notifyInfo }))
/**
 * Il setup globale sostituisce `@/lib/keycloak` con un Keycloak finto: qui si
 * prova PROPRIO quel modulo, quindi si annulla la sostituzione.
 */
vi.unmock('@/lib/keycloak')

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllEnvs() })

describe('keycloak', () => {
  it('passa le variabili del build cosi\' come sono: nessun ripiego', async () => {
    vi.stubEnv('VITE_KEYCLOAK_URL', 'https://kc.example.com')
    vi.stubEnv('VITE_KEYCLOAK_CLIENT_ID', 'og-portal')
    await import('./keycloak')
    expect(createKeycloak.mock.calls.at(-1)![0]).toMatchObject({
      url: 'https://kc.example.com', clientId: 'og-portal',
    })
  })

  it('una variabile mancante resta `undefined`, cosi\' l\'errore la nomina', async () => {
    // Ricadere su `window.location.origin` nascondeva la build sbagliata.
    vi.stubEnv('VITE_KEYCLOAK_URL', '')
    vi.stubEnv('VITE_KEYCLOAK_CLIENT_ID', '')
    await import('./keycloak')
    const opts = createKeycloak.mock.calls.at(-1)![0] as { url?: string; clientId?: string }
    expect(opts.url).toBeFalsy()
    expect(opts.clientId).toBeFalsy()
  })

  it('il realm e\' il tenant: dall\'override se c\'e\', se no dall\'indirizzo', async () => {
    vi.stubEnv('VITE_TENANT_SLUG', 'c-due')
    const mod = await import('./keycloak')
    expect(mod.getTenantSlug()).toBe('c-one')   // lo risolve web-core
    expect(requireTenantSlug.mock.calls.at(-1)![0]).toMatchObject({
      hostname: window.location.hostname, override: 'c-due', hint: 'portal.c-one.localhost',
    })
  })
})

describe('il rinnovo del token', () => {
  it('usa l\'implementazione condivisa, con i messaggi tradotti', async () => {
    // Il portale faceva `updateToken(60).catch(() => keycloak.login())` ogni
    // trenta secondi: un singhiozzo di rete verso Keycloak rimandava al
    // login e perdeva il modulo che si stava compilando.
    await import('./tokenRefresh')
    const opts = createTokenRefresh.mock.calls.at(-1)![0] as {
      notify: { error: (m: string) => void; success: (m: string) => void }
      messages: Record<string, (s?: number) => string>
    }
    expect(typeof opts.messages['sessionExpired']()).toBe('string')
    expect(typeof opts.messages['authServerUnreachable'](8)).toBe('string')
    opts.notify.error('giù')
    opts.notify.success('tornato')
    expect(notifyError).toHaveBeenCalledWith('giù')
    expect(notifyInfo).toHaveBeenCalledWith('tornato')
  })
})

describe('apollo', () => {
  it('il polling non e\' un default globale: lo chiedono solo due pagine', async () => {
    // `me`, la KB, il catalogo e le regole dei campi non devono rifarsi ogni
    // trenta secondi in ogni scheda aperta.
    const mod = await import('./apollo')
    expect(mod.TICKET_POLL_INTERVAL_MS).toBe(30_000)
    const opts = createApolloClient.mock.calls.at(-1)![0] as { defaultOptions?: { watchQuery?: { pollInterval?: number } } }
    expect(opts.defaultOptions?.watchQuery?.pollInterval).toBeUndefined()
  })

  it('un errore GraphQL si mostra SEMPRE: qui non c\'e\' una gestione per pagina', async () => {
    await import('./apollo')
    const opts = createApolloClient.mock.calls.at(-1)![0] as {
      onGraphQLError: (m: string) => void; onNetworkError: () => void
      traduciErrore: (k: string, p?: Record<string, unknown>) => string | null
    }
    opts.onGraphQLError('Qualcosa è andato storto')
    expect(notifyError).toHaveBeenCalledWith('Qualcosa è andato storto')
    opts.onNetworkError()
    expect(notifyError).toHaveBeenCalledTimes(2)
  })

  it('una chiave senza traduzione torna null, cosi\' resta il messaggio del server', async () => {
    await import('./apollo')
    const { traduciErrore } = createApolloClient.mock.calls.at(-1)![0] as { traduciErrore: (k: string) => string | null }
    expect(traduciErrore('errors.chiave.che.non.esiste')).toBeNull()
    expect(traduciErrore('errors.network')).toBeTruthy()
  })

  it('un tenant SOSPESO ferma il portale e lo dice, invece di rimbalzare al login', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    await import('./apollo')
    const { onTenantSuspended } = createApolloClient.mock.calls.at(-1)![0] as { onTenantSuspended: () => void }
    onTenantSuspended()
    expect(mostraSchermataDiStop).toHaveBeenCalledWith(expect.objectContaining({
      root: document.getElementById('root'),
      titolo: expect.any(String) as unknown as string,
      dettaglio: expect.any(String) as unknown as string,
    }))
  })

  it('senza un #root non si schianta: non c\'e\' niente da fermare', async () => {
    document.body.innerHTML = ''
    await import('./apollo')
    const { onTenantSuspended } = createApolloClient.mock.calls.at(-1)![0] as { onTenantSuspended: () => void }
    mostraSchermataDiStop.mockClear()
    expect(() => { onTenantSuspended() }).not.toThrow()
    expect(mostraSchermataDiStop).not.toHaveBeenCalled()
  })
})
