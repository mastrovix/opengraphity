import { randomUUID } from 'crypto'
import { BaseConsumer } from '@opengraphity/events'
import type { DomainEvent, StepEnteredFacts } from '@opengraphity/types'
import { isStepEnteredEventType, stepEnteredEntityType, legacyStepEventType } from '@opengraphity/types'
import { getSession } from '@opengraphity/neo4j'
import { sseManager, InAppNotification } from './sse.js'
import { sendTeamsAdaptiveMessage, type TeamsAdaptiveCard } from './index.js'
import {
  loadChannels, dispatchIncidentNotification, dispatchChangeNotification, dispatchChangeTaskNotification,
  type ChannelPlatform,
} from './consumer.js'
import type { IncidentData, ChangeTaskPayload } from './formatters.js'
import { APP_URL } from './appUrl.js'
import { escapeHtml } from './escapeHtml.js'
import { assertRoutableChannels, notificationEntityPath, unroutableChannels } from './routing.js'
import { resolveNotificationRecipients, targetNeedsRecipients, type NotificationRecipient } from './recipients.js'

// ── Rule model ────────────────────────────────────────────────────────────────

interface NotificationRule {
  id:               string
  enabled:          boolean
  severityOverride: string
  titleKey:         string
  channels:         string[]
  target:           string
  /**
   * Restringimento delle regole sul tipo STABILE `<entità>.step_entered`
   * (D-22): la regola scatta solo per i passi con quello scopo / quella
   * categoria. `null` su entrambi = vale per ogni ingresso in un passo.
   * Su ogni altro tipo di evento non hanno senso e valgono `null`.
   */
  stepPurpose:      string | null
  stepCategory:     string | null
}

// ── Rule cache (60s TTL, per-process) ─────────────────────────────────────────

interface CachedRules { rules: NotificationRule[]; expiresAt: number }

const CACHE_TTL_MS = 60_000
const ruleCache = new Map<string, CachedRules>()

function cacheKey(tenantId: string, eventType: string): string {
  return `${tenantId}:${eventType}`
}

/**
 * TUTTE le regole del tenant per quel tipo, comprese quelle spente.
 *
 * Due differenze da prima, entrambe necessarie al tipo stabile (D-22):
 *  - una LISTA: sul tipo stabile convivono più regole, ciascuna per uno scopo
 *    o una categoria di passo;
 *  - le regole SPENTE non vengono scartate qui: chi decide deve poter
 *    distinguere «non esiste nessuna regola per questo passo» (e allora vale
 *    quella stabile) da «l'amministratore l'ha spenta» (e allora non si
 *    notifica: spegnere una regola non deve farne scattare un'altra).
 */
