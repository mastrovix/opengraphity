import { ForbiddenError } from './errors.js'
import type { GraphQLContext } from '../context.js'

/**
 * Throws ForbiddenError if the caller's role is not in the allowed list.
 * Use this to guard resolver fields that should not be accessible to end_users.
 */
export function requireRole(ctx: GraphQLContext, ...roles: GraphQLContext['role'][]): void {
  if (!(roles as string[]).includes(ctx.role)) {
    throw new ForbiddenError(`Role '${ctx.role}' is not authorized. Required: ${roles.join(', ')}`)
  }
}
