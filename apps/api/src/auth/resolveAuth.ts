import jwt from 'jsonwebtoken'
import type express from 'express'
import { GraphQLError } from 'graphql'
import { getSession } from '@opengraphity/neo4j'
import { verifyKeycloakToken, type KeycloakTokenPayload } from './keycloak.js'
import { authLogger } from '../lib/logger.js'
import { config } from '../lib/config.js'
import { USER_ROLES, type Permission } from '@opengraphity/types'
import { rolePermissions, tenantRoles } from '../lib/roles.js'

/**
 * Single authentication resolver shared by GraphQL (`buildContext`) and the
 * REST `authMiddleware` — A-18. Both paths used to carry their own copy of the
 * user lookup and role mapping, and only GraphQL did the host/tenant
 * cross-check.
 *
 * Tenant binding (A-03 / G-03): the Keycloak realm IS the tenant slug. The
 * realm is read from the verified `iss` claim and the User node is matched on
 * `(email, tenant_id = realm)`, so an identical email created in another realm
 * can never resolve to this tenant's user.
 */

// JWT_SECRET serve solo al path legacy (ALLOW_LEGACY_JWT): letto lì, fail-loud se manca.

/** I ruoli di fabbrica. Un'organizzazione ne crea altri (ondata 7): la chiave di un ruolo è una stringa. */
export const ROLES = USER_ROLES
export type Role = string

export interface GraphQLContext {
  tenantId:  string
  userId:    string
  userEmail: string
  role:      Role
  /**
   * I permessi del ruolo, letti una volta per richiesta (ondata 7 di «Nulla
   * cablato»). Ogni controllo di chi-può-cosa guarda qui, non il nome del ruolo.
   */
  permissions: ReadonlySet<Permission>
}

interface LegacyJWTPayload {
  tenant_id: string
  user_id:   string
  email:     string
  role:      Role
}

function unauthorized(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'UNAUTHORIZED' } })
}

/**
 * UN TENANT SOSPESO NON È UNA SESSIONE SCADUTA, e va detto con un codice
 * proprio (17 set 2026).
 *
 * Con `UNAUTHORIZED` il client faceva la cosa giusta per il motivo sbagliato:
 * rinfrescava il token, riprovava, veniva rifiutato di nuovo e concludeva che
 * l'account non è più accettato — quindi tornava al login. Ma Keycloak dice
 * sì (il realm esiste, la persona esiste), l'app riparte, la prima query
 * riceve un altro rifiuto, e si ricomincia: un ciclo infinito, che in più
 * gonfiava l'URL fino a farlo rifiutare da nginx con un 414.
 *
 * `TENANT_SUSPENDED` è definitivo per definizione: non c'è niente che il
 * client possa riprovare, e la sola risposta giusta è una frase a chi guarda.
 * Lo stato resta 401 — l'accesso è negato — ma il codice dice PERCHÉ.
 */
export const TENANT_SUSPENDED = 'TENANT_SUSPENDED'