async function fetchRules(tenantId: string, eventType: string): Promise<NotificationRule[]> {
  const session = getSession()
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (r:NotificationRule {tenant_id: $tenantId, event_type: $eventType})
         RETURN r`,
        { tenantId, eventType },
      ),
    )
    return result.records.map((rec) => {
      const props = rec.get('r').properties as Record<string, unknown>
      return {
        id:               props['id']                as string,
        enabled:          Boolean(props['enabled']),
        severityOverride: (props['severity_override'] ?? 'info') as string,
        titleKey:         props['title_key']         as string,
        channels:         (props['channels']         as string[]) ?? ['in_app'],
        target:           (props['target']           as string)   ?? 'all',
        stepPurpose:      (props['step_purpose']     ?? null) as string | null,
        stepCategory:     (props['step_category']    ?? null) as string | null,
      }
    })
  } finally {
    await session.close()
  }
}

async function getRules(tenantId: string, eventType: string): Promise<NotificationRule[]> {
  const key = cacheKey(tenantId, eventType)
  const cached = ruleCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.rules
  const rules = await fetchRules(tenantId, eventType)
  ruleCache.set(key, { rules, expiresAt: Date.now() + CACHE_TTL_MS })
  return rules
}

/** La regola attiva per un tipo di evento «normale» (comportamento storico). */
async function getRule(tenantId: string, eventType: string): Promise<NotificationRule | null> {
  const rules = await getRules(tenantId, eventType)
  return rules.find((r) => r.enabled) ?? null
}

/**
 * La regola che vale per l'ingresso in QUESTO passo, fra quelle agganciate al
 * tipo stabile. Dalla più specifica alla più generica: scopo del passo →
 * categoria del passo → nessun restringimento. Una regola che restringe su uno
 * scopo o una categoria diversi non c'entra e viene ignorata.
 */
export function pickStepRule(rules: readonly NotificationRule[], facts: StepEnteredFacts): NotificationRule | null {
  const enabled = rules.filter((r) => r.enabled)
  const byPurpose = facts.step_purpose != null
    ? enabled.find((r) => r.stepPurpose === facts.step_purpose)
    : undefined
  if (byPurpose) return byPurpose
  const byCategory = facts.step_category != null
    ? enabled.find((r) => r.stepPurpose == null && r.stepCategory === facts.step_category)
    : undefined
  if (byCategory) return byCategory
  return enabled.find((r) => r.stepPurpose == null && r.stepCategory == null) ?? null
}

export function invalidateRuleCache(tenantId: string, eventType?: string): void {
  if (eventType) {
    ruleCache.delete(cacheKey(tenantId, eventType))
  } else {
    for (const key of ruleCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) ruleCache.delete(key)
    }
  }
}

// ── Payload helpers ───────────────────────────────────────────────────────────

function extractEntityId(payload: unknown): string | undefined {
  const p = payload as Record<string, unknown>
  const id = p['id'] ?? p['entity_id']
  return typeof id === 'string' ? id : undefined
}

function extractEntityType(eventType: string, payload: unknown): string {
  const p = payload as Record<string, unknown>
  if (typeof p['entity_type'] === 'string') return p['entity_type']
  return eventType.split('.')[0] ?? 'unknown'
}

/**
 * Corpo del messaggio per gli eventi il cui payload non ha né `title` né
 * `entity_type`/`entity_id` da cui la regola generica sotto possa ricavare
 * qualcosa di leggibile: i Servizi monitorati (il "titolo" del servizio è
 * `name` e lo stato è la salute), la salute del CI (senza questa voce il corpo
 * sarebbe «ci 4d0c9e…»), gli allarmi (`title — resource`) e le tempeste
 * (sorgente e ritmo). Senza una voce qui la notifica arriverebbe con il corpo
 * vuoto o con un uuid: un fallback silenzioso. Un campo mancante è un errore
 * del produttore dell'evento e viene segnalato, non nascosto.
 */
const monitoringEvent = (type: string) => (p: Record<string, unknown>) => `${required(p, 'title', type)} — ${required(p, 'resource', type)}`

const MESSAGE_BY_EVENT: Record<string, (p: Record<string, unknown>) => string> = {
  'service.health_changed':  (p) => `${required(p, 'name', 'service.health_changed')} — ${required(p, 'new_health', 'service.health_changed')}`,
  'service.incident_opened': (p) => `${required(p, 'name', 'service.incident_opened')} — ${required(p, 'health', 'service.incident_opened')} (${required(p, 'incident_number', 'service.incident_opened')})`,
  'ci.health_changed':       (p) => `${required(p, 'name', 'ci.health_changed')} — ${required(p, 'new_health', 'ci.health_changed')}`,
  'event.received':          monitoringEvent('event.received'),
  'event.resolved':          monitoringEvent('event.resolved'),
  'event.orphan':            monitoringEvent('event.orphan'),
  'event.suppressed':        monitoringEvent('event.suppressed'),
  'event.correlated':        monitoringEvent('event.correlated'),
  'event.flapping':          monitoringEvent('event.flapping'),
  'event.stable':            monitoringEvent('event.stable'),
  'event.storm_started':     (p) => `${required(p, 'source_name', 'event.storm_started')} — ${requiredNumber(p, 'rate_per_minute', 'event.storm_started')}/min`,
  'event.storm_ended':       (p) => `${required(p, 'source_name', 'event.storm_ended')} — ${requiredNumber(p, 'events', 'event.storm_ended')} allarmi in ${requiredNumber(p, 'duration_minutes', 'event.storm_ended')} min`,
}

function required(p: Record<string, unknown>, field: string, eventType: string): string {
  const v = p[field]
  if (typeof v !== 'string' || !v) throw new Error(`${eventType} payload has no "${field}": the notification would have an empty body`)
  return v
}

function requiredNumber(p: Record<string, unknown>, field: string, eventType: string): number {
  const v = p[field]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${eventType} payload has no numeric "${field}": the notification would have an empty body`)
  return v
}

