/**
 * La pagina Ruoli (ondata 7 di «Nulla cablato»): elenco, creazione, modifica,
 * cancellazione. Il ruolo di una persona (`setUserRole`) sta coi resolver degli
 * utenti (resolvers/index.ts). Le regole stanno in `lib/roles.ts`; qui
 * si espongono e si scrive l'Audit Log.
 */
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { createRole, deleteRole, listRoles, updateRole } from '../../lib/roles.js'

type RoleInput = { name?: string | null; permissions: string[] }

export const roleResolvers = {
  Query: {
    roles: (_: unknown, __: unknown, ctx: GraphQLContext) => listRoles(ctx.tenantId),
  },
  Mutation: {
    createRole: async (_: unknown, args: { input: RoleInput }, ctx: GraphQLContext) => {
      const role = await createRole(ctx.tenantId, args.input)
      void audit(ctx, 'role.created', 'Role', role.key, { name: role.name, permissions: role.permissions })
      return role
    },
    updateRole: async (_: unknown, args: { key: string; input: RoleInput }, ctx: GraphQLContext) => {
      const { before, after } = await updateRole(ctx.tenantId, args.key, args.input)
      const added   = after.permissions.filter((p) => !before.permissions.includes(p))
      const removed = before.permissions.filter((p) => !after.permissions.includes(p))
      void audit(ctx, 'role.updated', 'Role', args.key, { previousName: before.name, name: after.name, added, removed })
      return after
    },
    deleteRole: async (_: unknown, args: { key: string }, ctx: GraphQLContext) => {
      const role = await deleteRole(ctx.tenantId, args.key)
      void audit(ctx, 'role.deleted', 'Role', args.key, { name: role.name, permissions: role.permissions })
      return true
    },
  },
}
