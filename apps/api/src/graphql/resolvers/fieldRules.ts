import { v4 as uuidv4 } from 'uuid'
import { GraphQLError } from 'graphql'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withSession } from './ci-utils.js'
import { audit } from '../../lib/audit.js'
import { requireRole } from '../../lib/requireRole.js'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapVisibilityRule(p: Props) {
  return {
    id:           p['id']            as string,
    entityType:   p['entity_type']   as string,
    triggerField: p['trigger_field'] as string,
    triggerValue: p['trigger_value'] as string,
    targetField:  p['target_field']  as string,
    action:       p['action']        as string,
  }
}

function mapRequirementRule(p: Props) {
  return {
    id:           p['id']             as string,
    entityType:   p['entity_type']    as string,
    fieldName:    p['field_name']     as string,
    required:     (p['required']      ?? false) as boolean,
    workflowStep: (p['workflow_step'] ?? null)  as string | null,
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

async function fieldVisibilityRules(
  _: unknown,
  args: { entityType: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ p: Props }>(session, `
      MATCH (r:FieldVisibilityRule {tenant_id: $tenantId, entity_type: $entityType})
      RETURN properties(r) AS p
      ORDER BY r.created_at
    `, { tenantId: ctx.tenantId, entityType: args.entityType })
    return rows.map((r) => mapVisibilityRule(r.p))
  })
}

async function fieldRequirementRules(
  _: unknown,
  args: { entityType: string; workflowStep?: string | null },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ p: Props }>(session, `
      MATCH (r:FieldRequirementRule {tenant_id: $tenantId, entity_type: $entityType})
      WHERE CASE
              WHEN $workflowStep IS NULL THEN r.workflow_step IS NULL
              ELSE r.workflow_step IS NULL OR r.workflow_step = $workflowStep
            END
      RETURN properties(r) AS p
      ORDER BY r.field_name
    `, {
      tenantId:     ctx.tenantId,
      entityType:   args.entityType,
      workflowStep: args.workflowStep ?? null,
    })
    return rows.map((r) => mapRequirementRule(r.p))
  })
}

// ── Visibility Rule Mutations ─────────────────────────────────────────────────

async function createFieldVisibilityRule(
  _: unknown,
  args: { entityType: string; triggerField: string; triggerValue: string; targetField: string; action: string },
  ctx: GraphQLContext,
) {
  requireRole(ctx, 'admin')
  if (args.triggerField === args.targetField) {
    throw new GraphQLError('triggerField e targetField non possono essere lo stesso campo')
  }
  if (args.action !== 'show' && args.action !== 'hide') {
    throw new GraphQLError('action deve essere "show" o "hide"')
  }

  const id  = uuidv4()
  const now = new Date().toISOString()

  return withSession(async (session) => {
    await session.executeWrite((tx) =>
      tx.run(`
        CREATE (r:FieldVisibilityRule {
          id:            $id,
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          trigger_field: $triggerField,
          trigger_value: $triggerValue,
          target_field:  $targetField,
          action:        $action,
          created_at:    $now,
          updated_at:    $now
        })
      `, {
        id, tenantId: ctx.tenantId, entityType: args.entityType,
        triggerField: args.triggerField, triggerValue: args.triggerValue,
        targetField: args.targetField, action: args.action, now,
      }),
    )
    void audit(ctx, 'fieldVisibilityRule.created', 'FieldVisibilityRule', id, {
      entityType: args.entityType, triggerField: args.triggerField,
      triggerValue: args.triggerValue, targetField: args.targetField, action: args.action,
    })
    return {
      id, entityType: args.entityType, triggerField: args.triggerField,
      triggerValue: args.triggerValue, targetField: args.targetField, action: args.action,
    }
  }, true)
}

async function updateFieldVisibilityRule(
  _: unknown,
  args: { id: string; triggerField?: string; triggerValue?: string; targetField?: string; action?: string },
  ctx: GraphQLContext,
) {
  requireRole(ctx, 'admin')
  const { id } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const rows = await runQuery<{ p: Props }>(session, `
      MATCH (r:FieldVisibilityRule {id: $id, tenant_id: $tenantId})
      SET r += {
        trigger_field: coalesce($triggerField, r.trigger_field),
        trigger_value: coalesce($triggerValue, r.trigger_value),
        target_field:  coalesce($targetField,  r.target_field),
        action:        coalesce($action,       r.action),
        updated_at:    $now
      }
      RETURN properties(r) AS p
    `, {
      id, tenantId: ctx.tenantId,
      triggerField: args.triggerField ?? null,
      triggerValue: args.triggerValue ?? null,
      targetField:  args.targetField  ?? null,
      action:       args.action       ?? null,
      now,
    })
    if (!rows[0]) throw new GraphQLError('Regola non trovata')
    void audit(ctx, 'fieldVisibilityRule.updated', 'FieldVisibilityRule', args.id)
    return mapVisibilityRule(rows[0].p)
  }, true)
}

