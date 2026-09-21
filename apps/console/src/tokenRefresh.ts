/**
 * IL RINNOVO DEL TOKEN (17 set 2026).
 *
 * Mancava, e si è visto subito: la console si apriva, l'elenco arrivava, e
 * pochi minuti dopo ogni azione rispondeva «Unauthorized» — nei log dell'API
 * `reason: "jwt expired"`. Un access token vive pochi minuti: senza questo
 * ciclo la console funziona solo nella finestra fra il login e la prima
 * scadenza, che è il modo peggiore di rompersi perché sembra un problema di
 * permessi.
 *
 * Si usa la stessa implementazione di web e portale
 * (`createTokenRefresh` in `@opengraphity/web-core`): rinnovo condiviso fra
 * chiamate contemporanee, attesa crescente su un guasto di rete, e ritorno al
 * login SOLO quando la sessione è davvero morta. Scrivere qui un
 * `updateToken().catch(login)` ogni trenta secondi avrebbe rimandato al login
 * al primo singhiozzo di rete, in mezzo a una creazione di tenant.
 *
 * I messaggi sono in inglese come il resto della console, e non passano da
 * i18n: questa pagina non la vede un cliente.
 */
import { createTokenRefresh, consoleLogger } from '@opengraphity/web-core'
import { keycloak } from './keycloak'

/** Dove la console mostra gli avvisi del rinnovo: lo decide la pagina. */
type Avviso = (messaggio: string) => void
let mostraErrore: Avviso = () => { /* prima che la pagina si monti: solo console */ }
let mostraRipresa: Avviso = () => { /* idem */ }

export function collegaAvvisi(errore: Avviso, ripresa: Avviso): void {
  mostraErrore = errore
  mostraRipresa = ripresa
}

const tokenRefresh = createTokenRefresh({
  keycloak,
  // `consoleLogger` di web-core: il default dichiarato per le app senza un
  // raccoglitore di log remoto. La console non ne ha uno — e non lo vuole: i
  // log del client finirebbero in `/logs/client`, che è legato a un tenant.
  logger: consoleLogger,
  notify: {
    error:   (message) => mostraErrore(message),
    success: (message) => mostraRipresa(message),
  },
  messages: {
    sessionExpired:        () => 'Session expired — signing in again',
    authServerRestored:    () => 'Connection to Keycloak restored',
    authServerUnreachable: (seconds) => `Keycloak unreachable — retrying in ${seconds}s`,
  },
})

export const refreshToken          = tokenRefresh.refreshToken
export const startTokenRefreshLoop = tokenRefresh.startTokenRefreshLoop
