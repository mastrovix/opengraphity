/**
 * CHI PUÒ COSA, DENTRO UN RESOLVER (ondata 7 di «Nulla cablato»).
 *
 * La policy centrale (`authorization.ts`) decide se un'operazione si esegue.
 * Dentro l'operazione restano domande più fini — «può cancellare il commento di
 * un altro?», «decide per un team di cui non fa parte?» — e prima si
 * rispondevano col nome del ruolo (`ctx.role === 'admin'`). Ora si rispondono
 * coi permessi del ruolo, che l'organizzazione sceglie.
 */
import { PERMISSIONS, type Permission } from '@opengraphity/types'
import { ForbiddenError } from './errors.js'
import type { GraphQLContext } from '../context.js'

/** I permessi di un attore di sistema (monitoraggio, automazioni): tutto il catalogo. */
export const SYSTEM_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSIONS)

export function hasPermission(ctx: Pick<GraphQLContext, 'permissions'>, permission: Permission): boolean {
  return ctx.permissions.has(permission)
}

/** Si ferma se il ruolo non ha ALMENO UNO di questi permessi. */
export function requirePermission(ctx: Pick<GraphQLContext, 'role' | 'permissions'>, ...anyOf: Permission[]): void {
  if (anyOf.some((p) => ctx.permissions.has(p))) return
  const required = anyOf.join(', ')
  throw new ForbiddenError(`Role '${ctx.role}' is not authorized (requires one of: ${required})`, { key: 'errors.authz.permissionRequired', params: { required } })
}

/**
 * Chi entra SOLO dal portale: nessun accesso all'area di lavoro. Vede i propri
 * ticket e le risposte pubbliche, sceglie fra le opzioni del portale. Un ruolo
 * che ha anche l'area di lavoro è staff a tutti gli effetti.
 */
export function isPortalOnly(ctx: Pick<GraphQLContext, 'permissions'>): boolean {
  return !ctx.permissions.has('workspace.use')
}
