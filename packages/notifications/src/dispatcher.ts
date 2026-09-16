import { randomUUID } from 'crypto'
import { BaseConsumer } from '@opengraphity/events'
import { TICKET_WORKER_PERMISSION, type DomainEvent, type StepEnteredFacts } from '@opengraphity/types'
import { isStepEnteredEventType, stepEnteredEntityType, legacyStepEventType, AUTOMATION_NOTIFICATION_EVENT, AUTOMATION_NOTIFICATION_CHANNELS, type AutomationNotificationPayload } from '@opengraphity/types'
import { getSession } from '@opengraphity/neo4j'
import { sseManager, InAppNotification } from './sse.js'
import { sendTeamsAdaptiveMessage, sendSlackMessage, type TeamsAdaptiveCard, type SlackBlock } from './index.js'
import {
  loadChannels, dispatchIncidentNotification, dispatchChangeNotification, dispatchChangeTaskNotification,
  type ChannelPlatform,
} from './consumer.js'
import type { IncidentData, ChangeTaskPayload } from './formatters.js'
import { appUrl } from './appUrl.js'
import { brandedEmailHtml, loadTenantBrand } from './brand.js'
import { escapeHtml } from './escapeHtml.js'
import { assertRoutableChannels, notificationEntityPath, unroutableChannels } from './routing.js'
import { resolveNotificationRecipients, targetNeedsRecipients, type NotificationRecipient } from './recipients.js'
import { formatNotificationDate, notificationText, notificationTitle, isNotificationTextKey, type NotificationLocale } from './texts.js'
import { loadNotificationLocale } from './locale.js'
import { deliverOnce } from './deliveryDedup.js'

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
        // Nessun ripiego su `['in_app']`/`'all'` (revisione totale · E-44):
        // una regola scritta male via API o migrazione trasmetteva a TUTTO il
        // tenant, viewer compresi — lo stesso difetto della riservatezza già
        // chiuso (D-23), per una via secondaria. Una regola senza canali o
        // senza bersaglio è un dato rotto e si dice: il job fallisce, la
        // regola si corregge.
        channels:         requireChannels(props),
        target:           requireTarget(props),
        stepPurpose:      (props['step_purpose']     ?? null) as string | null,
        stepCategory:     (props['step_category']    ?? null) as string | null,
      }
    })
  } finally {
    await session.close()
  }
}

/** I canali della regola: una lista non vuota di stringhe, o un errore che nomina la regola. */
function requireChannels(props: Record<string, unknown>): string[] {
  const raw = props['channels']
  const list = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string' && c !== '') : []
  if (list.length === 0) {
    throw new Error(`NotificationRule ${String(props['id'])} (${String(props['event_type'])}) has no channels: it cannot be delivered — fix the rule instead of broadcasting in-app to the whole tenant`)
  }
  return list
}

/** Il bersaglio della regola: mai dedotto, perché «all» è una trasmissione. */
function requireTarget(props: Record<string, unknown>): string {
  const raw = props['target']
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`NotificationRule ${String(props['id'])} (${String(props['event_type'])}) has no target: it would broadcast to the whole tenant — set a target on the rule`)
  }
  return raw
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
  // Giro nel browser del 14 set 2026 (#18): il corpo era «29», solo i minuti.
  'sla.warning': (p) => {
    const ref = `${required(p, 'number', 'sla.warning')} — ${required(p, 'title', 'sla.warning')}`
    return p['target'] === 'response'
      ? `${ref}: the response time has elapsed`
      : `${ref}: ${requiredNumber(p, 'minutes_remaining', 'sla.warning')} min left before the SLA deadline`
  },
  'sla.breached': (p) => `${required(p, 'number', 'sla.breached')} — ${required(p, 'title', 'sla.breached')}`,
  // Il messaggio scritto nella regola di escalation (NT-8), già risolto dall'API.
  'incident.escalation':     (p) => required(p, 'message', 'incident.escalation'),
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
  'event.storm_ended':       (p) => `${required(p, 'source_name', 'event.storm_ended')} — ${requiredNumber(p, 'events', 'event.storm_ended')} alarms in ${requiredNumber(p, 'duration_minutes', 'event.storm_ended')} min`,
}

/**
 * Le frasi dei messaggi che hanno parole (non solo dati): chiave e dati per il
 * pannello, che le compone nella lingua di chi legge. Il `message` sopra resta
 * il testo inglese per e-mail e integrazioni.
 */
