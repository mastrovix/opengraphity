/**
 * L'ACCESSO DI UN'ORGANIZZAZIONE (ondata 8 di «Nulla cablato»).
 *
 * Ogni organizzazione ha il suo realm Keycloak (la chiave del realm è quella
 * dell'organizzazione). Prima regole delle password e login aziendale si
 * cambiavano solo nella console di Keycloak, fuori dal prodotto. Qui la pagina
 * dell'admin li scrive nel SUO realm, e il realm resta la fonte: si legge da lì.
 *
 * Scelte del proprietario (15 set 2026):
 *  - chi entra con Microsoft/Google/SAML ma non esiste in OpenGrafo è
 *    RIFIUTATO: il primo accesso da un provider passa dal flusso
 *    `opengrafo-existing-users-only` (utente esistente con la stessa e-mail →
 *    collegato; nessuno → rifiutato), mai dalla creazione automatica;
 *  - le password RESTANO accanto al login aziendale: nessun flusso di login
 *    cambia, l'admin ha sempre il suo accesso di emergenza.
 *
 * Mie scelte:
 *  - il segreto di un provider sta solo in Keycloak e non esce mai; per questo
 *    ATTIVARE un provider chiede il segreto e lo prova in quel momento
 *    (`testLoginProvider`): un provider salvato senza prova resta spento;
 *  - il blocco dopo troppi tentativi è sempre temporaneo (mai permanente).
 */
import { PASSWORD_RULE_RANGES } from '@opengraphity/types'
import { config } from './config.js'
import { ValidationError } from './errors.js'
import { assertSafeOutboundUrl } from './safeUrl.js'
import { createKeycloakAdmin, type KeycloakAdmin } from '../scripts/lib/keycloakAdmin.js'

export const LOGIN_PROVIDER_KINDS = ['microsoft', 'google', 'saml'] as const
export type LoginProviderKind = (typeof LOGIN_PROVIDER_KINDS)[number]

export const EXISTING_USERS_FLOW = 'opengrafo-existing-users-only'

// ── Keycloak ────────────────────────────────────────────────────────────────────

let clientForTests: KeycloakAdmin | null = null
/** Solo per i test. */
export function setKeycloakAdminForTests(kc: KeycloakAdmin | null): void { clientForTests = kc }

async function admin(): Promise<{ kc: KeycloakAdmin; token: string }> {
  const kc = clientForTests ?? createKeycloakAdmin({
    baseUrl: config.keycloakUrl.replace(/\/+$/, ''), adminUser: config.keycloakAdminUser, adminPassword: config.keycloakAdminPassword,
  })
  return { kc, token: await kc.getAdminToken() }
}

const realmPath = (tenantId: string) => `/admin/realms/${encodeURIComponent(tenantId)}`

/** L'indirizzo pubblico di Keycloak, quello che i provider esterni vedono. */
/**
 * Every origin through which people reach the sign-in page (KEYCLOAK_PUBLIC_URL
 * is a list: local, Tailscale, the public domain). Keycloak builds its broker
 * addresses from the origin the browser used, so a corporate provider needs
 * each of them registered (tour of 23 Sep 2026, D71: the page showed only the
 * first, `http://localhost:8080/...`, useless to register at Microsoft).
 */
function keycloakPublicUrls(): string[] {
  const urls = config.keycloakPublicUrls.map((u) => u.replace(/\/+$/, ''))
  if (urls.length === 0) throw new Error('KEYCLOAK_PUBLIC_URL has no URL')
  return urls
}

// ── Regole delle password ─────────────────────────────────────────────────────

export interface PasswordRules {
  minLength:       number
  uppercase:       number
  lowercase:       number
  digits:          number
  special:         number
  notUsername:     boolean
  notEmail:        boolean
  /** Quante password precedenti non si possono riusare (0 = nessun controllo). */
  history:         number
  /** Dopo quanti giorni la password va cambiata (0 = mai). */
  expireDays:      number
  lockoutEnabled:  boolean
  /** Tentativi sbagliati prima del blocco temporaneo. */
  lockoutFailures: number
  /** Durata massima del blocco, in minuti. */
  lockoutMinutes:  number
}

