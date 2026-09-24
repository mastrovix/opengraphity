/**
 * CMDB chains: read, drawn, removed (services/cmdbChains). Every save is
 * validated against the families and the metamodel, and audited.
 */
import { randomUUID } from 'crypto'
import { loadMetamodel } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { ENUM_SCOPE } from '../../lib/enumScope.js'
import { audit } from '../../lib/audit.js'
import { assertChainKind, linkOptions, validateChainInput, type ChainInput } from '../../services/cmdbChains/model.js'
import { createChain, deleteChain, listChains, updateChain } from '../../services/cmdbChains/store.js'

export const cmdbChainsResolvers = {
  Query: {
    cmdbChains: (_: unknown, __: unknown, ctx: GraphQLContext) => withSession((s) => listChains(s, ctx.tenantId)),
    cmdbChainLinkOptions: async (_: unknown, args: { ciType: string; kind: string }, ctx: GraphQLContext) =>
      linkOptions(await loadMetamodel(ctx.tenantId, ENUM_SCOPE), args.ciType, assertChainKind(args.kind)),
  },
  Mutation: {
    createCmdbChain: async (_: unknown, args: { input: ChainInput }, ctx: GraphQLContext) => {
      const chain = validateChainInput(args.input, await loadMetamodel(ctx.tenantId, ENUM_SCOPE))
      const saved = await withSession((s) => createChain(s, ctx.tenantId, randomUUID(), chain, ctx.userId), true)
      void audit(ctx, 'cmdb_chain.created', 'CMDBChain', saved.id, { name: saved.name, kind: saved.kind, types: saved.nodes.length })
      return saved
    },
    updateCmdbChain: async (_: unknown, args: { id: string; input: ChainInput }, ctx: GraphQLContext) => {
      const chain = validateChainInput(args.input, await loadMetamodel(ctx.tenantId, ENUM_SCOPE))
      const saved = await withSession((s) => updateChain(s, ctx.tenantId, args.id, chain, ctx.userId), true)
      void audit(ctx, 'cmdb_chain.updated', 'CMDBChain', saved.id, { name: saved.name, kind: saved.kind, types: saved.nodes.length })
      return saved
    },
    deleteCmdbChain: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const name = await withSession((s) => deleteChain(s, ctx.tenantId, args.id), true)
      void audit(ctx, 'cmdb_chain.deleted', 'CMDBChain', args.id, { name })
      return true
    },
  },
}
