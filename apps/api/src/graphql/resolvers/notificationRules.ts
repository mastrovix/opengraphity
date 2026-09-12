import { GraphQLError } from 'graphql'
import { randomUUID } from 'crypto'
import type { Queue } from 'bullmq'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { invalidateRuleCache, DEFAULT_ROUTABLE_CHANNELS, ROUTABLE_CHANNELS_BY_EVENT, routableChannels, unroutableChannels } from '@opengraphity/notifications'
import {
  NOTIFICATION_TARGETS, isNotificationTarget, applicableNotificationTargets, isTargetApplicable,
  WORKFLOW_STEP_PURPOSES, isWorkflowStepPurpose, isStepEnteredEventType,
} from '@opengraphity/types'
import { SEEDED_EVENT_TYPES } from '../../lib/seedNotificationRules.js'
import { workflowEventTypeRows } from '../../lib/stepEvent.js'
import { validateEnum } from '../../lib/validation.js'
import { audit } from '../../lib/audit.js'
import { getQueue } from '../../lib/bullmq.js'

// Shared queue for notification jobs
let _notifQueue: Queue | null = null
function getNotifQueue(): Queue {
  if (!_notifQueue) _notifQueue = getQueue('notification-jobs')
  return _notifQueue
}

function mapRule(props: Record<string, unknown>, eventProduced = true) {
  const digestRecipients = props['digest_recipients']
  return {
    stepPurpose:      (props['step_purpose']  ?? null) as string | null,
    stepCategory:     (props['step_category'] ?? null) as string | null,
    eventProduced,
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

/**
 * Una regola può chiedere solo canali che il dispatcher sa instradare per il
 * suo tipo di evento (ROUTABLE_CHANNELS_BY_EVENT, sorgente unica in
 * @opengraphity/notifications). Rifiutare qui, in scrittura, è la prima linea:
 * la seconda è l'errore esplicito del dispatcher (D3.1). Canali vuoti → la
 * regola non notificherebbe nulla: anche questo è un errore, non un default.
 */
function assertChannelsRoutable(eventType: string, channels: readonly string[]): void {
  if (channels.length === 0) {
    throw new GraphQLError(`A notification rule needs at least one channel (routable for ${eventType}: ${routableChannels(eventType).join(', ')})`, { extensions: { code: 'BAD_USER_INPUT' } })
  }
  const bad = unroutableChannels(eventType, channels)
  if (bad.length > 0) {
    throw new GraphQLError(
      `Channels [${bad.join(', ')}] cannot be routed for ${eventType} — the dispatcher has no formatter for them. Routable: ${routableChannels(eventType).join(', ')}`,
      { extensions: { code: 'BAD_USER_INPUT', eventType, unroutableChannels: bad, routableChannels: [...routableChannels(eventType)] } },
    )
  }
}

/**
 * Il bersaglio deve essere uno di quelli che il dispatcher sa risolvere
 * (`NOTIFICATION_TARGETS` in @opengraphity/types, la stessa lista che
 * l'interfaccia offre). Prima il campo veniva scritto senza controllo e poi
 * ignorato in consegna: `role:manager` — un ruolo che l'autenticazione non
 * conosce (D-13) — era salvabile e non avrebbe mai selezionato nessuno.
 * Rifiutare qui è la prima linea; la seconda è l'errore del job nel
 * dispatcher (D-23).
 */
function assertTargetKnown(target: string): void {
  if (!isNotificationTarget(target)) {
    throw new GraphQLError(
      `Target "${target}" non è un destinatario valido. Ammessi: ${NOTIFICATION_TARGETS.join(', ')}`,
      { extensions: { code: 'BAD_USER_INPUT', target, allowedTargets: [...NOTIFICATION_TARGETS] } },
    )
  }
}

/**
 * Un bersaglio valido ma impossibile per QUEL tipo di evento è una regola che
 * non consegnerà mai niente: alla nascita di un incident non esistono ancora
 * assegnatario né team (`CreateIncidentInput` non li accetta), quindi
 * `incident.created → team_owner` fa fallire il job a ogni incident creato.
 * Prima il bersaglio veniva ignorato e il difetto non si vedeva. Stessa forma
 * di `assertChannelsRoutable`: la tabella sta in @opengraphity/types e la usa
 * anche la tendina dell'interfaccia.
 */
function assertTargetApplicable(eventType: string, target: string): void {
  if (!isTargetApplicable(eventType, target)) {
    const allowed = applicableNotificationTargets(eventType)
    throw new GraphQLError(
      `Target "${target}" non può essere risolto per l'evento "${eventType}": l'entità non ha quel destinatario nel momento in cui l'evento accade. Ammessi: ${allowed.join(', ')}`,
      { extensions: { code: 'BAD_USER_INPUT', eventType, target, allowedTargets: [...allowed] } },
    )
  }
}

/**
 * Scopo e categoria del passo restringono SOLO le regole sul tipo stabile
 * `<entità>.step_entered`: su `incident.created` non vogliono dire niente, e
 * una regola che li porta lì sembrerebbe ristretta senza esserlo. Uno scopo
 * fuori dal vocabolario chiuso è rifiutato nominando i valori ammessi.
 *
 * `''` = togli il restringimento; `undefined`/`null` = non mandato.
 */
export function normalizeStepNarrowing(
  eventType: string,
  raw: string | null | undefined,
  field: 'stepPurpose' | 'stepCategory',
): string | null | undefined {
  if (raw == null) return undefined
  const value = raw.trim()
  if (value === '') return null
  if (!isStepEnteredEventType(eventType)) {
    throw new GraphQLError(
      `${field} vale solo per i tipi di evento di ingresso in un passo (<entità>.step_entered): ` +
      `"${eventType}" non lo è, quindi il restringimento non verrebbe applicato.`,
      { extensions: { code: 'BAD_USER_INPUT', eventType, field } },
    )
  }
  if (field === 'stepPurpose' && !isWorkflowStepPurpose(value)) {
    throw new GraphQLError(
      `stepPurpose "${value}" fuori vocabolario. Ammessi: ${WORKFLOW_STEP_PURPOSES.join(', ')}.`,
      { extensions: { code: 'BAD_USER_INPUT', allowedPurposes: [...WORKFLOW_STEP_PURPOSES] } },
    )
  }
  return value
}

/**
 * I tipi di evento che qualcosa produce davvero per questo tenant: quelli
 * seminati dal prodotto, quelli derivati dai suoi workflow (D-22) e i tre che
 * l'interfaccia offre senza seminarli. Serve a marcare le regole che non
 * scatteranno mai (`eventProduced: false`) invece di lasciarle apparire
 * identiche alle altre.
 *
 * Limite dichiarato: un tipo SEMINATO è considerato producibile per
 * definizione. È corretto solo se il seed non semina tipi morti — ed è
 * esattamente la ragione per cui `incident.on_hold` è stato tolto dal seed
 * (B-16): una regola di fabbrica agganciata a un passo inventato è un difetto
 * del seed, non un caso da segnalare all'amministratore.
 */
const UI_ONLY_EVENT_TYPES = ['incident.escalation', 'digest.daily', 'workflow.step.entered'] as const

async function producedEventTypes(session: Parameters<typeof workflowEventTypeRows>[0], tenantId: string): Promise<Set<string>> {
  const rows = await workflowEventTypeRows(session, tenantId)
  return new Set<string>([...SEEDED_EVENT_TYPES, ...UI_ONLY_EVENT_TYPES, ...rows.map((r) => r.eventType)])
}

/** La tabella dei canali instradabili, così com'è nel pacchetto: l'interfaccia non conosce nomi di eventi o canali. */
function notificationRouting() {
  return {
    defaultChannels: [...DEFAULT_ROUTABLE_CHANNELS],
    byEventType:     Object.entries(ROUTABLE_CHANNELS_BY_EVENT).map(([eventType, channels]) => ({ eventType, channels: [...channels] })),
    targetsByEventType: SEEDED_EVENT_TYPES.map((eventType) => ({ eventType, targets: [...applicableNotificationTargets(eventType)] })),
    defaultTargets:  [...NOTIFICATION_TARGETS],
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
    const produced = await producedEventTypes(session, ctx.tenantId)
    return result.records.map((rec) => {
      const props = rec.get('r').properties as Record<string, unknown>
      return mapRule(props, produced.has(props['event_type'] as string))
    })
  })
}

/** I tipi di evento veri del tenant, derivati dai suoi passi (contratto con il web). */
async function workflowEventTypes(_: unknown, args: { entityType?: string | null }, ctx: GraphQLContext) {
  return withSession((session) => workflowEventTypeRows(session, ctx.tenantId, args.entityType ?? null))
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
      stepPurpose?:      string  | null
      stepCategory?:     string  | null
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
  if (input.target != null) assertTargetKnown(input.target)
  return withSession(async (session) => {
    const now = new Date().toISOString()
    let stepPurpose:  string | null | undefined
    let stepCategory: string | null | undefined
    if (input.channels != null || input.target != null || input.stepPurpose != null || input.stepCategory != null) {
      // The event type is on the node, not in the input: read it first so both
      // checks name the real type (a rule id is opaque to the client).
      const current = await session.executeRead((tx) =>
        tx.run(`MATCH (r:NotificationRule {id: $id, tenant_id: $tenantId}) RETURN r.event_type AS eventType`, { id, tenantId: ctx.tenantId }),
      )
      if (!current.records.length) throw new GraphQLError('NotificationRule non trovata', { extensions: { code: 'NOT_FOUND' } })
      const eventType = current.records[0].get('eventType') as string
      if (input.channels != null) assertChannelsRoutable(eventType, input.channels)
      if (input.target   != null) assertTargetApplicable(eventType, input.target)
      stepPurpose  = normalizeStepNarrowing(eventType, input.stepPurpose,  'stepPurpose')
      stepCategory = normalizeStepNarrowing(eventType, input.stepCategory, 'stepCategory')
    }
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (r:NotificationRule {id: $id, tenant_id: $tenantId})
         SET r.updated_at = $now
           , r.enabled           = CASE WHEN $enabled          IS NOT NULL THEN $enabled          ELSE r.enabled           END
           , r.severity_override = CASE WHEN $severityOverride IS NOT NULL THEN $severityOverride ELSE r.severity_override END
           , r.channels          = CASE WHEN $channels         IS NOT NULL THEN $channels         ELSE r.channels          END
           , r.target            = CASE WHEN $target           IS NOT NULL THEN $target           ELSE r.target            END
           // Restringimento del passo: NON coalesce, si deve poter togliere
           // ('' in ingresso → null qui, con il "given" a true).
           , r.step_purpose       = CASE WHEN $stepPurposeGiven  THEN $stepPurpose  ELSE r.step_purpose  END
           , r.step_category      = CASE WHEN $stepCategoryGiven THEN $stepCategory ELSE r.step_category END
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
          stepPurposeGiven:  stepPurpose  !== undefined,
          stepPurpose:       stepPurpose  ?? null,
          stepCategoryGiven: stepCategory !== undefined,
          stepCategory:      stepCategory ?? null,
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
    if (!result.records.length) throw new GraphQLError('NotificationRule non trovata', { extensions: { code: 'NOT_FOUND' } })
    const props = result.records[0].get('r').properties as Record<string, unknown>
    const produced = await producedEventTypes(session, ctx.tenantId)
    const rule = mapRule(props, produced.has(props['event_type'] as string))
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
      stepPurpose?:     string | null
      stepCategory?:    string | null
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
  assertChannelsRoutable(input.eventType, input.channels)
  assertTargetKnown(input.target)
  assertTargetApplicable(input.eventType, input.target)
  const stepPurpose  = normalizeStepNarrowing(input.eventType, input.stepPurpose,  'stepPurpose')
  const stepCategory = normalizeStepNarrowing(input.eventType, input.stepCategory, 'stepCategory')
  return withSession(async (session) => {
    const now = new Date().toISOString()
    const id  = randomUUID()
    // Due regole identiche per lo stesso tipo e lo stesso restringimento sono
    // ambigue: il dispatcher ne applicherebbe una sola, scelta a caso. Sul tipo
    // stabile del passo il restringimento fa parte dell'identità della regola.
    const dup = await session.executeRead((tx) =>
      tx.run(
        `MATCH (r:NotificationRule {tenant_id: $tenantId, event_type: $eventType})
         WHERE coalesce(r.step_purpose, '') = coalesce($stepPurpose, '')
           AND coalesce(r.step_category, '') = coalesce($stepCategory, '')
         RETURN r.id AS id LIMIT 1`,
        { tenantId: ctx.tenantId, eventType: input.eventType, stepPurpose: stepPurpose ?? null, stepCategory: stepCategory ?? null },
      ),
    )
    if (dup.records.length) {
      const narrowing = stepPurpose ? ` (scopo "${stepPurpose}")` : stepCategory ? ` (categoria "${stepCategory}")` : ''
      throw new GraphQLError(
        `Esiste già una regola per "${input.eventType}"${narrowing}: modificala invece di crearne una seconda ` +
        `(con due regole identiche il dispatcher ne applicherebbe una sola, e non è detto quale).`,
        { extensions: { code: 'BAD_USER_INPUT', existingRuleId: dup.records[0].get('id') } },
      )
    }
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
           step_purpose:      $stepPurpose,
           step_category:     $stepCategory,
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
          stepPurpose:      stepPurpose  ?? null,
          stepCategory:     stepCategory ?? null,
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
    const produced = await producedEventTypes(session, ctx.tenantId)
    const rule = mapRule(props, produced.has(props['event_type'] as string))
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
    if (!result.records.length) throw new GraphQLError('Regola non trovata o non eliminabile', { extensions: { code: 'NOT_FOUND' } })
    const eventType = result.records[0].get('eventType') as string
    invalidateRuleCache(ctx.tenantId, eventType)
    // Remove digest job if any. A failure here leaves a ghost digest job
    // firing for a deleted rule — the deletion must fail so the user retries.
    if (eventType === 'digest.daily') {
      await getNotifQueue().removeJobScheduler(`digest-${id}`)
    }
    void audit(ctx, 'notification_rule.deleted', 'NotificationRule', id)
    return true
  }, true)
}

export const notificationRuleResolvers = {
  Query:    { notificationRules, notificationRouting, workflowEventTypes },
  Mutation: { createNotificationRule, updateNotificationRule, deleteNotificationRule },
}
