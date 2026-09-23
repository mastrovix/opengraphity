import { GraphQLError } from 'graphql'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { randomUUID } from 'crypto'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { invalidateRuleCache, DEFAULT_ROUTABLE_CHANNELS, ROUTABLE_CHANNELS_BY_EVENT, routableChannels, unroutableChannels } from '@opengraphity/notifications'
import {
  NOTIFICATION_BASE_TARGETS, isNotificationTarget, notificationTargetRole, roleNotificationTarget, applicableNotificationTargets, isTargetApplicable,
  WORKFLOW_STEP_PURPOSES, isWorkflowStepPurpose, isStepEnteredEventType,
  NOTIFICATION_SEVERITIES, type NotificationSeverity,
} from '@opengraphity/types'
import { SEEDED_EVENT_TYPES } from '../../lib/seedNotificationRules.js'
import { workflowEventTypeRows } from '../../lib/stepEvent.js'
import { validateEmail, validateEnum } from '../../lib/validation.js'
import { audit } from '../../lib/audit.js'
import { assertRolesExist, tenantRoles } from '../../lib/roles.js'

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

/**
 * I campi speciali delle regole — revisione del 14 set 2026 · NT-8.
 *  - `digestTime` è l'ora (HH:MM, nel fuso del cliente) del digest: la legge il
 *    job del digest (jobs/emailDigestWorker.ts). Prima creava un job per regola
 *    che non faceva niente, nel fuso del server.
 *  - `escalationTarget` e `slaWarningTarget` duplicavano il bersaglio della
 *    regola e nessuno li leggeva: i destinatari sono il bersaglio (`target`).
 *  - `slaWarningThresholdPercent` non apparteneva alla regola: il preavviso è
 *    della policy SLA (pagina SLA Policies), che è ciò che programma l'avviso.
 */
function assertSpecialFields(input: { digestTime?: string | null; escalationTarget?: string | null; slaWarningTarget?: string | null; slaWarningThresholdPercent?: number | null; escalationDelayMinutes?: number | null }): void {
  if (input.digestTime != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.digestTime)) {
    throw new ValidationError(`digestTime must be HH:MM (24h). Got: "${input.digestTime}"`, { key: 'errors.notificationRule.digestTime' })
  }
  if (input.escalationDelayMinutes != null && (!Number.isInteger(input.escalationDelayMinutes) || input.escalationDelayMinutes <= 0)) {
    throw new ValidationError('escalationDelayMinutes must be a positive whole number of minutes', { key: 'errors.notificationRule.escalationDelay' })
  }
  for (const [field, value] of [['escalationTarget', input.escalationTarget], ['slaWarningTarget', input.slaWarningTarget], ['slaWarningThresholdPercent', input.slaWarningThresholdPercent]] as const) {
    if (value != null) {
      throw new ValidationError(
        `${field} is no longer a rule field: the recipients are the rule's target, and the SLA warning lead time belongs to the SLA policy.`,
        { key: 'errors.notificationRule.retiredField', params: { field } },
      )
    }
  }
}

/**
 * The digest's explicit addresses, as the worker will use them: trimmed,
 * lower-cased, without blanks or repeats, each a valid address. Saved as
 * typed, a typo failed only at 08:00 and a repeated address got two digests
 * (review of 23 Sep 2026). null stays null: the field is not being changed.
 */
