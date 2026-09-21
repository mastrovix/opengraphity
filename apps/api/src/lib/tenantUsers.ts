/**
 * LE PERSONE DI UN'ORGANIZZAZIONE: nascita e disattivazione, in Keycloak e nel grafo
 * (revisione totale del 16 set 2026 · A-2, A-3, A-13, M-6).
 *
 * ## I difetti
 * - «Nuova persona» con l'e-mail di qualcuno che c'era già: Keycloak rispondeva
 *   409, l'API lo accettava e proseguiva — **reimpostava la password** di
 *   quell'account e, con `MERGE … ON MATCH SET`, gli sovrascriveva nome e ruolo.
 *   Un refuso poteva degradare un amministratore a viewer e cambiargli la password.
 * - L'e-mail non era normalizzata: Keycloak la salva minuscola, il grafo come
 *   era scritta, e l'autenticazione confrontava esattamente → «user not found».
 * - Una persona non si poteva disattivare: nessuna operazione scriveva
 *   `active = false`, e l'autenticazione non lo leggeva.
 *
 * ## Le regole (scelte del proprietario, 16 set 2026)
 * - un'e-mail già presente (nel grafo o nel realm) è un errore e **non si tocca
 *   nulla**;
 * - l'e-mail si scrive minuscola, ovunque;
 * - «Disattiva» spegne l'account nel realm, chiude le sue sessioni e mette
 *   `active = false`; l'autenticazione rifiuta una persona disattivata anche con
 *   un token ancora valido. Storico e ticket restano. Si può riattivare.
 */
import { config } from './config.js'
import { ValidationError } from './errors.js'
import { logger } from './logger.js'
import { createKeycloakAdmin, type KeycloakAdmin } from '../scripts/lib/keycloakAdmin.js'

let clientForTests: KeycloakAdmin | null = null
/** Solo per i test. */
export function setUsersKeycloakAdminForTests(kc: KeycloakAdmin | null): void { clientForTests = kc }

async function admin(): Promise<{ kc: KeycloakAdmin; token: string }> {
  const kc = clientForTests ?? createKeycloakAdmin({
    baseUrl: config.keycloakUrl.replace(/\/+$/, ''), adminUser: config.keycloakAdminUser, adminPassword: config.keycloakAdminPassword,
  })
  return { kc, token: await kc.getAdminToken() }
}

const usersPath = (tenantId: string) => `/admin/realms/${encodeURIComponent(tenantId)}/users`

// Volutamente semplice: un indirizzo con una sola @, una parte locale e un dominio con un punto.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** L'e-mail come la scrivono grafo e realm: senza spazi attorno, minuscola, ben formata. */
export function normalizeEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError(`"${String(raw)}" is not an e-mail address`, { key: 'errors.user.emailInvalid', params: { email: String(raw ?? '') } })
  }
  return email
}

export function emailTakenError(email: string): ValidationError {
  return new ValidationError(
    `A person with the e-mail ${email} already exists: nothing was changed`,
    { key: 'errors.user.emailExists', params: { email } },
  )
}

/**
 * Crea l'account nel realm con la password. 409 (e-mail o username già usati) →
 * errore «esiste già», senza toccare l'account esistente. Un rifiuto di
 * Keycloak sulla password (policy del realm) arriva con il suo messaggio.
 */
export async function createRealmUser(
  tenantId: string, input: { email: string; name: string; password: string },
): Promise<string> {
  const { kc, token } = await admin()
  const [firstName, ...rest] = input.name.trim().split(/\s+/)
  let result: { id?: string; created: boolean }
  try {
    result = await kc.post(token, usersPath(tenantId), {
      username: input.email, email: input.email, emailVerified: true, enabled: true,
      firstName: firstName ?? input.name, lastName: rest.join(' '),
      credentials: [{ type: 'password', value: input.password, temporary: false }],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const m = /→ 400: (.*)$/s.exec(message)
    if (m) {
      let reason = m[1] ?? ''
      try { reason = (JSON.parse(reason) as { errorMessage?: string; error?: string }).errorMessage ?? reason } catch { /* testo semplice */ }
      throw new ValidationError(`Keycloak refused the new account: ${reason}`, { key: 'errors.user.keycloakRefused', params: { reason } })
    }
    throw err
  }
  if (!result.created) throw emailTakenError(input.email)
  if (result.id) return result.id
  const found = await findRealmUserId(kc, token, tenantId, input.email)
  if (!found) throw new Error(`Keycloak created ${input.email} in realm ${tenantId} but the account cannot be found`)
  return found
}

/** Compensazione: se il grafo rifiuta la persona appena creata nel realm, l'account non resta orfano. */
export async function deleteRealmUser(tenantId: string, keycloakUserId: string): Promise<void> {
  const { kc, token } = await admin()
  await kc.delete(token, `${usersPath(tenantId)}/${encodeURIComponent(keycloakUserId)}`)
}

/**
 * Accende o spegne l'account nel realm; spegnendolo chiude anche le sessioni
 * aperte. Un account che nel realm non c'è (persona nata da uno script senza
 * realm, o già rimossa) non è un errore in nessuna delle due direzioni: il
 * grafo basta a rifiutare l'accesso, e riattivare una persona così la riporta
 * nell'app senza inventarle un account — chi l'ha creata senza realm gliene
 * darà uno. Il caso si dice nel log, e l'esito («missing») arriva all'Audit Log.
 */
export async function setRealmUserEnabled(tenantId: string, email: string, enabled: boolean): Promise<'updated' | 'missing'> {
  const { kc, token } = await admin()
  const id = await findRealmUserId(kc, token, tenantId, email)
  if (!id) {
    logger.warn({ email, tenantId, enabled }, '[tenantUsers] the person has no account in the login realm: only the graph was updated')
    return 'missing'
  }
  const path = `${usersPath(tenantId)}/${encodeURIComponent(id)}`
  await kc.put(token, path, { enabled })
  if (!enabled) await kc.post(token, `${path}/logout`, {})
  return 'updated'
}

async function findRealmUserId(kc: KeycloakAdmin, token: string, tenantId: string, email: string): Promise<string | null> {
  const users = await kc.get<Array<{ id: string; email?: string }>>(token, `${usersPath(tenantId)}?email=${encodeURIComponent(email)}&exact=true`)
  const match = users.filter((u) => (u.email ?? '').toLowerCase() === email)
  if (match.length > 1) throw new Error(`Realm ${tenantId} has ${match.length} accounts with e-mail ${email}`)
  return match[0]?.id ?? null
}
