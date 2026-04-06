import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'

type Props = Record<string, unknown>

function mapRule(props: Props) {
  return {
    id:           props['id']           as string,
    itilType:     props['itil_type']    as string,
    ciType:       props['ci_type']      as string,
    relationType: props['relation_type'] as string,
    direction:    props['direction']    as string,
    description:  props['description']  as string | null ?? null,
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

async function itilCIRelationRules(
  _: unknown,
  args: { itilType: string },
  ctx: GraphQLContext,
) {
  const session = getSession()
  try {
    const r = await session.executeRead((tx) =>
      tx.run(
        `MATCH (rule:ITILCIRelationRule {tenant_id: $tenantId, itil_type: $itilType})
         RETURN properties(rule) AS props
         ORDER BY rule.ci_type, rule.relation_type`,
        { tenantId: ctx.tenantId, itilType: args.itilType },
      ),
    )
    return r.records.map((rec) => mapRule(rec.get('props') as Props))
  } finally {
    await session.close()
  }
}

async function allITILCIRelationRules(
  _: unknown,
  __: unknown,
  ctx: GraphQLContext,
) {
  const session = getSession()
  try {
    const r = await session.executeRead((tx) =>
      tx.run(
        `MATCH (rule:ITILCIRelationRule {tenant_id: $tenantId})
         RETURN properties(rule) AS props
         ORDER BY rule.itil_type, rule.ci_type`,
        { tenantId: ctx.tenantId },
      ),
    )
    return r.records.map((rec) => mapRule(rec.get('props') as Props))
  } finally {
    await session.close()
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function createITILCIRelationRule(
  _: unknown,
  args: {
    itilType:     string
    ciType:       string
    relationType: string
    direction:    string
    description?: string | null
  },
  ctx: GraphQLContext,
) {
  const id  = uuidv4()
  const now = new Date().toISOString()
  const session = getSession()
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `CREATE (rule:ITILCIRelationRule {
           id:            $id,
           tenant_id:     $tenantId,
           itil_type:     $itilType,
           ci_type:       $ciType,
           relation_type: $relationType,
           direction:     $direction,
           description:   $description,
           created_at:    $now
         })`,
        {
          id,
          tenantId:     ctx.tenantId,
          itilType:     args.itilType,
          ciType:       args.ciType,
          relationType: args.relationType,
          direction:    args.direction,
          description:  args.description ?? null,
          now,
        },
      ),
    )
    void audit(ctx, 'itilCIRelationRule.created', 'ITILCIRelationRule', id, {
      itilType: args.itilType, ciType: args.ciType, relationType: args.relationType,
    })
    return {
      id,
      itilType:     args.itilType,
      ciType:       args.ciType,
      relationType: args.relationType,
      direction:    args.direction,
      description:  args.description ?? null,
    }
  } finally {
    await session.close()
  }
}

async function deleteITILCIRelationRule(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  const session = getSession()
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (rule:ITILCIRelationRule {id: $id, tenant_id: $tenantId}) DELETE rule`,
        { id: args.id, tenantId: ctx.tenantId },
      ),
    )
    void audit(ctx, 'itilCIRelationRule.deleted', 'ITILCIRelationRule', args.id)
    return true
  } finally {
    await session.close()
  }
}

// ── Helper: load allowed CI labels for a given tenant+itilType ────────────────
// Returns [] if no rules are configured (backward compat → allow all).
export async function getAllowedCILabels(
  tenantId: string,
  itilType: string,
): Promise<string[]> {
  const session = getSession()
  try {
    const r = await session.executeRead((tx) =>
      tx.run(
        `MATCH (rule:ITILCIRelationRule {tenant_id: $tenantId, itil_type: $itilType})
         RETURN DISTINCT rule.ci_type AS ciType`,
        { tenantId, itilType },
      ),
    )
    return r.records.map((rec) => rec.get('ciType') as string)
  } finally {
    await session.close()
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const itilRelationsResolvers = {
  Query: {
    itilCIRelationRules,
    allITILCIRelationRules,
  },
  Mutation: {
    createITILCIRelationRule,
    deleteITILCIRelationRule,
  },
}