function tenantSuspended(): GraphQLError {
  return new GraphQLError('Unauthorized: tenant suspended', { extensions: { code: TENANT_SUSPENDED } })
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Keycloak issuer → realm slug. `http://kc:8080/realms/c-one` → `c-one`.
 * Fails loudly when the issuer carries no realm: the realm is the tenant key,
 * a token without it must never be resolved against the DB.
 */
export function extractRealmFromIssuer(iss: string): string {
  const match = /\/realms\/([^/?#]+)\/?$/.exec(iss)
  if (!match?.[1]) {
    throw unauthorized(`Token issuer carries no Keycloak realm: ${iss}`)
  }
  return decodeURIComponent(match[1])
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
// Bracketed IPv6 literal as it appears in a Host header: "[::1]", "[::1]:4000",
// "[fe80::1%25en0]" (zone id) — anything in brackets is an address, never a slug
const IPV6_RE = /^\[[^\]]+\](?::\d+)?$/

/**
 * Tenant slug from a Host / X-Forwarded-Host header value (A-25).
 * "c-one.opengrafo.com"        → "c-one"
 * "c-one.localhost:4000"       → "c-one"
 * "portal.c-one.localhost"     → "c-one"   (portal prefix skipped)
 * "localhost", "127.0.0.1:80",
 * "192.168.1.5", "[::1]:4000"  → null      (no subdomain → no cross-check)
 * A slug like "10x-labs" or "192corp" is a real tenant, not an IP.
 */
export function extractTenantFromHost(hostHeader: string): string | null {
  // A chain of proxies may append values: keep the first (the client-facing host)
  const raw = hostHeader.split(',')[0]!.trim()
  if (raw === '' || IPV6_RE.test(raw)) return null

  const host = raw.split(':')[0]!        // strip port
  if (host === 'localhost' || IPV4_RE.test(host)) return null

  const parts = host.split('.')
  const first = parts[0]!
  if (first === '') return null

  // portal.c-one.localhost → tenant is the second segment, not "portal"
  if (first === 'portal' && parts.length >= 3) return parts[1]!

  return first
}

function hostHeaderOf(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-host']
  const value = forwarded ?? req.headers['host'] ?? ''
  return Array.isArray(value) ? (value[0] ?? '') : value
}

// ── DB lookup ────────────────────────────────────────────────────────────────

interface UserRecord { id: string; role: unknown; active: boolean }

/**
 * Il tenant è sospeso? Letta a ogni richiesta autenticata, quindi va tenuta
 * ECONOMICA: una proprietà sul nodo `:Tenant`, che è indicizzato per `id`.
 *
 * Nessuna cache: una sospensione serve a chiudere la porta adesso, e un minuto
 * di cache vorrebbe dire un minuto in cui la porta è ancora aperta. Se questa
 * lettura diventasse un costo, la si mette in cache con un TTL di pochi
 * secondi — mai con uno che si misuri in minuti.
 *
 * Un errore di lettura NON apre la porta: si rifiuta. È la scelta severa, ed è
 * quella giusta su un controllo di accesso.
 */
async function tenantSospeso(tenantId: string): Promise<boolean> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.suspended_at AS suspendedAt', { tenantId }))
    const row = result.records[0]
    // Nessun nodo `:Tenant`: non è «non sospeso», è un tenant che non esiste —
    // e `findUserInTenant` lo fermerà comunque un istante dopo.
    if (!row) return false
    return row.get('suspendedAt') != null
  } finally {
    await session.close()
  }
}

async function findUserInTenant(email: string, tenantId: string): Promise<UserRecord | null> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        // L'e-mail si scrive minuscola (Keycloak la dà minuscola): un confronto
        // esatto sull'indice (tenant_id, email) — revisione totale · A-3.
        `MATCH (u:User {email: $email, tenant_id: $tenantId}) RETURN u.id AS id, u.role AS role, coalesce(u.active, true) AS active`,
        { email: email.trim().toLowerCase(), tenantId },
      ),
    )
    if (result.records.length === 0) return null
    if (result.records.length > 1) {
      // The (tenant_id, email) uniqueness constraint makes this impossible;
      // if it happens the schema was not initialised — never pick one at random.
      throw new Error(`Multiple User nodes for ${email} in tenant ${tenantId}: uniqueness constraint missing`)
    }
    const r = result.records[0]!
    return { id: r.get('id') as string, role: r.get('role'), active: r.get('active') !== false }
  } finally {
    await session.close()
  }
}

/**
 * Il ruolo della persona e i suoi permessi. Un ruolo assente, o che
 * l'organizzazione non ha, è un errore di integrità del dato, non un rifiuto
 * d'accesso: mai un ruolo di ripiego.
 */
async function roleAndPermissions(role: unknown, userId: string, tenantId: string): Promise<{ role: Role; permissions: ReadonlySet<Permission> }> {
  const found = typeof role === 'string' && role !== '' ? (await tenantRoles(tenantId)).get(role) : undefined
  if (typeof role !== 'string' || !found) {
    throw new GraphQLError(
      `User ${userId} in tenant ${tenantId} has no valid role (got ${JSON.stringify(role ?? null)})`,
      { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    )
  }
  return { role, permissions: found.permissions }
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Resolves a bearer token to the request context.
 * Throws GraphQLError with `extensions.code = 'UNAUTHORIZED'` for every auth
 * rejection; any other error (DB outage, corrupt User node) propagates as-is so
 * callers can report it as a server error rather than a bad credential.
 */
export async function resolveAuth(token: string, req: express.Request): Promise<GraphQLContext> {
  // Only the signature/format verification may fall back to the legacy JWT
  // path: once the token IS a valid Keycloak token, every later failure (user
  // not found, tenant mismatch, DB error) is a real rejection that must
  // propagate — not be masked as "Invalid token".
  let decoded: KeycloakTokenPayload | null = null
  try {
    decoded = await verifyKeycloakToken(token)
  } catch (err) {
    authLogger.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      'Keycloak token verification failed',
    )
  }

  if (decoded) return resolveKeycloak(decoded, req)

  // Legacy dev JWT — trusts tenant_id/role straight from the payload with no
  // DB lookup or host/tenant cross-check. Only for local dev, never production:
  // gated behind an explicit opt-in so a leaked JWT_SECRET can't impersonate.
  if (!config.allowLegacyJwt) {
    throw unauthorized('Invalid token')
  }
  const JWT_SECRET = config.jwtSecret
  if (!JWT_SECRET) throw new Error('ALLOW_LEGACY_JWT=true richiede JWT_SECRET')
  let payload: LegacyJWTPayload
  try {
    payload = jwt.verify(token, JWT_SECRET) as LegacyJWTPayload
  } catch (err) {
    authLogger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'Legacy JWT rejected')
    throw unauthorized('Invalid token')
  }
  return {
    tenantId:    payload.tenant_id,
    userId:      payload.user_id,
    userEmail:   payload.email,
    role:        payload.role,
    permissions: await rolePermissions(payload.tenant_id, payload.role),
  }
}