const MESSAGE_KEY_BY_EVENT: Record<string, (p: Record<string, unknown>) => { key: string; params: Record<string, string> }> = {
  'sla.warning': (p): { key: string; params: Record<string, string> } => {
    const ref = { number: required(p, 'number', 'sla.warning'), title: required(p, 'title', 'sla.warning') }
    return p['target'] === 'response'
      ? { key: 'inApp.sla.responseElapsed', params: ref }
      : { key: 'inApp.sla.warning', params: { ...ref, minutes: String(requiredNumber(p, 'minutes_remaining', 'sla.warning')) } }
  },
  'event.storm_ended': (p) => ({
    key: 'inApp.storm.ended',
    params: {
      source: required(p, 'source_name', 'event.storm_ended'),
      events: String(requiredNumber(p, 'events', 'event.storm_ended')),
      minutes: String(requiredNumber(p, 'duration_minutes', 'event.storm_ended')),
    },
  }),
}

/**
 * L'istante dell'evento come `Date` (revisione totale · E-16): i messaggi che
 * escono datavano la consegna, non il fatto — con una coda in ritardo di venti
 * minuti Slack riportava un orario sbagliato di venti minuti. Un timestamp
 * illeggibile non ferma la notifica: si data adesso, che è comunque la verità
 * su quando è stata scritta.
 */