// Gli intervalli stanno in @opengraphity/types: li usa anche la pagina
// «Accesso», e due copie a mano derivano (revisione totale · G-25).
export { PASSWORD_RULE_RANGES }

/** I token di `passwordPolicy` che questa pagina governa; gli altri (es. hashAlgorithm) si conservano. */
const MANAGED_TOKENS = ['length', 'upperCase', 'lowerCase', 'digits', 'specialChars', 'notUsername', 'notEmail', 'passwordHistory', 'forceExpiredPasswordChange'] as const

interface PolicyToken { name: string; arg: string | null }

export function parsePasswordPolicy(policy: string | null | undefined): PolicyToken[] {
  if (!policy?.trim()) return []
  return policy.split(/\s+and\s+/).map((t) => {
    const m = /^([A-Za-z]+)(?:\(([^)]*)\))?$/.exec(t.trim())
    if (!m) throw new Error(`Keycloak password policy has an unreadable part: "${t}"`)
    return { name: m[1]!, arg: m[2] ?? null }
  })
}

function numberArg(tokens: PolicyToken[], name: string, whenPresentWithoutArg: number): number {
  const t = tokens.find((x) => x.name === name)
  if (!t) return 0
  const n = t.arg === null || t.arg === '' || t.arg === 'undefined' ? whenPresentWithoutArg : Number(t.arg)
  if (!Number.isFinite(n)) throw new Error(`Keycloak password policy "${name}" has a non-numeric value "${String(t.arg)}"`)
  return n
}

export function rulesFromRealm(realm: { passwordPolicy?: string | null; bruteForceProtected?: boolean; failureFactor?: number; maxFailureWaitSeconds?: number }): PasswordRules {
  const tokens = parsePasswordPolicy(realm.passwordPolicy)
  return {
    // Keycloak senza `length` accetta anche 1 carattere: lo si dice, non si inventa un minimo.
    minLength:       numberArg(tokens, 'length', 8),
    uppercase:       numberArg(tokens, 'upperCase', 1),
    lowercase:       numberArg(tokens, 'lowerCase', 1),
    digits:          numberArg(tokens, 'digits', 1),
    special:         numberArg(tokens, 'specialChars', 1),
    notUsername:     tokens.some((t) => t.name === 'notUsername'),
    notEmail:        tokens.some((t) => t.name === 'notEmail'),
    history:         numberArg(tokens, 'passwordHistory', 3),
    expireDays:      numberArg(tokens, 'forceExpiredPasswordChange', 365),
    lockoutEnabled:  realm.bruteForceProtected === true,
    lockoutFailures: realm.failureFactor ?? 30,
    lockoutMinutes:  Math.max(1, Math.round((realm.maxFailureWaitSeconds ?? 900) / 60)),
  }
}

/**
 * Le regole FUORI dall'intervallo che il prodotto governa, con il valore che
 * il realm porta davvero (revisione totale · A-19).
 *
 * Un realm configurato dalla console di Keycloak può avere `failureFactor: 2`
 * o non avere `length` affatto: la pagina «Accesso» mostrava quei numeri e poi
 * ogni salvataggio — anche di un altro campo — veniva rifiutato, senza una via
 * d'uscita. Chi salva deve poter lasciare com'è ciò che non ha toccato; quello
 * che CAMBIA, invece, resta dentro l'intervallo.
 */
export function passwordRulesOutOfRange(rules: PasswordRules): { rule: string; value: number; min: number; max: number }[] {
  const out: { rule: string; value: number; min: number; max: number }[] = []
  for (const [k, [min, max]] of Object.entries(PASSWORD_RULE_RANGES)) {
    const v = (rules as unknown as Record<string, unknown>)[k]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      out.push({ rule: k, value: typeof v === 'number' ? v : 0, min, max })
    }
  }
  return out
}

