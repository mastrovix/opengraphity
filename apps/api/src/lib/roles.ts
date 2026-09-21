/**
 * I RUOLI DI UN'ORGANIZZAZIONE (ondata 7 di «Nulla cablato»).
 *
 * Un ruolo è un nodo `(:Role {tenant_id, key, name, permissions, is_factory})`.
 * `User.role` porta la `key` del ruolo. I permessi sono chiavi del catalogo
 * (`PERMISSION_CATALOG` di @opengraphity/types): una chiave sconosciuta nel dato
 * è un errore di integrità e si dice, non si ignora.
 *
 * I quattro ruoli di fabbrica (`admin`, `operator`, `viewer`, `end_user`) nascono
 * con `provisionTenantData` e con la migrazione `20260928_1000_factory_roles`;
 * il loro `name` resta vuoto finché l'amministratore non lo cambia, e le
 * interfacce lo traducono dalla chiave.
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, type Queryable } from '@opengraphity/neo4j'
import { FACTORY_ROLE_PERMISSIONS, PERMISSIONS, USERS_ADMIN_PERMISSION, USER_ROLES, isPermission, type Permission } from '@opengraphity/types'
import { systemTextIn, type SystemTextKey } from './systemText.js'
import { LINGUE } from './enumValueLabels.js'
import { ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import { invalidateSchema } from './schemaInvalidator.js'
import { createMetamodelCache } from './metamodelCache.js'

export interface TenantRole {
  key:         string
  name:        string | null
  permissions: ReadonlySet<Permission>
  isFactory:   boolean
}

const cache = createMetamodelCache<ReadonlyMap<string, TenantRole>>({
  name: 'roles',
  load: (tenantId) => loadRoles(tenantId),
})

/** Solo per i test. */
export function clearRolesCache(): void { cache.clear() }

export function invalidateRoles(tenantId: string): void { cache.invalidate(tenantId) }

export function tenantRoles(tenantId: string): Promise<ReadonlyMap<string, TenantRole>> {
  return cache.get(tenantId)
}

/** I permessi del ruolo di una persona. Un ruolo che l'organizzazione non ha è rifiutato. */
export async function rolePermissions(tenantId: string, roleKey: string): Promise<ReadonlySet<Permission>> {
  const role = (await tenantRoles(tenantId)).get(roleKey)
  if (!role) {
    throw new ForbiddenError(`Unknown role '${roleKey}': no operation allowed`, { key: 'errors.authz.unknownRole', params: { role: roleKey } })
  }
  return role.permissions
}

/** Il ruolo di un'ALTRA persona ha questo permesso? Un ruolo che il tenant non ha: no. */
export async function roleHasPermission(tenantId: string, roleKey: string, permission: Permission): Promise<boolean> {
  return (await tenantRoles(tenantId)).get(roleKey)?.permissions.has(permission) ?? false
}

async function loadRoles(tenantId: string): Promise<ReadonlyMap<string, TenantRole>> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ key: string; name: string | null; permissions: unknown; isFactory: boolean | null }>(session, `
      MATCH (r:Role {tenant_id: $tenantId})
      RETURN r.key AS key, r.name AS name, r.permissions AS permissions, r.is_factory AS isFactory
    `, { tenantId })
    const roles = new Map<string, TenantRole>()
    for (const row of rows) {
      if (!Array.isArray(row.permissions)) {
        throw new Error(`Tenant ${tenantId}: role '${row.key}' has no permission list`)
      }
      const unknown = row.permissions.filter((p) => !isPermission(p))
      if (unknown.length) {
        throw new Error(`Tenant ${tenantId}: role '${row.key}' names unknown permissions: ${unknown.map(String).join(', ')}`)
      }
      roles.set(row.key, {
        key: row.key,
        name: row.name ?? null,
        permissions: new Set(row.permissions as Permission[]),
        isFactory: row.isFactory === true,
      })
    }
    return roles
  } finally {
    await session.close()
  }
}

/**
 * Crea i ruoli di fabbrica che mancano. Un ruolo che c'è già non si tocca: i
 * permessi li può aver cambiati l'amministratore. Restituisce le chiavi create.
 */
