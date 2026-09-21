/**
 * Policy di autorizzazione centrale per i campi root Query/Mutation.
 *
 * Prima di questa policy esistevano 17 `requireRole` sparsi: team, workflow,
 * webhook, sync, CMDB, automazione erano scrivibili da `viewer` e dall'
 * `end_user` del portale. Qui la regola è unica e applicata a OGNI campo root da
 * `applyAuthorizationPolicy` (chiamata in buildResolvers).
 *
 * ## Dai ruoli ai permessi (ondata 7 di «Nulla cablato»)
 * Fino all'ondata 7 questo file teneva quattro elenchi di nomi — admin-only,
 * viewer-consentite, end_user-consentite — e un default per ruolo. Ora ogni
 * operazione chiede dei PERMESSI (`operationPermissions.ts`), e un ruolo è
 * l'insieme dei permessi che l'organizzazione gli ha dato (`roles.ts`). I
 * quattro ruoli di prima sono ruoli di fabbrica con gli stessi permessi, a meno
 * delle quattro correzioni approvate: il confronto «prima e dopo» su ogni
 * operazione è `lib/__tests__/authorizationBeforeAfter.test.ts`.
 *
 * Un ruolo che l'organizzazione non ha è rifiutato con messaggio esplicito, non
 * degradato. I controlli locali nei resolver restano come seconda linea: questa
 * policy può solo restringere, mai allargare.
 *
 * Fail-fast: un campo root senza permessi, o una riga della mappa che nomina un
 * campo inesistente, fa fallire l'avvio.
 */
import type { GraphQLResolveInfo } from 'graphql'
import { USER_ROLES, type Permission } from '@opengraphity/types'
import { ForbiddenError } from './errors.js'
import {
  AUTHENTICATED, DYNAMIC_CI_PERMISSIONS, OPERATION_PERMISSIONS, operationRequirement,
  type OperationRequirement, type RootKind,
} from './operationPermissions.js'
import type { GraphQLContext } from '../context.js'

export type Role = GraphQLContext['role']
export type { RootKind }

/**
 * I ruoli di fabbrica, in un posto solo: `USER_ROLES` di @opengraphity/types, la
 * stessa lista che `assertRole` applica al login (auth/resolveAuth.ts) e che
 * gli script di onboarding usano (D-13).
 */
export const ROLES: readonly Role[] = USER_ROLES

/** I permessi di un campo root, o `undefined` se non è deciso. Pura: usata anche dai test. */
export function requirementOf(kind: RootKind, field: string, dynamicCI: ReadonlySet<string> = new Set()): OperationRequirement | undefined {
  return operationRequirement(kind, field) ?? (dynamicCI.has(`${kind}.${field}`) ? DYNAMIC_CI_PERMISSIONS[kind] : undefined)
}

/** Vero se questi permessi aprono l'operazione. */
export function permits(requirement: OperationRequirement, permissions: ReadonlySet<Permission>): boolean {
  return requirement === AUTHENTICATED || requirement.some((p) => permissions.has(p))
}

export function authorize(
  kind: RootKind, field: string, role: string, permissions: ReadonlySet<Permission>, dynamicCI?: ReadonlySet<string>,
): void {
  const requirement = requirementOf(kind, field, dynamicCI)
  if (!requirement) {
    // Non succede se l'avvio è passato dal controllo: è un difetto del prodotto, non un divieto.
    throw new Error(`[authorization] ${kind}.${field} has no permission rule (lib/operationPermissions.ts)`)
  }
  if (!permits(requirement, permissions)) {
    const required = (requirement as readonly Permission[]).join(', ')
    throw new ForbiddenError(`Role '${role}' cannot run ${kind}.${field} (requires one of: ${required})`, { key: 'errors.authz.roleNotAllowed', params: { role, operation: `${kind}.${field}`, required } })
  }
}

type RootResolver = (parent: unknown, args: unknown, ctx: GraphQLContext, info: GraphQLResolveInfo) => unknown
type RootMap = Record<string, RootResolver | undefined>

export interface AuthorizationOptions {
  /** I campi root generati per ogni tipo di CI (`Query.servers`, `Mutation.createServer`, …). */
  dynamicCI?: ReadonlySet<string>
}

/**
 * Avvolge ogni campo root con il controllo dei permessi. Verifica anche che la
 * mappa e i campi coincidano (fail-fast all'avvio).
 */
export function applyAuthorizationPolicy<T extends { Query?: RootMap; Mutation?: RootMap }>(resolvers: T, opts: AuthorizationOptions = {}): T {
  const query     = resolvers.Query    ?? {}
  const mutation  = resolvers.Mutation ?? {}
  const dynamicCI = opts.dynamicCI ?? new Set<string>()

  const present = new Set([...Object.keys(query).map((f) => `Query.${f}`), ...Object.keys(mutation).map((f) => `Mutation.${f}`)])
  const missing = [...OPERATION_PERMISSIONS.keys()].filter((op) => !present.has(op))
  if (missing.length) {
    throw new Error(`[authorization] the policy names fields that do not exist: ${missing.join(', ')}`)
  }
  const undecided = [...present].filter((op) => !OPERATION_PERMISSIONS.has(op) && !dynamicCI.has(op))
  if (undecided.length) {
    throw new Error(`[authorization] fields without a permission rule (lib/operationPermissions.ts): ${undecided.join(', ')}`)
  }

  const wrap = (kind: RootKind, map: RootMap): RootMap => {
    const out: RootMap = {}
    for (const [field, fn] of Object.entries(map)) {
      if (typeof fn !== 'function') { out[field] = fn; continue }
      out[field] = (parent, args, ctx, info) => {
        authorize(kind, field, ctx.role, ctx.permissions, dynamicCI)
        return fn(parent, args, ctx, info)
      }
    }
    return out
  }

  return { ...resolvers, Query: wrap('Query', query), Mutation: wrap('Mutation', mutation) }
}
