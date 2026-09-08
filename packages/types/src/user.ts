/**
 * Roles as stored on `User.role` in Neo4j and checked by
 * apps/api/src/auth/resolveAuth.ts (`ROLES`) / lib/requireRole.ts. The former
 * `TENANT_ADMIN | OPERATOR | APPROVER | VIEWER` never matched the graph (D-21).
 */
export const USER_ROLES = ['admin', 'operator', 'viewer', 'end_user'] as const
export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
}

/** `:User` node properties (snake_case, as persisted). */
export interface User {
  id: string
  tenant_id: string
  email: string
  name: string
  role: UserRole
  active: boolean
  created_at: string
}