export async function seedFactoryRoles(session: Queryable, tenantId: string): Promise<string[]> {
  const now = new Date().toISOString()
  const created: string[] = []
  for (const key of USER_ROLES) {
    const r = await session.run(`
      MERGE (r:Role {tenant_id: $tenantId, key: $key})
      ON CREATE SET r.id = $id, r.name = null, r.permissions = $permissions, r.is_factory = true,
                    r.created_at = $now, r.updated_at = $now
      RETURN r.created_at = $now AS wasCreated
    `, { tenantId, key, id: uuidv4(), permissions: [...FACTORY_ROLE_PERMISSIONS[key]], now })
    if (r.records[0]?.get('wasCreated') === true) created.push(key)
  }
  if (created.length) invalidateRoles(tenantId)
  return created
}

// ── Gestione dei ruoli (pagina Ruoli) ──────────────────────────────────────────
//
// Le regole:
//  - la chiave di un ruolo nasce dal nome e non cambia più (`User.role` la porta,
//    le regole di notifica «per ruolo» anche);
//  - i ruoli di fabbrica si modificano ma non si cancellano; un ruolo con persone
//    non si cancella;
//  - deve restare almeno una persona attiva con `admin.users`, altrimenti
//    nessuno potrebbe più gestire persone e ruoli.

export const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/
export const ROLE_NAME_MAX = 60

export interface RoleView {
  key:         string
  name:        string | null
  permissions: Permission[]
  isFactory:   boolean
  userCount:   number
}

function assertRoleName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length === 0 || name.length > ROLE_NAME_MAX) {
    throw new ValidationError(`A role name must be 1 to ${String(ROLE_NAME_MAX)} characters`, { key: 'errors.role.name', params: { max: ROLE_NAME_MAX } })
  }
  return name
}

function assertPermissionList(raw: unknown): Permission[] {
  if (!Array.isArray(raw)) throw new ValidationError('permissions must be a list', { key: 'errors.role.permissions', params: { unknown: '' } })
  const unknown = raw.filter((p) => !isPermission(p))
  if (unknown.length) {
    throw new ValidationError(`Unknown permissions: ${unknown.map(String).join(', ')}`, { key: 'errors.role.permissions', params: { unknown: unknown.map(String).join(', ') } })
  }
  // L'ordine è quello del catalogo: il dato non dipende da come l'interfaccia li ha spuntati.
  return PERMISSIONS.filter((p) => (raw as string[]).includes(p))
}

