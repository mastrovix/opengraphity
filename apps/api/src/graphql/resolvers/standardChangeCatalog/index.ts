import { getSession, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../../context.js'
import { type Props, mapCategory, toInt } from './helpers.js'

import {
  changeCatalogCategories,
  changeCatalogCategory,
  standardChangeCatalog,
  standardChangeCatalogEntry,
} from './catalogQueries.js'

import {
  createChangeCatalogCategory,
  updateChangeCatalogCategory,
  deleteChangeCatalogCategory,
  reorderChangeCatalogCategories,
  createStandardChangeCatalogEntry,
  updateStandardChangeCatalogEntry,
  deleteStandardChangeCatalogEntry,
  createChangeFromCatalog,
} from './catalogMutations.js'

// ── Field resolvers ──────────────────────────────────────────────────────────

async function categoryFieldResolver(
  parent: { categoryId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  const session = getSession()
  try {
    type Row = { props: Props; cnt: unknown }
    const row = await runQueryOne<Row>(session, `
      MATCH (c:ChangeCatalogCategory {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (c)<-[:BELONGS_TO_CATEGORY]-(e:StandardChangeCatalogEntry {tenant_id: $tenantId, enabled: true})
      RETURN properties(c) AS props, count(e) AS cnt
    `, { id: parent.categoryId, tenantId: ctx.tenantId })
    return row ? mapCategory(row.props, toInt(row.cnt)) : null
  } finally {
    await session.close()
  }
}

async function workflowFieldResolver(
  parent: { workflowId: string | null },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (!parent.workflowId) return null
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (w:WorkflowDefinition {id: $id, tenant_id: $tenantId})
      RETURN properties(w) AS props
    `, { id: parent.workflowId, tenantId: ctx.tenantId })
    if (!row) return null
    return {
      id:         row.props['id']          as string,
      name:       row.props['name']        as string,
      entityType: row.props['entity_type'] as string,
      category:   (row.props['category'] ?? null) as string | null,
      active:     row.props['active'] !== false,
      version:    Number(row.props['version'] ?? 1),
    }
  } finally {
    await session.close()
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const standardChangeCatalogResolvers = {
  Query: {
    changeCatalogCategories,
    changeCatalogCategory,
    standardChangeCatalog,
    standardChangeCatalogEntry,
  },
  Mutation: {
    createChangeCatalogCategory,
    updateChangeCatalogCategory,
    deleteChangeCatalogCategory,
    reorderChangeCatalogCategories,
    createStandardChangeCatalogEntry,
    updateStandardChangeCatalogEntry,
    deleteStandardChangeCatalogEntry,
    createChangeFromCatalog,
  },
  StandardChangeCatalogEntry: {
    category: categoryFieldResolver,
    workflow: workflowFieldResolver,
  },
}