async function deleteFieldVisibilityRule(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  requireRole(ctx, 'admin')
  return withSession(async (session) => {
    const row = await runQueryOne<{ p: Props }>(session, `
      MATCH (r:FieldVisibilityRule {id: $id, tenant_id: $tenantId})
      RETURN properties(r) AS p
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Regola non trovata')
    await session.executeWrite((tx) =>
      tx.run(`MATCH (r:FieldVisibilityRule {id: $id, tenant_id: $tenantId}) DETACH DELETE r`,
        { id: args.id, tenantId: ctx.tenantId }),
    )
    void audit(ctx, 'fieldVisibilityRule.deleted', 'FieldVisibilityRule', args.id)
    return true
  }, true)
}

// ── Requirement Rule Mutations ────────────────────────────────────────────────

async function setFieldRequirement(
  _: unknown,
  args: { entityType: string; fieldName: string; required: boolean; workflowStep?: string | null },
  ctx: GraphQLContext,
) {
  requireRole(ctx, 'admin')
  const now = new Date().toISOString()

  return withSession(async (session) => {
    // Upsert: match on (tenant, entityType, fieldName, workflowStep)
    const existing = await runQueryOne<{ p: Props }>(session, `
      MATCH (r:FieldRequirementRule {
        tenant_id:     $tenantId,
        entity_type:   $entityType,
        field_name:    $fieldName,
        workflow_step: $workflowStep
      })
      RETURN properties(r) AS p
    `, {
      tenantId:     ctx.tenantId,
      entityType:   args.entityType,
      fieldName:    args.fieldName,
      workflowStep: args.workflowStep ?? null,
    })

    if (existing) {
      const rows = await runQuery<{ p: Props }>(session, `
        MATCH (r:FieldRequirementRule {id: $id, tenant_id: $tenantId})
        SET r.required = $required, r.updated_at = $now
        RETURN properties(r) AS p
      `, { id: existing.p['id'], tenantId: ctx.tenantId, required: args.required, now })
      void audit(ctx, 'fieldRequirementRule.updated', 'FieldRequirementRule', existing.p['id'] as string)
      return mapRequirementRule(rows[0]!.p)
    }

    const id = uuidv4()
    await session.executeWrite((tx) =>
      tx.run(`
        CREATE (r:FieldRequirementRule {
          id:            $id,
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          field_name:    $fieldName,
          required:      $required,
          workflow_step: $workflowStep,
          created_at:    $now,
          updated_at:    $now
        })
      `, {
        id, tenantId: ctx.tenantId, entityType: args.entityType,
        fieldName: args.fieldName, required: args.required,
        workflowStep: args.workflowStep ?? null, now,
      }),
    )
    void audit(ctx, 'fieldRequirementRule.created', 'FieldRequirementRule', id, {
      entityType: args.entityType, fieldName: args.fieldName,
      required: args.required, workflowStep: args.workflowStep ?? null,
    })
    return {
      id, entityType: args.entityType, fieldName: args.fieldName,
      required: args.required, workflowStep: args.workflowStep ?? null,
    }
  }, true)
}

async function deleteFieldRequirement(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  requireRole(ctx, 'admin')
  return withSession(async (session) => {
    const row = await runQueryOne<{ p: Props }>(session, `
      MATCH (r:FieldRequirementRule {id: $id, tenant_id: $tenantId})
      RETURN properties(r) AS p
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Regola non trovata')
    await session.executeWrite((tx) =>
      tx.run(`MATCH (r:FieldRequirementRule {id: $id, tenant_id: $tenantId}) DETACH DELETE r`,
        { id: args.id, tenantId: ctx.tenantId }),
    )
    void audit(ctx, 'fieldRequirementRule.deleted', 'FieldRequirementRule', args.id)
    return true
  }, true)
}

// ── Export ────────────────────────────────────────────────────────────────────

export const fieldRulesResolvers = {
  Query: {
    fieldVisibilityRules,
    fieldRequirementRules,
  },
  Mutation: {
    createFieldVisibilityRule,
    updateFieldVisibilityRule,
    deleteFieldVisibilityRule,
    setFieldRequirement,
    deleteFieldRequirement,
  },
}