/** La chiave di un ruolo nuovo, dal nome: minuscole ASCII e trattini bassi, unica nel tenant. */
export function roleKeyFromName(name: string, taken: ReadonlySet<string>): string {
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32) || 'role'
  const seed = base.length >= 2 ? base : `${base}_role`
  if (!taken.has(seed)) return seed
  for (let i = 2; ; i++) {
    const candidate = `${seed}_${String(i)}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function listRoles(tenantId: string): Promise<RoleView[]> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ key: string; name: string | null; permissions: string[]; isFactory: boolean | null; userCount: unknown }>(session, `
      MATCH (r:Role {tenant_id: $tenantId})
      OPTIONAL MATCH (u:User {tenant_id: $tenantId, role: r.key})
      RETURN r.key AS key, r.name AS name, r.permissions AS permissions, r.is_factory AS isFactory, count(u) AS userCount
    `, { tenantId })
    const factoryOrder = USER_ROLES as readonly string[]
    return rows
      .map((r) => ({
        key: r.key, name: r.name ?? null, permissions: assertPermissionList(r.permissions),
        isFactory: r.isFactory === true, userCount: Number(r.userCount ?? 0),
      }))
      .sort((a, b) => (a.isFactory === b.isFactory
        ? (a.isFactory ? factoryOrder.indexOf(a.key) - factoryOrder.indexOf(b.key) : (a.name ?? a.key).localeCompare(b.name ?? b.key))
        : a.isFactory ? -1 : 1))
  } finally {
    await session.close()
  }
}

/**
 * Il nome di un ruolo di fabbrica, in ogni lingua, se `name` lo ripete.
 * Secondo giro UI del 15 set 2026 · V-16: un ruolo del cliente chiamato
 * «Admin» nasceva senza obiezioni, e la tendina del ruolo di una persona
 * mostrava due «Admin» indistinguibili. I ruoli di fabbrica non hanno un nome
 * salvato (si leggono tradotti dalla chiave), quindi il controllo sul grafo
 * non li vedeva.
 */
export function factoryRoleNamedLike(name: string, exceptKey: string | null): string | null {
  const wanted = name.trim().toLocaleLowerCase()
  for (const key of USER_ROLES) {
    if (key === exceptKey) continue
    const textKey = `role.factory.${key}` as SystemTextKey
    if (key.toLocaleLowerCase() === wanted || LINGUE.some((l) => systemTextIn(l, textKey).toLocaleLowerCase() === wanted)) return key
  }
  return null
}

async function assertNameFree(session: Queryable, tenantId: string, name: string, exceptKey: string | null): Promise<void> {
  const factory = factoryRoleNamedLike(name, exceptKey)
  if (factory) throw new ValidationError(`A role named "${name}" already exists: it is the factory role "${factory}"`, { key: 'errors.role.nameTaken', params: { name } })
  const r = await session.run(`
    MATCH (r:Role {tenant_id: $tenantId}) WHERE r.name IS NOT NULL AND toLower(r.name) = toLower($name) AND ($exceptKey IS NULL OR r.key <> $exceptKey)
    RETURN r.key AS key LIMIT 1
  `, { tenantId, name, exceptKey })
  if (r.records.length) throw new ValidationError(`A role named "${name}" already exists`, { key: 'errors.role.nameTaken', params: { name } })
}

/**
 * Quante persone attive potrebbero ancora gestire persone e ruoli se il ruolo
 * `roleKey` avesse `permissions` e la persona `movedUserId` avesse il ruolo
 * `movedToRole`. Zero = la modifica chiude fuori tutti.
 */
async function usersAdminsAfter(
  session: Queryable, tenantId: string,
  change: { roleKey?: string; permissions?: readonly Permission[]; deletedKey?: string; movedUserId?: string; movedToRole?: string; deactivatedUserId?: string },
): Promise<number> {
  const r = await session.run(`
    MATCH (u:User {tenant_id: $tenantId}) WHERE coalesce(u.active, true) = true AND ($deactivatedUserId IS NULL OR u.id <> $deactivatedUserId)
    WITH u, CASE WHEN $movedUserId IS NOT NULL AND u.id = $movedUserId THEN $movedToRole ELSE u.role END AS roleKey
    MATCH (r:Role {tenant_id: $tenantId, key: roleKey})
    WHERE ($deletedKey IS NULL OR r.key <> $deletedKey)
      AND CASE WHEN $roleKey IS NOT NULL AND r.key = $roleKey THEN $perm IN $permissions ELSE $perm IN r.permissions END
    RETURN count(u) AS n
  `, {
    tenantId, perm: USERS_ADMIN_PERMISSION,
    roleKey: change.roleKey ?? null, permissions: change.permissions ? [...change.permissions] : [],
    deletedKey: change.deletedKey ?? null, movedUserId: change.movedUserId ?? null, movedToRole: change.movedToRole ?? null,
    deactivatedUserId: change.deactivatedUserId ?? null,
  })
  return Number(r.records[0]?.get('n') ?? 0)
}

function lastUsersAdminError(): ValidationError {
  return new ValidationError(
    'At least one active person must keep the permission to manage people and roles',
    { key: 'errors.role.lastUsersAdmin', params: {} },
  )
}

async function writeSession<T>(tenantId: string, fn: (s: Queryable) => Promise<T>): Promise<T> {
  const session = getSession(undefined, 'WRITE')
  try {
    return await session.executeWrite((tx) => fn(tx))
  } finally {
    await session.close()
    invalidateRoles(tenantId)
    // Il permesso si legge a ogni richiesta, anche negli altri processi: la leva unica.
    invalidateSchema(tenantId)
  }
}

export async function createRole(tenantId: string, input: { name?: unknown; permissions: unknown }): Promise<RoleView> {
  const name = assertRoleName(input.name)
  const permissions = assertPermissionList(input.permissions)
  return writeSession(tenantId, async (tx) => {
    await assertNameFree(tx, tenantId, name, null)
    const keysRes = await tx.run('MATCH (r:Role {tenant_id: $tenantId}) RETURN collect(r.key) AS keys', { tenantId })
    const key = roleKeyFromName(name, new Set((keysRes.records[0]?.get('keys') as string[] | undefined) ?? []))
    const now = new Date().toISOString()
    await tx.run(`
      CREATE (r:Role {id: $id, tenant_id: $tenantId, key: $key, name: $name, permissions: $permissions, is_factory: false, created_at: $now, updated_at: $now})
    `, { id: uuidv4(), tenantId, key, name, permissions, now })
    return { key, name, permissions, isFactory: false, userCount: 0 }
  })
}

export async function updateRole(tenantId: string, key: string, input: { name?: unknown; permissions: unknown }): Promise<{ before: RoleView; after: RoleView }> {
  const permissions = assertPermissionList(input.permissions)
  return writeSession(tenantId, async (tx) => {
    const cur = await tx.run(`
      MATCH (r:Role {tenant_id: $tenantId, key: $key})
      OPTIONAL MATCH (u:User {tenant_id: $tenantId, role: r.key})
      RETURN r.name AS name, r.permissions AS permissions, r.is_factory AS isFactory, count(u) AS userCount
    `, { tenantId, key })
    const row = cur.records[0]
    if (!row) throw new NotFoundError('Role', key)
    const isFactory = row.get('isFactory') === true
    // Un ruolo di fabbrica può restare senza nome: le interfacce lo traducono dalla chiave.
    const name = isFactory && (input.name == null || (typeof input.name === 'string' && input.name.trim() === '')) ? null : assertRoleName(input.name)
    if (name !== null) await assertNameFree(tx, tenantId, name, key)
    const hadUsersAdmin = ((row.get('permissions') as string[] | null) ?? []).includes(USERS_ADMIN_PERMISSION)
    if (hadUsersAdmin && !permissions.includes(USERS_ADMIN_PERMISSION) && await usersAdminsAfter(tx, tenantId, { roleKey: key, permissions }) === 0) {
      throw lastUsersAdminError()
    }
    await tx.run(`
      MATCH (r:Role {tenant_id: $tenantId, key: $key})
      SET r.name = $name, r.permissions = $permissions, r.updated_at = $now
    `, { tenantId, key, name, permissions, now: new Date().toISOString() })
    const userCount = Number(row.get('userCount') ?? 0)
    return {
      before: { key, name: (row.get('name') as string | null) ?? null, permissions: assertPermissionList(row.get('permissions')), isFactory, userCount },
      after:  { key, name, permissions, isFactory, userCount },
    }
  })
}

export async function deleteRole(tenantId: string, key: string): Promise<RoleView> {
  return writeSession(tenantId, async (tx) => {
    const cur = await tx.run(`
      MATCH (r:Role {tenant_id: $tenantId, key: $key})
      OPTIONAL MATCH (u:User {tenant_id: $tenantId, role: r.key})
      RETURN r.name AS name, r.permissions AS permissions, r.is_factory AS isFactory, count(u) AS userCount
    `, { tenantId, key })
    const row = cur.records[0]
    if (!row) throw new NotFoundError('Role', key)
    if (row.get('isFactory') === true) {
      throw new ValidationError('A factory role can be changed but not deleted', { key: 'errors.role.factoryNotDeletable', params: {} })
    }
    const userCount = Number(row.get('userCount') ?? 0)
    if (userCount > 0) {
      throw new ValidationError(`The role still has ${String(userCount)} people: give them another role first`, { key: 'errors.role.inUse', params: { count: userCount } })
    }
    const targetUses = await roleTargetUsage(tx, tenantId, key)
    if (targetUses > 0) {
      throw new ValidationError(`The role is the recipient of ${String(targetUses)} notification rules, workflow steps or automations: change them first`, { key: 'errors.role.usedAsRecipient', params: { count: targetUses } })
    }
    await tx.run('MATCH (r:Role {tenant_id: $tenantId, key: $key}) DETACH DELETE r', { tenantId, key })
    return { key, name: (row.get('name') as string | null) ?? null, permissions: assertPermissionList(row.get('permissions')), isFactory: false, userCount: 0 }
  })
}

/** Cambia il ruolo di una persona. Restituisce il ruolo di prima. */
export async function setUserRole(tenantId: string, userId: string, roleKey: string): Promise<{ previousRole: string }> {
  return writeSession(tenantId, async (tx) => {
    const cur = await tx.run(`
      MATCH (u:User {tenant_id: $tenantId, id: $userId})
      OPTIONAL MATCH (r:Role {tenant_id: $tenantId, key: $roleKey})
      OPTIONAL MATCH (prev:Role {tenant_id: $tenantId, key: u.role})
      RETURN u.role AS previousRole, r IS NOT NULL AS roleExists, coalesce($perm IN prev.permissions, false) AS wasUsersAdmin
    `, { tenantId, userId, roleKey, perm: USERS_ADMIN_PERMISSION })
    const row = cur.records[0]
    if (!row) throw new NotFoundError('User', userId)
    if (row.get('roleExists') !== true) {
      throw new ValidationError(`Invalid role: ${roleKey}`, { key: 'errors.authz.invalidRole', params: { role: roleKey } })
    }
    if (row.get('wasUsersAdmin') === true && await usersAdminsAfter(tx, tenantId, { movedUserId: userId, movedToRole: roleKey }) === 0) {
      throw lastUsersAdminError()
    }
    await tx.run(`
      MATCH (u:User {tenant_id: $tenantId, id: $userId}) SET u.role = $roleKey, u.updated_at = $now
    `, { tenantId, userId, roleKey, now: new Date().toISOString() })
    return { previousRole: String(row.get('previousRole') ?? '') }
  })
}

/**
 * Attiva o disattiva una persona nel grafo (revisione totale · M-6). Mai l'ultima
 * persona attiva che gestisce persone e ruoli, mai sé stessi. Restituisce
 * l'e-mail (per Keycloak) e se lo stato è cambiato davvero.
 */
export async function setUserActiveInGraph(
  tenantId: string, userId: string, active: boolean, actorId: string,
): Promise<{ email: string; name: string; changed: boolean }> {
  if (!active && userId === actorId) {
    throw new ValidationError('You cannot deactivate yourself', { key: 'errors.user.deactivateSelf' })
  }
  return writeSession(tenantId, async (tx) => {
    const cur = await tx.run(`
      MATCH (u:User {tenant_id: $tenantId, id: $userId})
      RETURN u.email AS email, u.name AS name, coalesce(u.active, true) AS active
    `, { tenantId, userId })
    const row = cur.records[0]
    if (!row) throw new NotFoundError('User', userId)
    const email = String(row.get('email'))
    const name = String(row.get('name') ?? email)
    if ((row.get('active') === true) === active) return { email, name, changed: false }
    if (!active && await usersAdminsAfter(tx, tenantId, { deactivatedUserId: userId }) === 0) {
      throw lastUsersAdminError()
    }
    const now = new Date().toISOString()
    await tx.run(`
      MATCH (u:User {tenant_id: $tenantId, id: $userId})
      SET u.active = $active, u.updated_at = $now,
          u.deactivated_at = CASE WHEN $active THEN null ELSE $now END,
          u.deactivated_by = CASE WHEN $active THEN null ELSE $actorId END
    `, { tenantId, userId, active, now, actorId })
    return { email, name, changed: true }
  })
}

// ── Ruoli come destinatari (notifiche «per ruolo») ─────────────────────────────

const ROLE_TARGET_IN_JSON_RE = /"role:([a-z][a-z0-9_]{1,39})"/g

/** I ruoli citati come `role:<chiave>` in un JSON di azioni (passi, automazioni). */
export function roleKeysInActions(json: string | null | undefined): string[] {
  if (!json) return []
  return [...new Set([...json.matchAll(ROLE_TARGET_IN_JSON_RE)].map((m) => m[1]!))]
}

/**
 * Un destinatario «per ruolo» deve nominare un ruolo dell'organizzazione: un
 * ruolo che non c'è selezionerebbe nessuno, e il job di notifica fallirebbe a
 * ogni evento.
 */
export async function assertRolesExist(tenantId: string, roleKeys: readonly string[]): Promise<void> {
  if (roleKeys.length === 0) return
  const roles = await tenantRoles(tenantId)
  const missing = roleKeys.filter((k) => !roles.has(k))
  if (missing.length) {
    throw new ValidationError(`Recipients name roles this organization does not have: ${missing.join(', ')}`, { key: 'errors.role.unknownTarget', params: { roles: missing.join(', ') } })
  }
}

/** Dove il ruolo è ancora usato come destinatario: una cancellazione lo lascerebbe a nessuno. */
async function roleTargetUsage(tx: Queryable, tenantId: string, key: string): Promise<number> {
  const r = await tx.run(`
    CALL {
      MATCH (n:NotificationRule {tenant_id: $tenantId}) WHERE n.target = $target RETURN count(n) AS c
      UNION ALL
      MATCH (s:WorkflowStep {tenant_id: $tenantId}) WHERE coalesce(s.enter_actions, '') CONTAINS $quoted OR coalesce(s.exit_actions, '') CONTAINS $quoted RETURN count(s) AS c
      UNION ALL
      MATCH (a:AutoTrigger {tenant_id: $tenantId}) WHERE coalesce(a.actions, '') CONTAINS $quoted RETURN count(a) AS c
      UNION ALL
      MATCH (b:BusinessRule {tenant_id: $tenantId}) WHERE coalesce(b.actions, '') CONTAINS $quoted RETURN count(b) AS c
    }
    RETURN sum(c) AS n
  `, { tenantId, target: `role:${key}`, quoted: `"role:${key}"` })
  return Number(r.records[0]?.get('n') ?? 0)
}