/**
 * `current` sono le regole che il realm ha ADESSO: un valore fuori intervallo
 * che arriva identico a quello del realm si accetta (l'admin non l'ha
 * toccato), tutto il resto passa dall'intervallo (A-19).
 */
export function assertPasswordRules(raw: unknown, current?: PasswordRules): PasswordRules {
  const o = (raw ?? {}) as Record<string, unknown>
  const out = {} as Record<string, number | boolean>
  const unchanged = (k: string, v: unknown) =>
    current !== undefined && (current as unknown as Record<string, unknown>)[k] === v
  for (const [k, [min, max]] of Object.entries(PASSWORD_RULE_RANGES)) {
    const v = o[k]
    const inRange = typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    if (!inRange && !(typeof v === 'number' && Number.isInteger(v) && unchanged(k, v))) {
      throw new ValidationError(`Password rule "${k}" must be a whole number between ${String(min)} and ${String(max)}`, { key: `errors.login.rule.${k}`, params: { min, max } })
    }
    out[k] = v as number
  }
  for (const k of ['notUsername', 'notEmail', 'lockoutEnabled']) {
    if (typeof o[k] !== 'boolean') throw new ValidationError(`Password rule "${k}" must be on or off`, { key: 'errors.login.ruleShape', params: {} })
    out[k] = o[k] as boolean
  }
  const rules = out as unknown as PasswordRules
  if (rules.uppercase + rules.lowercase + rules.digits + rules.special > rules.minLength) {
    throw new ValidationError('The required characters do not fit in the minimum length', { key: 'errors.login.rulesExceedLength', params: {} })
  }
  return rules
}

export function policyString(rules: PasswordRules, current: string | null | undefined): string {
  const kept = parsePasswordPolicy(current).filter((t) => !(MANAGED_TOKENS as readonly string[]).includes(t.name))
  const parts: string[] = [`length(${String(rules.minLength)})`]
  if (rules.uppercase) parts.push(`upperCase(${String(rules.uppercase)})`)
  if (rules.lowercase) parts.push(`lowerCase(${String(rules.lowercase)})`)
  if (rules.digits) parts.push(`digits(${String(rules.digits)})`)
  if (rules.special) parts.push(`specialChars(${String(rules.special)})`)
  if (rules.notUsername) parts.push('notUsername(undefined)')
  if (rules.notEmail) parts.push('notEmail(undefined)')
  if (rules.history) parts.push(`passwordHistory(${String(rules.history)})`)
  if (rules.expireDays) parts.push(`forceExpiredPasswordChange(${String(rules.expireDays)})`)
  return [...parts, ...kept.map((t) => (t.arg === null ? t.name : `${t.name}(${t.arg})`))].join(' and ')
}

type RealmRep = { passwordPolicy?: string | null; bruteForceProtected?: boolean; failureFactor?: number; waitIncrementSeconds?: number; maxFailureWaitSeconds?: number; permanentLockout?: boolean }

/**
 * The rules a new organization starts with (tour of 23 Sep 2026, D70). The
 * realm was created with none: Keycloak then accepts a one-character password
 * and never locks an account, and the «Login & passwords» page said so on the
 * demo tenant. A reasonable start, inside the ranges that page governs; the
 * organization changes them there.
 */
export const INITIAL_PASSWORD_RULES: PasswordRules = {
  minLength: 12, uppercase: 1, lowercase: 1, digits: 1, special: 0,
  notUsername: true, notEmail: true, history: 3, expireDays: 0,
  lockoutEnabled: true, lockoutFailures: 10, lockoutMinutes: 15,
}

