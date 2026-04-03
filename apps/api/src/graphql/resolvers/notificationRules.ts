import { randomUUID } from 'crypto'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { invalidateRuleCache } from '@opengraphity/notifications'
import { validateEnum } from '../../lib/validation.js'

function mapRule(props: Record<string, unknown>) {
  return {
    id:               props['id']                as string,
    eventType:        props['event_type']        as string,
    enabled:          props['enabled']           as boolean,
    severityOverride: (props['severity_override'] ?? 'info') as string,
    titleKey:         props['title_key']         as string,
    channels:         (props['channels']         as string[]) ?? ['in_app'],
    target:           (props['target']           as string)   ?? 'all',
    conditions:       (props['conditions']       ?? null) as string | null,
    isSeed:           (props['is_seed']          ?? false)   as boolean,
  }
}

async function notificationRules(_: unknown, __: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (r:NotificationRule {tenant_id: $tenantId})
         RETURN r ORDER BY r.event_type`,
        { tenantId: ctx.tenantId },
      ),
    )
    return result.records.map((rec) => mapRule(rec.get('r').properties as Record<string, unknown>))
  })
}

async function updateNotificationRule(
  _: unknown,
  { id, input }: {
    id: string
    input: {
      enabled?:          boolean | null
      severityOverride?: string  | null
      channels?:         string[]| null
      target?:           string  | null
    }
  },
  ctx: GraphQLContext,
) {
  if (input.severityOverride) {
    validateEnum(input.severityOverride, ['low', 'medium', 'high', 'critical', ''] as const, 'severityOverride')
  }
  return withSession(async (session) => {
    const now = new Date().toISOString()
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (r:NotificationRule {id: $id, tenant_id: $tenantId})
         SET r.updated_at = $now
           , r.enabled           = CASE WHEN $enabled          IS NOT NULL THEN $enabled          ELSE r.enabled           END
           , r.severity_override = CASE WHEN $severityOverride IS NOT NULL THEN $severityOverride ELSE r.severity_override END
           , r.channels          = CASE WHEN $channels         IS NOT NULL THEN $channels         ELSE r.channels          END
           , r.target            = CASE WHEN $target           IS NOT NULL THEN $target           ELSE r.target            END
         RETURN r`,
        {
          id,
          tenantId:         ctx.tenantId,
          now,
          enabled:          input.enabled          ?? null,
          severityOverride: input.severityOverride ?? null,
          channels:         input.channels         ?? null,
          target:           input.target           ?? null,
        },
      ),
    )
    if (!result.records.length) throw new Error('NotificationRule non trovata')
    const props = result.records[0].get('r').properties as Record<string, unknown>
    const rule = mapRule(props)
    invalidateRuleCache(ctx.tenantId, rule.eventType)
    return rule
  }, true)
}

async function createNotificationRule(
  _: unknown,
  { input }: {
    input: {
      eventType:        string
      enabled?:         boolean | null
      severityOverride?:string  | null
      titleKey:         string
      channels:         string[]
      target:           string
    }
  },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const now = new Date().toISOString()
    const id  = randomUUID()
    const result = await session.executeWrite((tx) =>
      tx.run(
        `CREATE (r:NotificationRule {
           id:                $id,
           tenant_id:         $tenantId,
           event_type:        $eventType,
           enabled:           $enabled,
           severity_override: $severityOverride,
           title_key:         $titleKey,
           channels:          $channels,
           target:            $target,
           conditions:        null,
           is_seed:           false,
           created_at:        $now,
           updated_at:        $now
         })
         RETURN r`,
        {
          id,
          tenantId:         ctx.tenantId,
          eventType:        input.eventType,
          enabled:          input.enabled          ?? true,
          severityOverride: input.severityOverride ?? 'info',
          titleKey:         input.titleKey,
          channels:         input.channels,
          target:           input.target,
          now,
        },
      ),
    )
    const props = result.records[0].get('r').properties as Record<string, unknown>
    return mapRule(props)
  }, true)
}

async function deleteNotificationRule(
  _: unknown,
  { id }: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (r:NotificationRule {id: $id, tenant_id: $tenantId})
         WHERE r.is_seed = false OR r.is_seed IS NULL
         WITH r, r.event_type AS eventType
         DELETE r
         RETURN eventType`,
        { id, tenantId: ctx.tenantId },
      ),
    )
    if (!result.records.length) throw new Error('Regola non trovata o non eliminabile')
    const eventType = result.records[0].get('eventType') as string
    invalidateRuleCache(ctx.tenantId, eventType)
    return true
  }, true)
}

export const notificationRuleResolvers = {
  Query:    { notificationRules },
  Mutation: { createNotificationRule, updateNotificationRule, deleteNotificationRule },
}