async function resolveKeycloak(decoded: KeycloakTokenPayload, req: express.Request): Promise<GraphQLContext> {
  const realm = extractRealmFromIssuer(decoded.iss)

  if (!decoded.email) {
    throw unauthorized('Unauthorized: token has no email claim')
  }

  /*
   * L'HOST DELLA CONSOLE NON È UN TENANT (17 set 2026).
   *
   * `opengrafo-admin.localhost` ha la forma di un tenant, e senza questo
   * rifiuto `extractTenantFromHost` ne dedurrebbe uno chiamato
   * `opengrafo-admin`: un token di tenant presentato lì verrebbe accettato, e
   * il confine fra i tenant e la console di piattaforma passerebbe solo da
   * nginx. Qui si rifiuta a monte: sulla console si entra SOLO dal suo
   * cammino (`auth/platformAuth.ts`), che pretende il realm di piattaforma.
   *
   * Conseguenza dichiarata: quello slug è riservato, nessun tenant può
   * chiamarsi così.
   */
  const host = hostHeaderOf(req).split(',')[0]!.trim().split(':')[0]!.toLowerCase()
  const consoleHost = config.platformHost?.toLowerCase()
  if (consoleHost && host === consoleHost) {
    authLogger.warn({ host }, 'tenant token presented on the platform console host: rejected')
    throw unauthorized('Unauthorized: tenant token on the platform console host')
  }

  // Cross-check: the realm the token was issued by must match the subdomain
  // the request arrived on. Applies to REST and GraphQL alike; nginx forces
  // X-Forwarded-Host so a client cannot pick the tenant by header.
  const tenantFromHost = extractTenantFromHost(hostHeaderOf(req))
  if (tenantFromHost && tenantFromHost !== realm) {
    authLogger.warn({ realm, hostTenant: tenantFromHost }, 'Tenant/host mismatch — token rejected')
    throw unauthorized('Unauthorized: token/tenant mismatch')
  }

  /*
   * UN TENANT SOSPESO NON LASCIA ENTRARE NESSUNO (17 set 2026).
   *
   * La console di piattaforma può sospendere un tenant, e la sospensione deve
   * valere SUBITO, anche per chi ha in mano un token ancora valido — altrimenti
   * «sospeso» vorrebbe dire «sospeso fra un quarto d'ora», che è il tempo di
   * vita di un access token. Il controllo sta qui e non nella console: chi
   * decide se si entra è il cammino di autenticazione, a ogni richiesta.
   *
   * Vale per tutti, admin compresi: un tenant sospeso è sospeso. Per rientrare
   * si riattiva dalla console.
   */
  if (await tenantSospeso(realm)) {
    authLogger.warn({ realm }, 'access to a suspended tenant: rejected')
    throw tenantSuspended()
  }

  const user = await findUserInTenant(decoded.email, realm)
  if (!user) {
    throw unauthorized('Unauthorized: user not found')
  }
  if (!user.active) {
    // Disattivata (revisione totale · M-6): anche con un token ancora valido.
    throw unauthorized('Unauthorized: user deactivated')
  }

  return {
    tenantId:    realm,
    userId:      user.id,
    userEmail:   decoded.email,
    ...(await roleAndPermissions(user.role, user.id, realm)),
  }
}