function eventInstant(event: DomainEvent<unknown>): Date {
  const ms = Date.parse(event.timestamp)
  return Number.isNaN(ms) ? new Date() : new Date(ms)
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

function messageKeyOf(eventType: string, payload: unknown): { message_key?: string; message_params?: Record<string, string> } {
  const k = MESSAGE_KEY_BY_EVENT[eventType]
  if (!k) return {}
  const { key, params } = k(payload as Record<string, unknown>)
  return { message_key: key, message_params: params }
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
  const entityType = typeof p['entity_type'] === 'string' ? p['entity_type'] as string : null
  const entityId   = typeof p['entity_id']   === 'string' ? p['entity_id']   as string : null

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
export function renderNotificationEmail(notification: InAppNotification, locale: NotificationLocale): string {
  const path = notificationEntityPath(notification.entity_type, notification.entity_id)
  const link = path
    ? `<a href="${escapeHtml(`${appUrl()}${path}`)}" style="color:#0EA5E9;">${escapeHtml(notificationText(locale, 'viewDetails'))}</a>`
    : ''
  return `<div lang="${locale.language}" style="font-family:Arial,sans-serif;padding:16px;">
          <h2 style="color:#0F172A;margin:0 0 8px;">${escapeHtml(emailTitle(notification, locale))}</h2>
          <p style="color:#64748B;margin:0 0 16px;">${escapeHtml(emailBody(notification, locale))}</p>
          ${link}
        </div>`
}

/**
 * Il CORPO che una persona legge nell'e-mail, nella lingua del cliente
 * (revisione totale · E-13). `message` resta il testo inglese per l'API e per
 * le integrazioni; quando la notifica porta la chiave del messaggio
 * (`message_key`, la stessa che il pannello traduce) l'e-mail usa quella.
 */
function emailBody(notification: InAppNotification, locale: NotificationLocale): string {
  const key = notification.message_key
  if (key && isNotificationTextKey(key)) {
    return notificationText(locale, key, notification.message_params ?? {})
  }
  return notification.message
}

/**
 * Il titolo che una persona legge nell'e-mail: la frase della chiave nella
 * lingua del cliente (NT-2: prima era la chiave grezza), altrimenti il testo di
 * ripiego della notifica (l'etichetta del passo), altrimenti il testo scritto
 * nella regola — lo stesso ordine del pannello.
 */
function emailTitle(notification: InAppNotification, locale: NotificationLocale): string {
  const translated = notificationTitle(locale, notification.title)
  if (translated !== notification.title) return translated
  return notification.title_fallback ?? notification.title
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export class NotificationDispatcher extends BaseConsumer<unknown> {
  constructor() {
    super('notification-service')
  }

  async process(event: DomainEvent<unknown>): Promise<void> {
    // Il promemoria di un task di change a una persona precisa (CH-13).
    if (event.type === 'change.task_reminder') {
      this.processTaskReminder(event)
      return
    }

    // L'azione «crea notifica» di un trigger o di una Business Rule (AU-2).
    if (event.type === AUTOMATION_NOTIFICATION_EVENT) {
      await this.processAutomationNotification(event)
      return
    }

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
    if (!entityType) throw new Error(`${event.type}: malformed step event type`)
    const stepName = p['step_name']
    if (typeof stepName !== 'string' || !stepName) {
      throw new Error(`${event.type} payload has no "step_name": the step rule cannot be chosen`)
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

    // Un canale che questo evento non sa instradare è un errore della REGOLA,
    // non della consegna: si rifiuta PRIMA di consegnare (revisione totale ·
    // E-3). Prima si consegnava in-app ed e-mail e poi si lanciava: il job
    // veniva ritentato quattro volte e ogni tentativo rifaceva quelle
    // consegne — quattro notifiche identiche per ogni evento, per sempre.
    if (unroutable.length > 0) assertRoutableChannels(event.type, rule.channels)

    const notification: InAppNotification = {
      id:          randomUUID(),
      type:        event.type,
      title:       rule.titleKey,
      title_fallback: titleFallback,
      message:     extractMessage(event.type, event.payload),
      ...messageKeyOf(event.type, event.payload),
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

    // Ogni canale è consegnato UNA volta per evento: se un canale a valle
    // fallisce, il ritentativo del job riprende da quello e non ripete i
    // precedenti (E-3, lib deliveryDedup).
    if (channels.includes('in_app')) {
      await deliverOnce(event.id, 'in_app', () => this.sendInApp(event.tenant_id, notification, recipients))
    }

    if (channels.some((c) => c === 'slack' || c === 'teams')) {
      await deliverOnce(event.id, 'channels', () => this.dispatchToChannels(event, channels))
    }

    if (channels.includes('email')) {
      await deliverOnce(event.id, 'email', () => this.dispatchEmail(event, notification, recipients))
    }
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

    // Il canale non instradabile si rifiuta PRIMA di consegnare (E-3): dopo,
    // il ritentativo del job ripeterebbe in-app ed e-mail a ogni giro.
    // Slack/Teams per i passi non sono implementati: si rifiuta a voce alta
    // invece di lasciar cadere un canale che l'admin ha configurato (stessa
    // tabella degli eventi guidati da regola: routing.ts).
    const unsupported = unroutableChannels('workflow.step.entered', nr.channels)
    if (unsupported.length > 0) {
      throw new Error(`workflow.step.entered notify_rule requests unsupported channels [${unsupported.join(', ')}] — only in_app and email are implemented`)
    }
    if (nr.channels.includes('in_app')) {
      await deliverOnce(event.id, 'in_app', () => this.sendInApp(event.tenant_id, notification, recipients))
    }
    if (nr.channels.includes('email')) {
      await deliverOnce(event.id, 'email', () => this.dispatchEmail(event, notification, recipients))
    }
  }

  /**
   * Il promemoria di un task di change (CH-13): prima la mutation scriveva un
   * nodo che nessuno leggeva. Va solo alla persona scelta, nel pannello.
   */
  private processTaskReminder(event: DomainEvent<unknown>): void {
    const p = event.payload as { recipient_user_id?: string; entity_id?: string; code?: string | null; title?: string | null }
    if (!p?.recipient_user_id || !p.entity_id) throw new Error('change.task_reminder event without recipient_user_id/entity_id')
    const notification: InAppNotification = {
      id:          randomUUID(),
      type:        'change.task_reminder',
      title:       'notification.change.task_reminder.title',
      message:     [p.code, p.title].filter(Boolean).join(' — '),
      severity:    'warning',
      entity_id:   p.entity_id,
      entity_type: 'change',
      timestamp:   event.timestamp,
      read:        false,
    }
    sseManager.sendToUser(event.tenant_id, p.recipient_user_id, notification)
  }

  /**
   * La notifica di un'automazione: il titolo è il nome della regola, il testo
   * quello scritto nell'azione, i destinatari quelli del suo bersaglio.
   */
  private async processAutomationNotification(event: DomainEvent<unknown>): Promise<void> {
    const p = event.payload as AutomationNotificationPayload
    if (!p?.message || !p.entity_id || !p.entity_type) throw new Error('automation.notification event without message/entity')
    if (!AUTOMATION_NOTIFICATION_CHANNELS.includes(p.channel)) {
      throw new Error(`automation.notification requests unsupported channel "${p.channel}" — only ${AUTOMATION_NOTIFICATION_CHANNELS.join(', ')}`)
    }
    const notification: InAppNotification = {
      id:             randomUUID(),
      type:           AUTOMATION_NOTIFICATION_EVENT,
      // Il nome che l'amministratore ha dato alla regola: testo, non una chiave.
      title:          p.rule,
      title_fallback: p.rule,
      message:        p.message,
      severity:       'info',
      entity_id:      p.entity_id,
      entity_type:    p.entity_type,
      timestamp:      event.timestamp,
      read:           false,
    }
    const recipients = await this.resolveRecipients(event, p.target, { type: p.entity_type, id: p.entity_id })
    if (p.channel === 'in_app') this.sendInApp(event.tenant_id, notification, recipients)
    else await this.dispatchEmail(event, notification, recipients)
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

  /**
   * In-app: trasmissione al tenant per `all`, una consegna per destinatario
   * altrimenti. ATTESA (E-19): se la notifica non viene salvata il job
   * fallisce e viene ritentato, invece di lasciare una riga di log e una
   * notifica che spariva al ricaricamento.
   */
  private async sendInApp(tenantId: string, notification: InAppNotification, recipients: NotificationRecipient[] | null): Promise<void> {
    if (recipients === null) {
      await sseManager.deliverToTenant(tenantId, notification)
      return
    }
    for (const recipient of recipients) {
      await sseManager.deliverToUser(tenantId, recipient.id, notification)
    }
  }

  /**
   * SLA violato su un ticket che non è un incident (problem, richiesta di
   * servizio): la card per Teams E i blocchi per Slack (revisione totale ·
   * E-4 — il ramo esisteva solo per Teams, quindi una regola «SLA violato →
   * Slack» su un problem non mandava niente e non c'era nemmeno un log).
   * La gravità e lo stato sono quelli veri del ticket (E-8).
   */
  private async dispatchGenericSlaBreach(
    event: DomainEvent<unknown>,
    p: Record<string, unknown>,
    platforms: readonly ChannelPlatform[],
    locale: NotificationLocale,
    number: string,
    title: string,
  ): Promise<void> {
    const channels = await loadChannels(event.tenant_id, 'sla_breach', platforms)
    if (channels.length === 0) return
    const entityType = String(p['entity_type'] ?? '—')
    const entityId   = String(p['entity_id'] ?? '—')
    const breachedAt = typeof p['breached_at'] === 'string' ? formatNotificationDate(locale, new Date(p['breached_at'])) : '—'
    const severity   = typeof p['severity'] === 'string' && p['severity'] ? p['severity'] : 'unknown'
    const status     = typeof p['status']   === 'string' && p['status']   ? p['status']   : 'unknown'
    const headline   = notificationText(locale, 'slaBreachedCard')
    const subject    = notificationText(locale, 'slaBreachedFor', { type: entityType, id: `${number} — ${title}` })
    const path       = notificationEntityPath(entityType, entityId)
    const link       = path ? `${appUrl()}${path}` : null

    for (const ch of channels) {
      if (ch.platform === 'teams') {
        if (!ch.webhookUrl) throw new Error(`Teams NotificationChannel ${ch.id} has no webhook_url`)
        const card: TeamsAdaptiveCard = {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: headline, weight: 'Bolder', size: 'Large', wrap: true },
            { type: 'TextBlock', text: subject, wrap: true },
            { type: 'FactSet', facts: [
              { title: notificationText(locale, 'entityType'), value: entityType },
              { title: notificationText(locale, 'entityId'),   value: entityId },
              { title: notificationText(locale, 'severity'),   value: severity.toUpperCase() },
              { title: notificationText(locale, 'status'),     value: status },
              { title: notificationText(locale, 'breachedAt'), value: breachedAt },
            ] },
          ],
        }
        await sendTeamsAdaptiveMessage(ch.webhookUrl, card)
      } else {
        const blocks: SlackBlock[] = [
          { type: 'header', text: { type: 'plain_text', text: `⏰ ${headline}` } },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: [
              subject,
              `*${notificationText(locale, 'severity')}:* ${severity.toUpperCase()}`,
              `*${notificationText(locale, 'status')}:* ${status}`,
              `*${notificationText(locale, 'breachedAt')}:* ${breachedAt}`,
            ].join('\n') },
            ...(link ? { accessory: { type: 'button' as const, text: { type: 'plain_text' as const, text: notificationText(locale, 'open') }, url: link } } : {}),
          },
        ]
        await sendSlackMessage(event.tenant_id, ch.webhookUrl, ch.channelId, blocks)
      }
    }
  }

  // ── Slack / Teams channel dispatch (driven by rule.channels) ────────────────

  private async dispatchToChannels(event: DomainEvent<unknown>, channels: string[]): Promise<void> {
    const hasSlack = channels.includes('slack')
    const hasTeams = channels.includes('teams')
    if (!hasSlack && !hasTeams) return

    // Change approvata → Slack e Teams
    if (event.type === 'change.approved') {
      const p = event.payload as Record<string, unknown>
      // Un payload senza id o titolo NON è «niente da fare»: prima si usciva
      // in silenzio (`if (p.id && p.title)`), quindi un produttore che
      // pubblicava `entity_id` invece di `id` lasciava la regola attiva e muta
      // per sempre — mentre lo stesso caso su un incident lancia (revisione
      // totale · E-17).
      await dispatchChangeNotification(event.tenant_id, {
        id:       required(p, 'id', 'change.approved'),
        title:    required(p, 'title', 'change.approved'),
        type:     (p['type']  as string) ?? '—',
        status:   (p['status'] as string) ?? 'scheduled',
        tenantId: event.tenant_id,
      }, eventInstant(event))
      return
    }

    // Attività di change assegnata → Slack e Teams
    if (event.type === 'change.task_assigned') {
      await dispatchChangeTaskNotification(event.tenant_id, event.payload as ChangeTaskPayload, eventInstant(event))
      return
    }

    // Platforms the rule routes this event to. Every Slack/Teams message goes
    // to the TENANT's NotificationChannel rows (loadChannels) — never to a
    // process-wide webhook from env, which would mix tenants (D-07).
    const platforms = channels.filter((c): c is ChannelPlatform => c === 'slack' || c === 'teams')

    // SLA breached → tenant Slack/Teams channels subscribed to 'sla_breach'
    if (event.type === 'sla.breached') {
      const p = event.payload as Record<string, unknown>
      const locale = await loadNotificationLocale(event.tenant_id)
      const number = required(p, 'number', 'sla.breached')
      const title  = required(p, 'title', 'sla.breached')
      if (p['entity_type'] === 'incident') {
        const incident: IncidentData = {
          id:       p['entity_id'] as string,
          title:    notificationText(locale, 'slaBreachOnIncident', { number, title }),
          // La gravità e lo stato VERI dell'incident: erano cablati a
          // «high»/«open» per qualunque incident (revisione totale · E-8). Il
          // ripiego serve solo agli eventi già in coda prima del rimedio, e si
          // vede che è un ripiego.
          severity: typeof p['severity'] === 'string' && p['severity'] ? p['severity'] : 'unknown',
          status:   typeof p['status']   === 'string' && p['status']   ? p['status']   : 'unknown',
          tenantId: event.tenant_id,
        }
        await dispatchIncidentNotification(event.tenant_id, 'sla_breach', incident, platforms, 'sla_breach', eventInstant(event))
      } else {
        // Un problem o una richiesta con SLA violato: prima il ramo esisteva
        // SOLO per Teams, quindi una regola «SLA violato → Slack» su un
        // problem non mandava niente e non lo diceva (revisione totale ·
        // E-4). Ora entrambe le piattaforme, sulla stessa card/blocchi.
        await this.dispatchGenericSlaBreach(event, p, platforms, locale, number, title)
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
    await dispatchIncidentNotification(event.tenant_id, notifType, incident, platforms, event.type === 'incident.created' ? 'created' : notifType, eventInstant(event))
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

    const locale  = await loadNotificationLocale(event.tenant_id)
    const title   = emailTitle(notification, locale)
    const subject = notification.message ? `${title}: ${notification.message.slice(0, 80)}` : title
    // Il marchio del cliente (ondata 6 di «Nulla cablato»): logo e nome in testa, mittente e risposte suoi.
    const brand = await loadTenantBrand(event.tenant_id)
    const html = brandedEmailHtml(event.tenant_id, brand, renderNotificationEmail(notification, locale), locale.language)

    // Batch emails (Resend limit: 50 per call)
    for (let i = 0; i < emails.length; i += 50) {
      const batch = emails.slice(i, i + 50)
      await sendEmail({ to: batch, subject, html, senderName: brand.senderName, replyTo: brand.replyTo })
    }
  }

  /**
   * Destinatari email della trasmissione (`target: 'all'`): chi lavora i ticket
   * (il permesso `TICKET_WORKER_PERMISSION` del suo ruolo, ondata 7; prima
   * «admin/operator») con un indirizzo, che non ha disattivato le notifiche.
   * `notifications_enabled` è l'UNICO criterio di esclusione (assente →
   * attivo, false → escluso) — gli account dimostrativi sono marcati con
   * quello invece di essere riconosciuti dall'indirizzo (D-20).
   */
  private async broadcastEmailRecipients(tenantId: string): Promise<string[]> {
    const session = getSession()
    try {
      const result = await session.executeRead(tx => tx.run(
        `MATCH (u:User {tenant_id: $tenantId})
         MATCH (r:Role {tenant_id: $tenantId, key: u.role})
         WHERE $permission IN r.permissions
           AND coalesce(u.active, true) = true
           AND u.email IS NOT NULL
           AND u.email <> ''
           AND coalesce(u.notifications_enabled, true) = true
         RETURN u.email AS email`,
        { tenantId, permission: TICKET_WORKER_PERMISSION },
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