/** The realm fields that carry the password and lockout rules: the page and the realm creation write the same ones. */
export function realmPasswordSettings(rules: PasswordRules, currentPolicy: string | null | undefined): Record<string, unknown> {
  return {
    passwordPolicy: policyString(rules, currentPolicy),
    bruteForceProtected: rules.lockoutEnabled,
    failureFactor: rules.lockoutFailures,
    maxFailureWaitSeconds: rules.lockoutMinutes * 60,
    waitIncrementSeconds: Math.min(60, rules.lockoutMinutes * 60),
    // Mai un blocco permanente: nessuno, admin compreso, resta chiuso fuori per sempre.
    permanentLockout: false,
  }
}

export async function passwordRules(tenantId: string): Promise<PasswordRules> {
  const { kc, token } = await admin()
  return rulesFromRealm(await kc.get<RealmRep>(token, realmPath(tenantId)))
}

export async function setPasswordRules(tenantId: string, raw: unknown): Promise<{ before: PasswordRules; after: PasswordRules }> {
  const { kc, token } = await admin()
  const realm = await kc.get<RealmRep>(token, realmPath(tenantId))
  const before = rulesFromRealm(realm)
  // A-19: si legge PRIMA com'è il realm, così un valore fuori intervallo che
  // l'admin non ha toccato non blocca il salvataggio del resto.
  const rules = assertPasswordRules(raw, before)
  await kc.put(token, realmPath(tenantId), realmPasswordSettings(rules, realm.passwordPolicy))
  return { before, after: rules }
}

// ── Login aziendale ─────────────────────────────────────────────────────────────

export interface LoginProviderInput {
  kind:          LoginProviderKind
  displayName?:  string | null
  clientId?:     string | null
  clientSecret?: string | null
  /** Microsoft: il tenant (id o dominio) dell'azienda. */
  tenant?:       string | null
  /** Google: il dominio degli account ammessi. */
  hostedDomain?: string | null
  /** SAML: l'indirizzo dei metadati del provider. */
  metadataUrl?:  string | null
}

export interface LoginProviderView {
  kind:              LoginProviderKind
  displayName:       string
  enabled:           boolean
  clientId:          string | null
  tenant:            string | null
  hostedDomain:      string | null
  metadataUrl:       string | null
  /** The first of `redirectUris` (kept for older clients). */
  redirectUri:       string
  /** One per origin through which people reach the sign-in page: all of them go to the provider (D71). */
  redirectUris:      string[]
  samlSpMetadataUrl: string | null
  samlSpMetadataUrls: string[]
}

export interface LoginProviderCheck { key: string; ok: boolean; detail: string | null }

const DEFAULT_NAME: Record<LoginProviderKind, string> = { microsoft: 'Microsoft', google: 'Google', saml: 'SAML' }

function assertKind(kind: unknown): LoginProviderKind {
  if (!(LOGIN_PROVIDER_KINDS as readonly string[]).includes(String(kind))) {
    throw new ValidationError(`Unknown login provider "${String(kind)}"`, { key: 'errors.login.unknownProvider', params: { kind: String(kind) } })
  }
  return kind as LoginProviderKind
}

const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

export function redirectUrisOf(tenantId: string, kind: LoginProviderKind): string[] {
  return keycloakPublicUrls().map((base) => `${base}/realms/${encodeURIComponent(tenantId)}/broker/${kind}/endpoint`)
}

/** SAML: OpenGrafo's metadata, one address per public origin (none for the other kinds). */
function spMetadataUrlsOf(tenantId: string, kind: LoginProviderKind): string[] {
  if (kind !== 'saml') return []
  return keycloakPublicUrls().map((base) => `${base}/realms/${encodeURIComponent(tenantId)}/broker/saml/endpoint/descriptor`)
}

/** The addresses of a provider, the lists and — for older clients — their first entry. */
function addressesOf(tenantId: string, kind: LoginProviderKind): Pick<LoginProviderView, 'redirectUri' | 'redirectUris' | 'samlSpMetadataUrl' | 'samlSpMetadataUrls'> {
  const redirectUris = redirectUrisOf(tenantId, kind)
  const samlSpMetadataUrls = spMetadataUrlsOf(tenantId, kind)
  return { redirectUri: redirectUris[0]!, redirectUris, samlSpMetadataUrl: samlSpMetadataUrls[0] ?? null, samlSpMetadataUrls }
}

