/**
 * LE CHIAMATE ALLA CONSOLE. REST, non GraphQL: lo schema del prodotto è legato
 * a un tenant e la console non ne ha uno (vedi `rest/platform-tenants.ts`).
 *
 * Il token va SEMPRE messo: senza, l'API risponde 401 e la pagina mostrerebbe
 * «non autorizzato» facendo pensare a un problema di permessi invece che a una
 * chiamata scritta male.
 */
import { keycloak } from './keycloak'
import { refreshToken } from './tokenRefresh'

/** Il messaggio leggibile di una risposta non riuscita, in tutte le forme che l'API usa. */
async function messaggioDErrore(res: Response): Promise<string> {
  const fallback = `HTTP ${res.status}`
  let body: unknown
  try {
    body = await res.json()
  } catch {
    // Corpo non JSON (una pagina di nginx, per esempio): resta il codice.
    return fallback
  }
  if (typeof body !== 'object' || body === null) return fallback
  const b = body as { error?: unknown; message?: unknown }
  if (typeof b.error === 'string' && b.error !== '') return b.error
  if (typeof b.error === 'object' && b.error !== null) {
    const e = b.error as { message?: unknown; code?: unknown }
    if (typeof e.message === 'string' && e.message !== '') return e.message
    if (typeof e.code === 'string' && e.code !== '') return `${fallback} (${e.code})`
  }
  if (typeof b.message === 'string' && b.message !== '') return b.message
  return fallback
}

/**
 * IL MESSAGGIO DA MOSTRARE PER UN MOTIVO DI RIFIUTO QUALSIASI.
 *
 * `String(e)` su un oggetto dà «[object Object]», e ci si finisce spesso: un
 * `updateToken()` di Keycloak rifiuta con `{ error, error_description }`, non
 * con un `Error`. Una pagina che crea e cancella tenant non può mostrare
 * «[object Object]» al posto del motivo: chi guarda non sa se l'azione è
 * passata.
 */
export function messaggio(e: unknown): string {
  if (e instanceof Error && e.message !== '') return e.message
  if (typeof e === 'string' && e !== '') return e
  if (typeof e === 'object' && e !== null) {
    const o = e as { error_description?: unknown; error?: unknown; message?: unknown }
    for (const v of [o.error_description, o.message, o.error]) {
      if (typeof v === 'string' && v !== '') return v
    }
  }
  // Ultima spiaggia: dire che non si sa, invece di mostrare una forma vuota.
  return 'Unexpected error (no message)'
}

export interface Tenant {
  id: string
  slug: string
  name: string
  plan: string | null
  timezone: string | null
  stato: 'active' | 'suspended'
  suspendedAt: string | null
  createdAt: string | null
  /** `null` = il conteggio non si è potuto fare. NON è uno zero. */
  utenti: number | null
  ticket: number | null
  /** `null` = il modello dell'indirizzo non è configurato su questa installazione. */
  appUrl: string | null
  portalUrl: string | null
  /** Gli amministratori attivi: vuota = in questo tenant non entra nessuno. */
  admins: string[]
}

export interface EsitoResetPassword {
  email: string
  /** Mostrata UNA volta, come alla creazione: non è scritta da nessuna parte. */
  temporaryPassword: string
  /** La password è valida, ma finché il tenant è sospeso nessuno entra. */
  tenantSospeso: boolean
}

async function chiama<T>(path: string, init?: RequestInit): Promise<T> {
  /*
   * IL TOKEN SI RINNOVA PRIMA DI OGNI CHIAMATA, se gli restano meno di 30
   * secondi. Il ciclo di fondo (`startTokenRefreshLoop`) non basta: un clic che
   * cade nei secondi fra la scadenza e il giro successivo tornava
   * «Unauthorized», e su una pagina che crea e cancella tenant un errore di
   * autorizzazione fa pensare a un problema di permessi, non a un token
   * vecchio. `refreshToken` è condiviso fra le chiamate in volo, quindi non
   * costa una richiesta per azione.
   */
  try {
    await refreshToken(30)
  } catch (e: unknown) {
    // Senza questo, un rinnovo fallito arrivava alla pagina come oggetto nudo.
    throw new Error(`Could not refresh the session: ${messaggio(e)}`)
  }
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${keycloak.token ?? ''}`,
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    /*
     * IL CORPO DELL'ERRORE HA DUE FORME, e leggerne una sola dava
     * «[object Object]» a schermo (17 set 2026):
     *
     *  - `restErrorHandler` dell'API risponde `{ error: { code, message } }`;
     *  - le rotte della console rispondono `{ error: "…" }` per i rifiuti che
     *    scrivono da sé (azione sconosciuta, conferma mancante).
     *
     * Leggere `body.error` come stringa, sulla prima forma, produceva un
     * oggetto dentro `new Error(...)`. E «[object Object]» a schermo non è un
     * messaggio: è un errore nel percorso degli errori, cioè il posto in cui
     * si finisce quando qualcosa è già andato storto.
     */
    throw new Error(await messaggioDErrore(res))
  }
  return await res.json() as T
}

export interface NuovoTenant {
  slug: string
  name: string
  plan: string
  timezone: string
  adminEmail: string
  adminFirstName: string
  adminLastName: string
}

export interface EsitoCreazione {
  slug: string
  /** Mostrata UNA volta e non più recuperabile: non è scritta da nessuna parte. */
  temporaryPassword: string | null
  steps: string[]
}

export const api = {
  create:    (t: NuovoTenant)             => chiama<EsitoCreazione>('/platform/tenants', { method: 'POST', body: JSON.stringify(t) }),
  tenants:   ()                          => chiama<{ tenants: Tenant[] }>('/platform/tenants'),
  footprint: (slug: string)              => chiama<{ slug: string; nodes: Record<string, number> }>(`/platform/tenants/${encodeURIComponent(slug)}/footprint`),
  rename:    (slug: string, name: string) => chiama<{ tenants: Tenant[] }>(`/platform/tenants/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify({ action: 'rename', name }) }),
  suspend:   (slug: string)              => chiama<{ tenants: Tenant[] }>(`/platform/tenants/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify({ action: 'suspend' }) }),
  resume:    (slug: string)              => chiama<{ tenants: Tenant[] }>(`/platform/tenants/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify({ action: 'resume' }) }),
  /*
   * POST e non PATCH: non c'è niente di idempotente in una password nuova, e
   * la risposta porta un segreto — tenerla su una rotta sua rende ovvio, dalla
   * lista qui sotto, quale risposta non va registrata né messa in cache.
   */
  resetPassword: (slug: string, email: string) => chiama<EsitoResetPassword>(`/platform/tenants/${encodeURIComponent(slug)}/admin-password`, { method: 'POST', body: JSON.stringify({ email }) }),
  purge:     (slug: string, confirm: string) => chiama<{ slug: string; nodiCancellati: number; realmCancellato: boolean }>(`/platform/tenants/${encodeURIComponent(slug)}`, { method: 'DELETE', body: JSON.stringify({ confirm }) }),
}
