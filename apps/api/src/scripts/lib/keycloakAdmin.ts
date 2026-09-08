/**
 * Client minimale per la Keycloak Admin REST API, condiviso da add-user.ts e
 * onboard-tenant.ts (prima era duplicato integralmente nei due script).
 *
 * Configurazione da env (keycloakConfigFromEnv):
 *   KEYCLOAK_URL            default http://localhost:8080 SOLO fuori produzione
 *   KEYCLOAK_ADMIN_USER     default "admin"               SOLO fuori produzione
 *   KEYCLOAK_ADMIN_PASSWORD obbligatoria, nessun default (requireEnv)
 *
 * Semantica HTTP (uniforme, fail-loud):
 *   get    → body JSON; errore su qualsiasi status non 2xx
 *   exists → true/false su 2xx/404; errore su altri status
 *   post   → { id, created:true } su 2xx, { created:false } su 409 (già esistente); errore altrimenti
 *   put    → errore su non 2xx
 */

import { envOrThrowInProd, requireEnv } from '../../lib/env.js'

export interface KeycloakAdminConfig {
  baseUrl:       string
  adminUser:     string
  adminPassword: string
  /** Iniettabile nei test. Default: fetch globale. */
  fetch?:        typeof fetch
}

export interface KeycloakAdmin {
  readonly baseUrl: string
  getAdminToken(): Promise<string>
  get<T>(token: string, path: string): Promise<T>
  exists(token: string, path: string): Promise<boolean>
  post(token: string, path: string, body: unknown): Promise<{ id?: string; created: boolean }>
  put(token: string, path: string, body: unknown): Promise<void>
  /** PUT /users/{id}/reset-password. `temporary: true` obbliga il cambio al primo login. */
  setPassword(token: string, realm: string, userId: string, password: string, temporary: boolean): Promise<void>
}

export function keycloakConfigFromEnv(): KeycloakAdminConfig {
  return {
    baseUrl:       envOrThrowInProd('KEYCLOAK_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    adminUser:     envOrThrowInProd('KEYCLOAK_ADMIN_USER', 'admin'),
    adminPassword: requireEnv('KEYCLOAK_ADMIN_PASSWORD'),
  }
}

async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return '<corpo non leggibile>'
  }
}

export function createKeycloakAdmin(config: KeycloakAdminConfig): KeycloakAdmin {
  const doFetch = config.fetch ?? fetch
  const { baseUrl } = config

  const authHeaders = (token: string, json = false): Record<string, string> => ({
    'Authorization': `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  })

  const client: KeycloakAdmin = {
    baseUrl,

    async getAdminToken() {
      const res = await doFetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type: 'password',
          client_id:  'admin-cli',
          username:   config.adminUser,
          password:   config.adminPassword,
        }),
      })
      if (!res.ok) {
        throw new Error(`Keycloak auth fallita (${res.status}): verifica KEYCLOAK_URL e credenziali admin`)
      }
      const data = await res.json() as { access_token?: unknown }
      if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new Error('Keycloak auth: risposta senza access_token')
      }
      return data.access_token
    },

    async get<T>(token: string, path: string) {
      const res = await doFetch(`${baseUrl}${path}`, { headers: authHeaders(token) })
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await bodyText(res)}`)
      return res.json() as Promise<T>
    },

    async exists(token: string, path: string) {
      const res = await doFetch(`${baseUrl}${path}`, { headers: authHeaders(token) })
      if (res.status === 404) return false
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await bodyText(res)}`)
      return true
    },

    async post(token: string, path: string, body: unknown) {
      const res = await doFetch(`${baseUrl}${path}`, {
        method:  'POST',
        headers: authHeaders(token, true),
        body:    JSON.stringify(body),
      })
      if (res.status === 409) return { created: false }
      if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await bodyText(res)}`)
      const id = res.headers.get('location')?.split('/').pop() || undefined
      return { id, created: true }
    },

    async put(token: string, path: string, body: unknown) {
      const res = await doFetch(`${baseUrl}${path}`, {
        method:  'PUT',
        headers: authHeaders(token, true),
        body:    JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${await bodyText(res)}`)
    },

    setPassword(token, realm, userId, password, temporary) {
      return client.put(token, `/admin/realms/${realm}/users/${userId}/reset-password`, {
        type: 'password', value: password, temporary,
      })
    },
  }

  return client
}

// ── Operazioni composte usate da entrambi gli script ─────────────────────────

/** Id dell'utente Keycloak con quell'email (exact match) nel realm, o errore se assente. */
export async function findUserIdByEmail(kc: KeycloakAdmin, token: string, realm: string, email: string): Promise<string> {
  const users = await kc.get<{ id: string }[]>(
    token,
    `/admin/realms/${realm}/users?email=${encodeURIComponent(email)}&exact=true`,
  )
  const existing = users[0]
  if (!existing) throw new Error(`Utente "${email}" non trovato nel realm "${realm}" — stato inatteso`)
  return existing.id
}

/**
 * Assegna un realm role all'utente (idempotente lato Keycloak). Se
 * `createIfMissing`, il ruolo viene creato quando non esiste nel realm.
 * Ritorna true se il ruolo è stato creato.
 */
export async function assignRealmRole(
  kc: KeycloakAdmin,
  token: string,
  realm: string,
  userId: string,
  roleName: string,
  createIfMissing: boolean,
): Promise<{ roleCreated: boolean }> {
  const rolesPath = `/admin/realms/${realm}/roles`
  let role = (await kc.get<{ id: string; name: string }[]>(token, rolesPath)).find(r => r.name === roleName)
  let roleCreated = false

  if (!role) {
    if (!createIfMissing) throw new Error(`Ruolo "${roleName}" non trovato nel realm "${realm}"`)
    await kc.post(token, rolesPath, { name: roleName, description: `Portal role: ${roleName}` })
    roleCreated = true
    role = (await kc.get<{ id: string; name: string }[]>(token, rolesPath)).find(r => r.name === roleName)
    if (!role) throw new Error(`Impossibile creare il ruolo "${roleName}" nel realm "${realm}"`)
  }

  await kc.post(token, `/admin/realms/${realm}/users/${userId}/role-mappings/realm`, [{ id: role.id, name: role.name }])
  return { roleCreated }
}
