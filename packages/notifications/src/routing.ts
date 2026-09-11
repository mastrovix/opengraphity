/**
 * Instradamento delle notifiche: quali canali il dispatcher sa DAVVERO
 * consegnare per ciascun tipo di evento (revisione 2, D3.1).
 *
 * Prima di questa tabella una regola poteva dichiarare `slack` per
 * `event.storm_started` e il dispatcher usciva in silenzio (nessun formatter
 * Slack per gli allarmi): l'amministratore vedeva «Slack» acceso e non
 * riceveva mai nulla. Ora la tabella è la sorgente unica per:
 *  - il dispatcher (`assertRoutableChannels`: canale richiesto ma non
 *    instradabile → errore esplicito, job fallito e visibile);
 *  - la validazione delle regole in scrittura (resolver `notificationRules`);
 *  - l'interfaccia (query GraphQL `notificationRouting`), che offre solo i
 *    canali instradabili per il tipo scelto;
 *  - il seed delle regole predefinite e la migrazione 20260911_1150 che
 *    ripulisce le regole già scritte (test di contratto in apps/api).
 *
 * `in_app` (SSE) ed `email` sono generici: valgono per qualunque evento con
 * una regola. Slack/Teams esistono solo dove c'è un formatter dedicato
 * (`consumer.ts`/`formatters.ts`): incident, SLA violato, change approvata,
 * task di change assegnato. Aggiungere un formatter = aggiungere la riga qui,
 * non il contrario.
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'slack', 'teams'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export function isNotificationChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
}

/** Canali instradabili per qualunque tipo di evento che non ha una riga dedicata. */
export const DEFAULT_ROUTABLE_CHANNELS: readonly NotificationChannel[] = ['in_app', 'email']

const ITSM_FULL:  readonly NotificationChannel[] = ['in_app', 'email', 'slack', 'teams']
const SLACK_ONLY: readonly NotificationChannel[] = ['in_app', 'email', 'slack']

/**
 * Righe dedicate: SOLO i tipi per cui esiste un formatter Slack e/o Teams
 * (`dispatchToChannels` nel dispatcher). Tutto il resto → DEFAULT_ROUTABLE_CHANNELS.
 */
export const ROUTABLE_CHANNELS_BY_EVENT: Readonly<Record<string, readonly NotificationChannel[]>> = Object.freeze({
  // Incident: formatSlackIncident / formatTeamsIncident
  'incident.created':    ITSM_FULL,
  'incident.assigned':   ITSM_FULL,
  'incident.escalated':  ITSM_FULL,
  'incident.resolved':   ITSM_FULL,
  // SLA violato: formatter incident (slack/teams) o carta Teams generica
  'sla.breached':        ITSM_FULL,
  // Change: solo Slack (formatSlackChange / formatSlackChangeTask)
  'change.approved':     SLACK_ONLY,
  'change.task_assigned': SLACK_ONLY,
})

/** Canali che il dispatcher sa instradare per `eventType`. */
export function routableChannels(eventType: string): readonly NotificationChannel[] {
  return ROUTABLE_CHANNELS_BY_EVENT[eventType] ?? DEFAULT_ROUTABLE_CHANNELS
}

/** Canali di `channels` che NON sono instradabili per `eventType` (sconosciuti compresi), nell'ordine dato, senza doppioni. */
export function unroutableChannels(eventType: string, channels: readonly string[]): string[] {
  const ok = routableChannels(eventType) as readonly string[]
  return [...new Set(channels.filter((c) => !ok.includes(c)))]
}

/**
 * Errore esplicito se la regola chiede un canale che il dispatcher non sa
 * instradare per questo tipo: lo stesso contratto di `workflow.step.entered`
 * (mai un canale configurato che sparisce in silenzio).
 */
export function assertRoutableChannels(eventType: string, channels: readonly string[]): void {
  const bad = unroutableChannels(eventType, channels)
  if (bad.length > 0) {
    throw new Error(
      `${eventType} notification rule requests channels [${bad.join(', ')}] that the dispatcher cannot route for this event type — ` +
      `routable: [${routableChannels(eventType).join(', ')}]`,
    )
  }
}

export { NOTIFICATION_ENTITY_PATHS, notificationEntityPath, isNotificationEntityType, type NotificationEntityType } from '@opengraphity/types'
