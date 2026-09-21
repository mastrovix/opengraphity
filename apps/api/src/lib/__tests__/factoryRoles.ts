/**
 * Per i test: la policy vista con i ruoli di fabbrica (`FACTORY_ROLE_PERMISSIONS`),
 * senza database. `allowedRoles` risponde «chi esegue questo campo root».
 */
import { FACTORY_ROLE_PERMISSIONS, USER_ROLES, isUserRole, type Permission } from '@opengraphity/types'
import { authorize, permits, requirementOf, type RootKind } from '../authorization.js'

export function factoryPermissions(role: string): ReadonlySet<Permission> {
  return new Set(isUserRole(role) ? FACTORY_ROLE_PERMISSIONS[role] : [])
}

export function allowedRoles(kind: RootKind, field: string): string[] {
  const req = requirementOf(kind, field)
  if (!req) throw new Error(`${kind}.${field} has no permission rule`)
  return USER_ROLES.filter((r) => permits(req, factoryPermissions(r)))
}

export function authorizeFactory(kind: RootKind, field: string, role: string): void {
  authorize(kind, field, role, factoryPermissions(role))
}