type IdpRep = { alias: string; providerId: string; displayName?: string; enabled: boolean; config?: Record<string, string> }

function view(tenantId: string, idp: IdpRep): LoginProviderView {
  const kind = assertKind(idp.alias)
  const c = idp.config ?? {}
  return {
    kind,
    displayName: idp.displayName ?? DEFAULT_NAME[kind],
    enabled: idp.enabled,
    clientId: kind === 'saml' ? null : (c['clientId'] ?? null),
    tenant: kind === 'microsoft' ? (c['tenantId'] ?? null) : null,
    hostedDomain: kind === 'google' ? (c['hostedDomain'] ?? null) : null,
    metadataUrl: kind === 'saml' ? (c['opengrafoMetadataUrl'] ?? null) : null,
    ...addressesOf(tenantId, kind),
  }
}

/** Gli indirizzi di ogni provider, anche prima di configurarlo: l'admin li registra presso Microsoft/Google/SAML. */
export function loginProviderAddresses(tenantId: string): Array<{ kind: LoginProviderKind } & ReturnType<typeof addressesOf>> {
  return LOGIN_PROVIDER_KINDS.map((kind) => ({ kind, ...addressesOf(tenantId, kind) }))
}

export async function loginProviders(tenantId: string): Promise<LoginProviderView[]> {
  const { kc, token } = await admin()
  const idps = await kc.get<IdpRep[]>(token, `${realmPath(tenantId)}/identity-provider/instances`)
  return idps.filter((i) => (LOGIN_PROVIDER_KINDS as readonly string[]).includes(i.alias)).map((i) => view(tenantId, i))
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    // No redirect followed: this file checks an outbound URL (the SAML metadata), and the guard's rule is one per file.
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' })
    let body: Record<string, unknown> | null = null
    try { body = await res.json() as Record<string, unknown> } catch { body = null }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

function assertComplete(input: LoginProviderInput): void {
  const missing: string[] = []
  if (input.kind !== 'saml') {
    if (!clean(input.clientId)) missing.push('clientId')
    if (!clean(input.clientSecret)) missing.push('clientSecret')
  }
  if (input.kind === 'microsoft' && !clean(input.tenant)) missing.push('tenant')
  if (input.kind === 'saml' && !clean(input.metadataUrl)) missing.push('metadataUrl')
  if (missing.length) {
    throw new ValidationError(`Missing fields: ${missing.join(', ')}`, { key: 'errors.login.missingFields', params: { fields: missing.join(', ') } })
  }
}

/**
 * La prova di un provider, PRIMA di attivarlo. Ogni controllo dice cosa ha
 * verificato: Microsoft accetta id e segreto (un token dell'applicazione);
 * Google risponde, ma il segreto Google lo verifica solo al primo accesso;
 * SAML: i metadati si leggono e hanno l'indirizzo di accesso.
 */
export async function testLoginProvider(tenantId: string, raw: LoginProviderInput): Promise<{ ok: boolean; checks: LoginProviderCheck[] }> {
  const input = { ...raw, kind: assertKind(raw.kind) }
  assertComplete(input)
  const checks: LoginProviderCheck[] = []
  try {
    if (input.kind === 'microsoft') {
      const tenant = clean(input.tenant)!
      const disc = await fetchJson(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`)
      checks.push({ key: 'microsoftTenant', ok: disc.status === 200, detail: disc.status === 200 ? null : String(disc.body?.['error_description'] ?? disc.status) })
      if (disc.status === 200) {
        const tok = await fetchJson(String(disc.body!['token_endpoint']), {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clean(input.clientId)!, client_secret: clean(input.clientSecret)!, scope: 'https://graph.microsoft.com/.default' }).toString(),
        })
        checks.push({ key: 'microsoftCredentials', ok: tok.status === 200, detail: tok.status === 200 ? null : String(tok.body?.['error_description'] ?? tok.body?.['error'] ?? tok.status).split('\r\n')[0]! })
      }
    } else if (input.kind === 'google') {
      const disc = await fetchJson('https://accounts.google.com/.well-known/openid-configuration')
      checks.push({ key: 'googleReachable', ok: disc.status === 200, detail: disc.status === 200 ? null : String(disc.status) })
      const idOk = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clean(input.clientId)!)
      checks.push({ key: 'googleClientId', ok: idOk, detail: idOk ? null : clean(input.clientId) })
    } else {
      const { kc, token } = await admin()
      try {
        // Keycloak fetches it from inside the stack's network: the same SSRF guard as webhooks and channels (review of 23 Sep 2026).
        await assertSafeOutboundUrl(clean(input.metadataUrl)!)
        const cfg = await kcPostJson<Record<string, string>>(kc, token, `${realmPath(tenantId)}/identity-provider/import-config`, { providerId: 'saml', fromUrl: clean(input.metadataUrl) })
        const ok = Boolean(cfg['singleSignOnServiceUrl'])
        checks.push({ key: 'samlMetadata', ok, detail: ok ? null : 'no singleSignOnServiceUrl' })
      } catch (err) {
        checks.push({ key: 'samlMetadata', ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) })
      }
    }
  } catch (err) {
    checks.push({ key: 'network', ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks }
}

/** POST che restituisce un corpo JSON (il client condiviso restituisce solo l'id creato). */
async function kcPostJson<T>(kc: KeycloakAdmin, token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${kc.baseUrl}${path}`, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`POST ${path} → ${String(res.status)}: ${(await res.text()).slice(0, 200)}`)
  return await res.json() as T
}

/**
 * Il flusso del primo accesso da un provider: collega la persona che esiste
 * già (stessa e-mail o nome utente), altrimenti rifiuta. Mai creazione
 * automatica (scelta del proprietario). Idempotente.
 */
export async function ensureExistingUsersOnlyFlow(kc: KeycloakAdmin, token: string, tenantId: string): Promise<void> {
  const base = `${realmPath(tenantId)}/authentication`
  const flows = await kc.get<Array<{ alias: string }>>(token, `${base}/flows`)
  if (!flows.some((f) => f.alias === EXISTING_USERS_FLOW)) {
    await kc.post(token, `${base}/flows`, {
      alias: EXISTING_USERS_FLOW, providerId: 'basic-flow', topLevel: true, builtIn: false,
      description: 'OpenGrafo: first login from a company provider links an existing person, never creates one',
    })
  }
  const path = `${base}/flows/${encodeURIComponent(EXISTING_USERS_FLOW)}/executions`
  let executions = await kc.get<Array<{ id: string; providerId?: string; requirement: string }>>(token, path)
  for (const provider of ['idp-detect-existing-broker-user', 'idp-auto-link']) {
    if (!executions.some((e) => e.providerId === provider)) await kc.post(token, `${path}/execution`, { provider })
  }
  executions = await kc.get<Array<{ id: string; providerId?: string; requirement: string }>>(token, path)
  for (const e of executions) {
    if (e.requirement !== 'REQUIRED') await kc.put(token, path, { ...e, requirement: 'REQUIRED' })
  }
}

/**
 * Salva un provider. `activate`: si prova con i dati dati, e solo se la prova
 * passa il provider si accende; altrimenti si salva spento. Un salvataggio senza
 * attivazione spegne sempre il provider: la configurazione cambiata va riprovata.
 */
export async function saveLoginProvider(tenantId: string, raw: LoginProviderInput, activate: boolean): Promise<{ provider: LoginProviderView; test: { ok: boolean; checks: LoginProviderCheck[] } | null }> {
  const input = { ...raw, kind: assertKind(raw.kind) }
  const test = activate ? await testLoginProvider(tenantId, input) : null
  if (activate && !test!.ok) {
    throw new ValidationError('The provider did not pass the test: it was not activated', { key: 'errors.login.testFailed', params: { checks: test!.checks.filter((c) => !c.ok).map((c) => c.key).join(', ') } })
  }
  const { kc, token } = await admin()
  await ensureExistingUsersOnlyFlow(kc, token, tenantId)
  const instances = `${realmPath(tenantId)}/identity-provider/instances`
  const existing = (await kc.get<IdpRep[]>(token, instances)).find((i) => i.alias === input.kind)

  const config: Record<string, string> = { ...(existing?.config ?? {}) }
  if (input.kind === 'saml') {
    const url = clean(input.metadataUrl) ?? config['opengrafoMetadataUrl']
    if (!url) throw new ValidationError('Missing fields: metadataUrl', { key: 'errors.login.missingFields', params: { fields: 'metadataUrl' } })
    // Keycloak fetches it from inside the stack's network, where Neo4j, Redis and the API answer (review of 23 Sep 2026).
    await assertSafeOutboundUrl(url)
    const imported = await kcPostJson<Record<string, string>>(kc, token, `${realmPath(tenantId)}/identity-provider/import-config`, { providerId: 'saml', fromUrl: url })
    Object.assign(config, imported, {
      opengrafoMetadataUrl: url,
      nameIDPolicyFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      principalType: 'SUBJECT',
      syncMode: 'IMPORT',
    })
  } else {
    const clientId = clean(input.clientId) ?? config['clientId']
    if (!clientId) throw new ValidationError('Missing fields: clientId', { key: 'errors.login.missingFields', params: { fields: 'clientId' } })
    config['clientId'] = clientId
    const secret = clean(input.clientSecret)
    if (secret) config['clientSecret'] = secret
    else if (!existing) throw new ValidationError('Missing fields: clientSecret', { key: 'errors.login.missingFields', params: { fields: 'clientSecret' } })
    config['syncMode'] = 'IMPORT'
    if (input.kind === 'microsoft') {
      const tenant = clean(input.tenant) ?? config['tenantId']
      if (!tenant) throw new ValidationError('Missing fields: tenant', { key: 'errors.login.missingFields', params: { fields: 'tenant' } })
      config['tenantId'] = tenant
    }
    if (input.kind === 'google') {
      const hd = clean(input.hostedDomain)
      if (hd) config['hostedDomain'] = hd
      else delete config['hostedDomain']
    }
  }

  const rep = {
    alias: input.kind, providerId: input.kind,
    displayName: clean(input.displayName) ?? existing?.displayName ?? DEFAULT_NAME[input.kind],
    enabled: activate,
    trustEmail: true,
    firstBrokerLoginFlowAlias: EXISTING_USERS_FLOW,
    // Keycloak 24 non conosce `hideOnLogin` (rifiuta la richiesta, visto dal vivo): il
    // pulsante del provider è visibile per default nella pagina di accesso.
    storeToken: false,
    config,
  }
  if (existing) await kc.put(token, `${instances}/${input.kind}`, rep)
  else await kc.post(token, instances, rep)
  const saved = (await kc.get<IdpRep[]>(token, instances)).find((i) => i.alias === input.kind)
  if (!saved) throw new Error(`Login provider ${input.kind} not found in realm ${tenantId} right after saving it`)
  return { provider: view(tenantId, saved), test }
}

export async function deactivateLoginProvider(tenantId: string, kindRaw: string): Promise<LoginProviderView> {
  const kind = assertKind(kindRaw)
  const { kc, token } = await admin()
  const path = `${realmPath(tenantId)}/identity-provider/instances/${kind}`
  const idp = await kc.get<IdpRep>(token, path)
  await kc.put(token, path, { ...idp, enabled: false })
  return view(tenantId, { ...idp, enabled: false })
}

export async function removeLoginProvider(tenantId: string, kindRaw: string): Promise<void> {
  const kind = assertKind(kindRaw)
  const { kc, token } = await admin()
  await kc.delete(token, `${realmPath(tenantId)}/identity-provider/instances/${kind}`)
}
