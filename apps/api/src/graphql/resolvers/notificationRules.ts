import { randomUUID } from 'crypto'
import { Queue } from 'bullmq'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { invalidateRuleCache } from '@opengraphity/notifications'
import { validateEnum } from '../../lib/validation.js'
import { audit } from '../../lib/audit.js'
import { getRedisOptions } from '@opengraphity/events'

// Shared queue for notification jobs
let _notifQueue: Queue | null = null
function getNotifQueue(): Queue {
  if (!_notifQueue) _notifQueue = new Queue('notification-jobs', { connection: getRedisOptions() })
  return _notifQueue
}

function mapRule(props: Record<string, unknown>) {
  const digestRecipients = props['digest_recipients']
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
    escalationDelayMinutes:    props['escalation_delay_minutes'] != null ? Number(props['escalation_delay_minutes']) : null,
    escalationTarget:          (props['escalation_target']            ?? null) as string | null,
    escalationMessage:         (props['escalation_message']           ?? null) as string | null,
    slaWarningThresholdPercent:props['sla_warning_threshold_percent'] != null ? Number(props['sla_warning_threshold_percent']) : null,
    slaWarningTarget:          (props['sla_warning_target']           ?? null) as string | null,
    digestTime:                (props['digest_time']                  ?? null) as string | null,
    digestRecipients:          Array.isArray(digestRecipients) ? digestRecipients as string[] : null,
  }
}

async function syncDigestJob(ruleId: string, digestTime: string | null | undefined, enabled: boolean) {
  if (!digestTime || !enabled) return
  const [hour, minute] = (digestTime ?? '08:00').split(':').map(Number)
  const cron = `${minute ?? 0} ${hour ?? 8} * * *`
  const queue = getNotifQueue()
  await queue.upsertJobScheduler(`digest-${ruleId}`, { pattern: cron }, {
    name: 'digest',
    data: { type: 'digest', ruleId },
  })
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
      escalationDelayMinutes?:    number | null
      escalationTarget?:          string | null
      escalationMessage?:         string | null
      slaWarningThresholdPercent?:number | null
      slaWarningTarget?:          string | null
      digestTime?:                string | null
      digestRecipients?:          string[] | null
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
           , r.escalation_delay_minutes     = CASE WHEN $escalationDelayMinutes     IS NOT NULL THEN $escalationDelayMinutes     ELSE r.escalation_delay_minutes     END
           , r.escalation_target            = CASE WHEN $escalationTarget            IS NOT NULL THEN $escalationTarget            ELSE r.escalation_target            END
           , r.escalation_message           = CASE WHEN $escalationMessage           IS NOT NULL THEN $escalationMessage           ELSE r.escalation_message           END
           , r.sla_warning_threshold_percent= CASE WHEN $slaWarningThresholdPercent IS NOT NULL THEN $slaWarningThresholdPercent ELSE r.sla_warning_threshold_percent END
           , r.sla_warning_target           = CASE WHEN $slaWarningTarget           IS NOT NULL THEN $slaWarningTarget           ELSE r.sla_warning_target           END
           , r.digest_time                  = CASE WHEN $digestTime                 IS NOT NULL THEN $digestTime                 ELSE r.digest_time                  END
           , r.digest_recipients            = CASE WHEN $digestRecipients           IS NOT NULL THEN $digestRecipients           ELSE r.digest_recipients            END
         RETURN r`,
        {
          id,
          tenantId:         ctx.tenantId,
          now,
          enabled:          input.enabled          ?? null,
          severityOverride: input.severityOverride ?? null,
          channels:         input.channels         ?? null,
          target:           input.target           ?? null,
          escalationDelayMinutes:     input.escalationDelayMinutes     ?? null,
          escalationTarget:           input.escalationTarget           ?? null,
          escalationMessage:          input.escalationMessage          ?? null,
          slaWarningThresholdPercent: input.slaWarningThresholdPercent ?? null,
          slaWarningTarget:           input.slaWarningTarget           ?? null,
          digestTime:                 input.digestTime                 ?? null,
          digestRecipients:           input.digestRecipients           ?? null,
        },
      ),
    )
    if (!result.records.length) throw new Error('NotificationRule non trovata')
    const props = result.records[0].get('r').properties as Record<string, unknown>
    const rule = mapRule(props)
    invalidateRuleCache(ctx.tenantId, rule.eventType)
    if (rule.eventType === 'digest.daily') {
      await syncDigestJob(id, rule.digestTime, rule.enabled)
    }
    void audit(ctx, 'notification_rule.updated', 'NotificationRule', id)
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
      escalationDelayMinutes?:    number | null
      escalationTarget?:          string | null
      escalationMessage?:         string | null
      slaWarningThresholdPercent?:number | null
      slaWarningTarget?:          string | null
      digestTime?:                string | null
      digestRecipients?:          string[] | null
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
           escalation_delay_minutes:      $escalationDelayMinutes,
           escalation_target:             $escalationTarget,
           escalation_message:            $escalationMessage,
           sla_warning_threshold_percent: $slaWarningThresholdPercent,
           sla_warning_target:            $slaWarningTarget,
           digest_time:                   $digestTime,
           digest_recipients:             $digestRecipients,
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
          escalationDelayMinutes:     input.escalationDelayMinutes     ?? null,
          escalationTarget:           input.escalationTarget           ?? null,
          escalationMessage:          input.escalationMessage          ?? null,
          slaWarningThresholdPercent: input.slaWarningThresholdPercent ?? null,
          slaWarningTarget:           input.slaWarningTarget           ?? null,
          digestTime:                 input.digestTime                 ?? null,
          digestRecipients:           input.digestRecipients           ?? null,
          now,
        },
      ),
    )
    const props = result.records[0].get('r').properties as Record<string, unknown>
    const rule = mapRule(props)
    if (rule.eventType === 'digest.daily') {
      await syncDigestJob(id, rule.digestTime, rule.enabled)
    }
    void audit(ctx, 'notification_rule.created', 'NotificationRule', id)
    return rule
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
    // Remove digest job if any
    if (eventType === 'digest.daily') {
      try { await getNotifQueue().removeJobScheduler(`digest-${id}`) } catch { /* ignore */ }
    }
    void audit(ctx, 'notification_rule.deleted', 'NotificationRule', id)
    return true
  }, true)
}

export const notificationRuleResolvers = {
  Query:    { notificationRules },
  Mutation: { createNotificationRule, updateNotificationRule, deleteNotificationRule },
}