function extractMessage(eventType: string, payload: unknown): string {
  const p = payload as Record<string, unknown>
  const explicit = MESSAGE_BY_EVENT[eventType]
  if (explicit) return explicit(p)

  // Tipo stabile dell'ingresso in un passo: il corpo dice a che passo è
  // arrivato il ticket con l'ETICHETTA del passo (quella che il cliente ha
  // scritto), non con il nome tecnico.
  if (isStepEnteredEventType(eventType)) {
    const title = typeof p['title'] === 'string' && p['title'] ? p['title'] as string : null
    const label = required(p, 'step_label', eventType)
    return title ? `${title} — ${label}` : label
  }

  const title      = typeof p['title']      === 'string' && p['title']      ? p['title']      as string : null
  const severity   = typeof p['severity']   === 'string' && p['severity']   ? p['severity']   as string : null
  const assignedTo = typeof p['assignedTo'] === 'string' && p['assignedTo'] !== '—' ? p['assignedTo'] as string : null
  const changeTitle= typeof p['changeTitle']=== 'string' && p['changeTitle'] ? p['changeTitle'] as string : null
  const ciName     = typeof p['ciName']     === 'string' && p['ciName'] !== '—' ? p['ciName']     as string : null
  const minRem     = typeof p['minutes_remaining'] === 'number' ? (p['minutes_remaining'] as number) : null
  const entityType = typeof p['entity_type'] === 'string' ? p['entity_type'] as string : null
  const entityId   = typeof p['entity_id']   === 'string' ? p['entity_id']   as string : null

  if (minRem !== null) return String(minRem)
  if (changeTitle)     return ciName ? `${changeTitle} — ${ciName}` : changeTitle
  if (entityType && entityId && !title) return `${entityType} ${entityId}`

  const parts: string[] = []
  if (title)      parts.push(title)
  if (severity && eventType === 'incident.created') parts.push(severity)
  if (assignedTo) parts.push(assignedTo)
  return parts.join(' — ')
}

/**
 * HTML body of a notification email. Title/message derive from user input
 * (ticket titles, step names): every interpolation is escaped so a crafted
 * title cannot inject markup or links into the admins' mailbox (D-11).
 * The link comes from the shared `entity_type → path` table (the same one the
 * in-app panel uses): no link at all beats a link to a route that does not
 * exist (D3.2). Exported for tests.
 */