export function normalizeDigestRecipients(list: readonly string[] | null | undefined): string[] | null {
  if (list == null) return null
  const out: string[] = []
  for (const raw of list) {
    const email = raw.trim().toLowerCase()
    if (!email) continue
    validateEmail(email)
    if (!out.includes(email)) out.push(email)
  }
  return out
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
      `Target "${target}" is not a valid recipient. Allowed: ${[...NOTIFICATION_BASE_TARGETS, 'role:<role>'].join(', ')}`,
      {
        extensions: {
          code: 'BAD_USER_INPUT', target, allowedTargets: [...NOTIFICATION_BASE_TARGETS, 'role:<role>'],
          i18n: { key: 'errors.notificationRule.badTarget', params: { target, allowed: [...NOTIFICATION_BASE_TARGETS, 'role:<role>'].join(', ') } },
        },
      },
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
      `Target "${target}" cannot be resolved for the "${eventType}" event: the entity does not have that recipient at the moment the event happens. Allowed: ${allowed.join(', ')}`,
      {
        extensions: {
          code: 'BAD_USER_INPUT', eventType, target, allowedTargets: [...allowed],
          i18n: { key: 'errors.notificationRule.targetNotResolvable', params: { target, eventType, allowed: allowed.join(', ') } },
        },
      },
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
      `${field} only applies to step-entered event types (<entity>.step_entered): `
      + `"${eventType}" is not one, so the narrowing would not be applied.`,
      {
        extensions: {
          code: 'BAD_USER_INPUT', eventType, field,
          i18n: { key: 'errors.notificationRule.narrowingNotApplicable', params: { field, eventType } },
        },
      },
    )
  }
  if (field === 'stepPurpose' && !isWorkflowStepPurpose(value)) {
    throw new GraphQLError(
      `stepPurpose "${value}" out of vocabulary. Allowed: ${WORKFLOW_STEP_PURPOSES.join(', ')}.`,
      {
        extensions: {
          code: 'BAD_USER_INPUT', allowedPurposes: [...WORKFLOW_STEP_PURPOSES],
          i18n: { key: 'errors.notificationRule.badStepPurpose', params: { purpose: value, allowed: WORKFLOW_STEP_PURPOSES.join(', ') } },
        },
      },
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

/**
 * La tabella dei canali instradabili, così com'è nel pacchetto: l'interfaccia
 * non conosce nomi di eventi o canali.
 *
 * I bersagli per ruolo sono quelli DEL TENANT (revisione totale · E-39): i
 * ruoli creati dall'organizzazione non comparivano nella tendina, pur essendo
 * accettati dall'API.
 */
async function notificationRouting(tenantId: string) {
  const roles = await tenantRoles(tenantId)
  const roleTargets = [...roles.keys()].map(roleNotificationTarget)
  return {
    defaultChannels: [...DEFAULT_ROUTABLE_CHANNELS],
    byEventType:     Object.entries(ROUTABLE_CHANNELS_BY_EVENT).map(([eventType, channels]) => ({ eventType, channels: [...channels] })),
    targetsByEventType: SEEDED_EVENT_TYPES.map((eventType) => ({ eventType, targets: [...applicableNotificationTargets(eventType, roleTargets)] })),
    defaultTargets:  [...NOTIFICATION_BASE_TARGETS, ...roleTargets],
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

/**
 * La severità del messaggio, dal vocabolario condiviso con la pagina e il
 * pannello (NT-1: prima la validazione ammetteva le priorità dei ticket, e la
 * pagina non riusciva a salvare nessuna delle quattro severità che offriva).
 */
function assertSeverityKnown(severity: string): void {
  validateEnum(severity as NotificationSeverity, NOTIFICATION_SEVERITIES, 'severityOverride')
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
  if (input.severityOverride != null) assertSeverityKnown(input.severityOverride)
  assertSpecialFields(input)
  if (input.target != null) assertTargetKnown(input.target)
  const digestRecipients = normalizeDigestRecipients(input.digestRecipients)
  if (input.target != null) await assertRolesExist(ctx.tenantId, [notificationTargetRole(input.target)].filter((k): k is string => k !== null))
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
      if (!current.records.length) throw new NotFoundError('NotificationRule')
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
          digestRecipients:           digestRecipients,
        },
      ),
    )
    if (!result.records.length) throw new NotFoundError('NotificationRule')
    const props = result.records[0].get('r').properties as Record<string, unknown>
    const produced = await producedEventTypes(session, ctx.tenantId)
    const rule = mapRule(props, produced.has(props['event_type'] as string))
    invalidateRuleCache(ctx.tenantId, rule.eventType)
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
  if (input.severityOverride != null) assertSeverityKnown(input.severityOverride)
  assertSpecialFields(input)
  assertTargetKnown(input.target)
  const digestRecipients = normalizeDigestRecipients(input.digestRecipients)
  assertTargetApplicable(input.eventType, input.target)
  await assertRolesExist(ctx.tenantId, [notificationTargetRole(input.target)].filter((k): k is string => k !== null))
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
        `A rule for "${input.eventType}"${narrowing} already exists: edit it instead of creating a second one `
        + `(with two identical rules the dispatcher would apply only one, and which one is not defined).`,
        {
          extensions: {
            code: 'BAD_USER_INPUT', existingRuleId: dup.records[0].get('id'),
            i18n: { key: 'errors.notificationRule.duplicate', params: { eventType: input.eventType, narrowing } },
          },
        },
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
          digestRecipients:           digestRecipients,
          now,
        },
      ),
    )
    const props = result.records[0].get('r').properties as Record<string, unknown>
    const produced = await producedEventTypes(session, ctx.tenantId)
    const rule = mapRule(props, produced.has(props['event_type'] as string))
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
    if (!result.records.length) throw new GraphQLError('Rule not found, or not deletable', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.notificationRule.notDeletable' } } })
    const eventType = result.records[0].get('eventType') as string
    invalidateRuleCache(ctx.tenantId, eventType)
    void audit(ctx, 'notification_rule.deleted', 'NotificationRule', id)
    return true
  }, true)
}

export const notificationRuleResolvers = {
  Query:    {
    notificationRules, workflowEventTypes,
    // E-39: l'instradamento dipende dai RUOLI del tenant, quindi passa dal contesto.
    notificationRouting: (_: unknown, __: unknown, ctx: GraphQLContext) => notificationRouting(ctx.tenantId),
  },
  Mutation: { createNotificationRule, updateNotificationRule, deleteNotificationRule },
}