export function renderNotificationEmail(notification: InAppNotification): string {
  const path = notificationEntityPath(notification.entity_type, notification.entity_id)
  const link = path
    ? `<a href="${escapeHtml(`${APP_URL}${path}`)}" style="color:#0EA5E9;">Vedi dettagli</a>`
    : ''
  return `<div style="font-family:Arial,sans-serif;padding:16px;">
          <h2 style="color:#0F172A;margin:0 0 8px;">${escapeHtml(notification.title)}</h2>
          <p style="color:#64748B;margin:0 0 16px;">${escapeHtml(notification.message)}</p>
          ${link}
        </div>`
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export class NotificationDispatcher extends BaseConsumer<unknown> {
  constructor() {
    super('notification-service')
  }

  async process(event: DomainEvent<unknown>): Promise<void> {
    // Workflow step custom notification (embed rule in payload, no DB lookup)
    if (event.type === 'workflow.step.entered') {
      await this.processWorkflowStep(event)
      return
    }

    // Tipo STABILE dell'ingresso in un passo (`incident.step_entered`): la
    // regola si sceglie per scopo/categoria del passo, non per nome (D-22).
    if (isStepEnteredEventType(event.type)) {
      await this.processStepEntered(event)
      return
    }

    const rule = await getRule(event.tenant_id, event.type)
    if (!rule) return
    await this.deliver(event, rule)
  }

  /**
   * Ingresso in un passo, tipo stabile. Precedenza:
   *  1. esiste una regola per l'ALIAS `<entità>.<nome del passo>`? Allora è
   *     quella a comandare e la consegna avviene sull'evento alias (che viene
   *     pubblicato insieme a questo): qui si esce, altrimenti il destinatario
   *     riceverebbe DUE notifiche per la stessa transizione. Vale anche se la
   *     regola dell'alias è spenta: spegnere una regola non deve farne
   *     scattare un'altra al suo posto.
   *  2. altrimenti la regola del tipo stabile più specifica che combacia
   *     (scopo del passo → categoria → nessun restringimento).
   *  3. nessuna delle due: un avviso nei log che NOMINA passo, scopo e tipo.
   *     È il punto in cui prima si usciva su `if (!rule) return`, senza una
   *     riga: un passo personalizzato non notificava e non si sapeva perché.
   */
  private async processStepEntered(event: DomainEvent<unknown>): Promise<void> {
    const p = event.payload as Record<string, unknown>
    const entityType = stepEnteredEntityType(event.type)
    if (!entityType) throw new Error(`${event.type}: tipo di evento di passo malformato`)
    const stepName = p['step_name']
    if (typeof stepName !== 'string' || !stepName) {
      throw new Error(`${event.type} payload has no "step_name": impossibile scegliere la regola del passo`)
    }
    const facts: StepEnteredFacts = {
      step_id:       typeof p['step_id'] === 'string' ? p['step_id'] as string : '',
      step_name:     stepName,
      step_label:    typeof p['step_label'] === 'string' && p['step_label'] ? p['step_label'] as string : stepName,
      step_purpose:  typeof p['step_purpose']  === 'string' ? p['step_purpose']  as string : null,
      step_category: typeof p['step_category'] === 'string' ? p['step_category'] as string : null,
    }

    const aliasType  = legacyStepEventType(entityType, stepName)
    const aliasRules = await getRules(event.tenant_id, aliasType)
    if (aliasRules.length > 0) return

    const rule = pickStepRule(await getRules(event.tenant_id, event.type), facts)
    if (!rule) {
      console.warn(
        `[notifications] ${event.type}: nessuna regola per il passo "${facts.step_name}" ` +
        `(scopo: ${facts.step_purpose ?? 'nessuno'}, categoria: ${facts.step_category ?? 'nessuna'}, ` +
        `tenant ${event.tenant_id}). Nessuna notifica inviata. Per notificarlo crea una regola su ` +
        `"${event.type}" (eventualmente ristretta allo scopo o alla categoria del passo) oppure su "${aliasType}".`,
      )
      return
    }
    await this.deliver(event, rule, facts.step_label)
  }

  /**
   * Consegna di una notifica guidata da una NotificationRule. `titleFallback`
   * è il testo da mostrare quando la chiave i18n del titolo non è tradotta
   * (per i passi: l'etichetta del passo — B-16): il pannello mostrava la
   * chiave grezza `notification.custom.step.title`.
   */
  private async deliver(event: DomainEvent<unknown>, rule: NotificationRule, titleFallback?: string): Promise<void> {
    // Channels the dispatcher cannot route for this event type (e.g. `slack`
    // on `event.storm_started`, which has no Slack formatter). The routable
    // ones are delivered first, then the job fails naming the others — the
    // same contract as workflow.step.entered: a configured channel never
    // disappears in silence (D3.1). The rules UI and the resolver refuse such
    // rules; this is the last line for rules written by other means.
    const unroutable = unroutableChannels(event.type, rule.channels)
    const channels   = rule.channels.filter((c) => !unroutable.includes(c))

    const notification: InAppNotification = {
      id:          randomUUID(),
      type:        event.type,
      title:       rule.titleKey,
      title_fallback: titleFallback,
      message:     extractMessage(event.type, event.payload),
      severity:    rule.severityOverride as InAppNotification['severity'],
      entity_id:   extractEntityId(event.payload),
      entity_type: extractEntityType(event.type, event.payload),
      timestamp:   event.timestamp,
      read:        false,
    }

    // Destinatari del bersaglio della regola (D-23), risolti PRIMA di
    // consegnare: se il bersaglio non seleziona nessuno la consegna non parte
    // affatto e il job fallisce nominandolo — l'alternativa (trasmettere a
    // tutto il tenant) è esattamente la fuga di riservatezza da correggere.
    // Slack/Teams vanno ai canali del tenant (sono abbonamenti di canale, non
    // di persona): il bersaglio non li riguarda e non vengono risolti se la
    // regola chiede solo quelli.
    const recipients = channels.some((c) => c === 'in_app' || c === 'email')
      ? await this.resolveRecipients(event, rule.target)
      : null

    if (channels.includes('in_app')) {
      this.sendInApp(event.tenant_id, notification, recipients)
    }

    if (channels.some((c) => c === 'slack' || c === 'teams')) {
      await this.dispatchToChannels(event, channels)
    }

    if (channels.includes('email')) {
      await this.dispatchEmail(event, notification, recipients)
    }

    if (unroutable.length > 0) assertRoutableChannels(event.type, rule.channels)
  }

  private async processWorkflowStep(event: DomainEvent<unknown>): Promise<void> {
    const p = event.payload as {
      stepName: string
      /** Etichetta del passo: titolo di ripiego quando la chiave i18n non c'è (B-16). */
      stepLabel?: string
      entityType: string
      entityId: string
      /** `target` assente = regola di passo scritta prima dei bersagli: trasmissione al tenant. */
      notifyRule: { title_key: string; severity: string; channels: string[]; target?: string }
    }
    const nr = p.notifyRule
    if (!nr) throw new Error('workflow.step.entered event without notifyRule payload')

    const notification: InAppNotification = {
      id:          randomUUID(),
      type:        'workflow.step.entered',
      title:       nr.title_key,
      title_fallback: p.stepLabel ?? p.stepName,
      message:     p.stepLabel ?? p.stepName,
      severity:    nr.severity as InAppNotification['severity'],
      entity_id:   p.entityId,
      entity_type: p.entityType,
      timestamp:   event.timestamp,
      read:        false,
    }

    // Stesso bersaglio, stesse regole delle notifiche da NotificationRule: la
    // regola del passo vive nel payload, ma «solo l'assegnatario» deve valere
    // anche qui (prima il campo era ignorato in entrambi i percorsi).
    const recipients = nr.channels.some((c) => c === 'in_app' || c === 'email')
      ? await this.resolveRecipients(event, nr.target ?? 'all', { type: p.entityType, id: p.entityId })
      : null

    if (nr.channels.includes('in_app')) {
      this.sendInApp(event.tenant_id, notification, recipients)
    }
    if (nr.channels.includes('email')) {
      await this.dispatchEmail(event, notification, recipients)
    }
    // Slack/Teams for workflow steps are not implemented: refuse loudly instead
    // of silently dropping a channel the admin configured (same table as the
    // rule-driven events: routing.ts).
    const unsupported = unroutableChannels('workflow.step.entered', nr.channels)
    if (unsupported.length > 0) {
      throw new Error(`workflow.step.entered notify_rule requests unsupported channels [${unsupported.join(', ')}] — only in_app and email are implemented`)
    }
  }

  // ── Bersaglio della regola → destinatari (D-23) ─────────────────────────────

  /**
   * Destinatari del bersaglio, oppure `null` per `all`: la trasmissione a tutto
   * il tenant (in-app) e l'email ad admin/operator, cioè il comportamento
   * storico, che per `all` è quello giusto. Per ogni altro bersaglio la lista
   * è non vuota per costruzione (`resolveNotificationRecipients` fallisce
   * nominando il bersaglio se non seleziona nessuno).
   */
  private async resolveRecipients(
    event: DomainEvent<unknown>,
    target: string,
    entity?: { type: string; id: string | undefined },
  ): Promise<NotificationRecipient[] | null> {
    if (!targetNeedsRecipients(target)) return null
    return resolveNotificationRecipients(event.tenant_id, target, {
      type:      entity?.type ?? extractEntityType(event.type, event.payload),
      id:        entity ? entity.id : extractEntityId(event.payload),
      eventType: event.type,
    })
  }

  /** In-app: trasmissione al tenant per `all`, una consegna per destinatario altrimenti. */
  private sendInApp(tenantId: string, notification: InAppNotification, recipients: NotificationRecipient[] | null): void {
    if (recipients === null) {
      sseManager.sendToTenant(tenantId, notification)
      return
    }
    for (const recipient of recipients) {
      sseManager.sendToUser(tenantId, recipient.id, notification)
    }
  }

  // ── Slack / Teams channel dispatch (driven by rule.channels) ────────────────

  private async dispatchToChannels(event: DomainEvent<unknown>, channels: string[]): Promise<void> {
    const hasSlack = channels.includes('slack')
    const hasTeams = channels.includes('teams')
    if (!hasSlack && !hasTeams) return

    // Change approved → Slack
    if (event.type === 'change.approved') {
      const p = event.payload as Record<string, unknown>
      if (p['id'] && p['title']) {
        await dispatchChangeNotification(event.tenant_id, {
          id:       p['id']     as string,
          title:    p['title']  as string,
          type:     (p['type']  as string) ?? '—',
          status:   (p['status'] as string) ?? 'scheduled',
          tenantId: event.tenant_id,
        })
      }
      return
    }

    // Change task assigned → Slack
    if (event.type === 'change.task_assigned') {
      await dispatchChangeTaskNotification(event.tenant_id, event.payload as ChangeTaskPayload)
      return
    }

    // Platforms the rule routes this event to. Every Slack/Teams message goes
    // to the TENANT's NotificationChannel rows (loadChannels) — never to a
    // process-wide webhook from env, which would mix tenants (D-07).
    const platforms = channels.filter((c): c is ChannelPlatform => c === 'slack' || c === 'teams')

    // SLA breached → tenant Slack/Teams channels subscribed to 'sla_breach'
    if (event.type === 'sla.breached') {
      const p = event.payload as Record<string, unknown>
      if (p['entity_type'] === 'incident') {
        const incident: IncidentData = {
          id:       p['entity_id'] as string,
          title:    `SLA breach su incident ${p['entity_id']}`,
          severity: 'high',
          status:   'open',
          tenantId: event.tenant_id,
        }
        await dispatchIncidentNotification(event.tenant_id, 'sla_breach', incident, platforms)
      } else if (hasTeams) {
        const card: TeamsAdaptiveCard = {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: '🔴 SLA Violato', weight: 'Bolder', size: 'Large', wrap: true },
            { type: 'TextBlock', text: `SLA superato per ${String(p['entity_type'])} ${String(p['entity_id'])}`, wrap: true },
            { type: 'FactSet', facts: [
              { title: 'Entity Type', value: String(p['entity_type'] ?? '—') },
              { title: 'Entity ID',   value: String(p['entity_id']   ?? '—') },
              { title: 'Breached At', value: String(p['breached_at'] ?? '—') },
            ] },
          ],
        }
        const teamsChannels = await loadChannels(event.tenant_id, 'sla_breach', ['teams'])
        for (const ch of teamsChannels) {
          if (!ch.webhookUrl) throw new Error(`Teams NotificationChannel ${ch.id} has no webhook_url`)
          await sendTeamsAdaptiveMessage(ch.webhookUrl, card)
        }
      }
      return
    }

    // Incident Slack/Teams dispatch (a critical incident.created reaches the
    // tenant's Teams channels through the same path — formatTeamsIncident).
    const INCIDENT_EVENT_MAP: Record<string, 'assigned' | 'resolved' | 'escalation' | 'sla_breach'> = {
      'incident.created':   'assigned',
      'incident.resolved':  'resolved',
      'incident.escalated': 'escalation',
      'incident.assigned':  'assigned',
    }
    const notifType = INCIDENT_EVENT_MAP[event.type]
    // Unreachable from process() (unroutable channels are filtered out
    // beforehand): kept as a loud guard so a new caller cannot reintroduce the
    // silent drop of a Slack/Teams channel for an event without a formatter.
    if (!notifType) {
      assertRoutableChannels(event.type, channels)
      throw new Error(`dispatchToChannels: no Slack/Teams formatter for ${event.type} — routing.ts and this map disagree`)
    }

    const p = event.payload as Record<string, unknown>
    if (!p['id'] || !p['title']) throw new Error(`incident notification event missing id/title: ${event.type}`)

    const incident: IncidentData = {
      id:           p['id']         as string,
      title:        p['title']      as string,
      severity:     p['severity']   as string,
      status:       p['status']     as string,
      ciNames:      typeof p['ciName'] === 'string' && p['ciName'] !== '—' ? [p['ciName'] as string] : undefined,
      assigneeName: typeof p['assignedTo'] === 'string' && p['assignedTo'] !== '—' ? p['assignedTo'] as string : null,
      tenantId:     event.tenant_id,
    }
    await dispatchIncidentNotification(event.tenant_id, notifType, incident, platforms)
  }

  private async dispatchEmail(
    event: DomainEvent<unknown>,
    notification: InAppNotification,
    recipients: NotificationRecipient[] | null,
  ): Promise<void> {
    // No silent catch here: a failure (DB lookup, Resend, import) propagates to
    // the consumer, fails the BullMQ job and gets retried — a lost email must
    // never be invisible.
    const { sendEmail } = await import('./email.js')

    // Bersaglio ≠ `all`: gli indirizzi sono quelli dei destinatari già risolti
    // (D-23), lo stesso insieme che riceve la notifica in-app. `all`:
    // admin/operator con indirizzo che non si sono tirati fuori.
    const emails = recipients !== null
      ? recipients.filter((r) => r.email !== null && r.notificationsEnabled).map((r) => r.email as string)
      : await this.broadcastEmailRecipients(event.tenant_id)
    if (emails.length === 0) return

    const subject = `[${event.tenant_id}] ${notification.title}: ${notification.message.slice(0, 80)}`
    const html = renderNotificationEmail(notification)

    // Batch emails (Resend limit: 50 per call)
    for (let i = 0; i < emails.length; i += 50) {
      const batch = emails.slice(i, i + 50)
      await sendEmail({ to: batch, subject, html })
    }
  }

  /**
   * Destinatari email della trasmissione (`target: 'all'`): admin/operator con
   * un indirizzo che non hanno disattivato le notifiche.
   * `notifications_enabled` è l'UNICO criterio di esclusione (assente →
   * attivo, false → escluso) — gli account dimostrativi sono marcati con
   * quello invece di essere riconosciuti dall'indirizzo (D-20).
   */
  private async broadcastEmailRecipients(tenantId: string): Promise<string[]> {
    const session = getSession()
    try {
      const result = await session.executeRead(tx => tx.run(
        `MATCH (u:User {tenant_id: $tenantId})
         WHERE u.role IN ['admin', 'operator', 'TENANT_ADMIN', 'OPERATOR']
           AND u.email IS NOT NULL
           AND u.email <> ''
           AND coalesce(u.notifications_enabled, true) = true
         RETURN u.email AS email`,
        { tenantId },
      ))
      return result.records.map(r => r.get('email') as string).filter(Boolean)
    } finally {
      await session.close()
    }
  }
}

export async function createNotificationDispatcher(): Promise<NotificationDispatcher> {
  const dispatcher = new NotificationDispatcher()
  await dispatcher.start()
  return dispatcher
}
