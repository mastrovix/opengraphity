/**
 * I TESTI DELLE NOTIFICHE CHE ESCONO DAL PRODOTTO — e-mail, Slack, Teams —
 * nella lingua e nel fuso del cliente.
 *
 * Revisione del 14 set 2026 · NT-2. Il pannello in-app traduce nel browser;
 * tutto ciò che esce verso una casella o un canale no, e scriveva:
 *  - l'oggetto e il titolo dell'e-mail con la CHIAVE grezza della regola
 *    (`notification.incident.created.title`);
 *  - «Vedi dettagli», «Assegnato a», «Apri →», «Risolvi», «SLA Violato» in
 *    italiano fisso, e le date con `toLocaleString('it-IT')` nel fuso del
 *    server, anche per un cliente con il prodotto in inglese.
 * E 23 dei 35 titoli delle regole di fabbrica non esistevano nemmeno nelle
 * traduzioni del web: il pannello mostrava la chiave.
 *
 * ## Una sola verità per i titoli
 * I titoli sono testo dell'interfaccia (il pannello li traduce con i file del
 * web), e qui sono ricopiati per chi scrive fuori dal browser.
 * `__tests__/texts.test.ts` pretende che coincidano con i file del web, chiave
 * per chiave e lingua per lingua, e che ogni titolo delle regole di fabbrica ci
 * sia: non possono divergere in silenzio.
 *
 * Un titolo che non è una chiave nota è il testo scritto dall'amministratore
 * nella regola: si mostra così com'è, come fa il pannello.
 */

/** Le lingue del prodotto, nell'ordine dei file di traduzione (la prima è quella di ultima istanza). */
export const NOTIFICATION_LANGUAGES = ['en', 'it'] as const
export type NotificationLanguage = (typeof NOTIFICATION_LANGUAGES)[number]

export interface NotificationLocale {
  language: NotificationLanguage
  /** Fuso IANA del cliente: le date nei messaggi sono le sue. */
  timeZone: string
}

type Texts = Record<NotificationLanguage, string>

export const NOTIFICATION_TITLES: Readonly<Record<string, Texts>> = {
  'notification.approval.approved.title':          { en: 'Request approved', it: 'Richiesta approvata' },
  'notification.approval.rejected.title':          { en: 'Request rejected', it: 'Richiesta rifiutata' },
  'notification.approval.requested.title':         { en: 'Approval requested', it: 'Approvazione richiesta' },
  'notification.change.approved.title':            { en: 'Change approved', it: 'Change approvata' },
  'notification.change.completed.title':           { en: 'Change completed', it: 'Change completata' },
  'notification.change.failed.title':              { en: 'Change failed', it: 'Change fallita' },
  'notification.change.rejected.title':            { en: 'Change rejected', it: 'Change rifiutata' },
  'notification.change.task_reminder.title':       { en: 'Reminder: a change task is waiting for you', it: 'Promemoria: un\'attività di change ti aspetta' },
  'notification.change.task_assigned.title':       { en: 'Change task assigned to you', it: 'Attività di change assegnata a te' },
  'notification.ci.health_changed.title':          { en: 'CI health changed', it: 'Salute del CI cambiata' },
  'notification.digest.daily.title':              { en: 'Daily digest', it: 'Riepilogo giornaliero' },
  'notification.event.correlated.title':           { en: 'Alarm correlated to an incident', it: 'Allarme correlato a un incident' },
  'notification.event.flapping.title':             { en: 'Flapping alarm: correlation paused', it: 'Allarme instabile: correlazione sospesa' },
  'notification.event.orphan.title':               { en: 'Alert with no matching CI', it: 'Allarme senza CI riconosciuto' },
  'notification.event.received.title':             { en: 'New monitoring alert', it: 'Nuovo allarme dal monitoraggio' },
  'notification.event.resolved.title':             { en: 'Alert cleared', it: 'Allarme rientrato' },
  'notification.event.stable.title':               { en: 'Alarm stable again', it: 'Allarme tornato stabile' },
  'notification.event.storm_ended.title':          { en: 'Alarm storm ended', it: 'Tempesta di allarmi terminata' },
  'notification.event.storm_started.title':        { en: 'Alarm storm in progress', it: 'Tempesta di allarmi in corso' },
  'notification.event.suppressed.title':           { en: 'Alarm silenced by a change window', it: 'Allarme silenziato da una change in finestra' },
  'notification.incident.assigned.title':          { en: 'Incident assigned', it: 'Incident assegnato' },
  'notification.mention.title':                    { en: 'You were mentioned', it: 'Sei stato menzionato' },
  'notification.watcher.title':                    { en: 'Update on something you follow', it: 'Aggiornamento su ciò che segui' },
  'notification.report.executed.title':            { en: 'Scheduled report ran', it: 'Report schedulato eseguito' },
  'notification.incident.closed.title':            { en: 'Incident closed', it: 'Incident chiuso' },
  'notification.incident.created.title':           { en: 'New incident', it: 'Nuovo incident' },
  'notification.incident.escalated.title':         { en: 'Incident escalated', it: 'Incident in escalation' },
  'notification.incident.major_declared.title':    { en: 'Major Incident declared', it: 'Major Incident dichiarato' },
  'notification.incident.in_progress.title':       { en: 'Incident in progress', it: 'Incident in lavorazione' },
  'notification.incident.on_hold.title':           { en: 'Incident on hold', it: 'Incident in attesa' },
  'notification.incident.resolved.title':          { en: 'Incident resolved', it: 'Incident risolto' },
  'notification.kb.publication_rejected.title':    { en: 'Publication rejected', it: 'Pubblicazione rifiutata' },
  'notification.kb.published.title':               { en: 'Article published', it: 'Articolo pubblicato' },
  'notification.ola.breached.title':               { en: 'OLA/UC breached', it: 'OLA/UC violato' },
  'notification.problem.closed.title':             { en: 'Problem closed', it: 'Problem chiuso' },
  'notification.problem.assigned.title':           { en: 'Problem assigned', it: 'Problem assegnato' },
  'notification.problem.created.title':            { en: 'New problem', it: 'Nuovo problem' },
  'notification.problem.deferred.title':           { en: 'Problem deferred', it: 'Problem posticipato' },
  'notification.problem.investigating.title':      { en: 'Problem under investigation', it: 'Problem in analisi' },
  'notification.problem.resolved.title':           { en: 'Problem resolved', it: 'Problem risolto' },
  'notification.service.health_changed.title':     { en: 'Service health changed', it: 'Salute del servizio cambiata' },
  'notification.service.incident_opened.title':    { en: 'Incident opened for a service', it: 'Incident aperto per un servizio' },
  'notification.sla.breached.title':               { en: 'SLA breached', it: 'SLA violato' },
  'notification.sla.warning.title':                { en: 'SLA about to be breached', it: 'SLA in scadenza' },
  'notification.sync.completed.title':             { en: 'Synchronisation completed', it: 'Sincronizzazione completata' },
  'notification.sync.conflict.title':              { en: 'Synchronisation conflict to review', it: 'Conflitto di sincronizzazione da esaminare' },
  'notification.sync.failed.title':                { en: 'Synchronisation failed', it: 'Sincronizzazione fallita' },
}

export const TEXTS = {
  created:          { en: '🆕 New incident',       it: '🆕 Nuovo incident' },
  assigned:         { en: '👤 Assigned',            it: '👤 Assegnato' },
  escalation:       { en: '⚠️ Escalated',           it: '⚠️ In escalation' },
  resolved:         { en: '✅ Resolved',            it: '✅ Risolto' },
  sla_breach:       { en: '⏱ SLA breached',        it: '⏱ SLA violato' },
  change_approved:  { en: '✅ Change approved',     it: '✅ Change approvata' },
  change_failed:    { en: '❌ Change failed',       it: '❌ Change fallita' },
  change_task_assigned: { en: '🔵 Task assigned',  it: '🔵 Attività assegnata' },
  severity:         { en: 'Severity',               it: 'Severità' },
  status:           { en: 'Status',                 it: 'Stato' },
  type:             { en: 'Type',                   it: 'Tipo' },
  ciAffected:       { en: 'Affected CI',            it: 'CI impattato' },
  assignedTo:       { en: 'Assigned to',            it: 'Assegnato a' },
  open:             { en: 'Open →',                 it: 'Apri →' },
  assignToMe:       { en: 'Assign to me',           it: 'Assegna a me' },
  resolve:          { en: 'Resolve',                it: 'Risolvi' },
  newAssessmentTask:{ en: '📋 New assessment task', it: '📋 Nuova attività di assessment' },
  viewDetails:      { en: 'View details',           it: 'Vedi dettagli' },
  slaBreachOnIncident: { en: 'SLA breached on {number}: {title}', it: 'SLA violato su {number}: {title}' },
  slaBreachedCard:  { en: '🔴 SLA breached',        it: '🔴 SLA violato' },
  slaBreachedFor:   { en: 'SLA breached for {type} {id}', it: 'SLA violato per {type} {id}' },
  entityType:       { en: 'Entity type',            it: 'Tipo di entità' },
  entityId:         { en: 'Entity ID',              it: 'ID dell\'entità' },
  breachedAt:       { en: 'Breached at',            it: 'Violato il' },
  testMessageSlack: { en: '✅ *Test notification* — channel *{channel}* is correctly configured in OpenGrafo.', it: '✅ *Notifica di prova* — il canale *{channel}* è configurato correttamente su OpenGrafo.' },
  testMessageTitle: { en: '✅ Test notification — {channel}', it: '✅ Notifica di prova — {channel}' },
  testMessageBody:  { en: 'The channel is correctly configured in OpenGrafo.', it: 'Il canale è configurato correttamente su OpenGrafo.' },
  // Revisione del 14 set 2026 · CO-2: menzioni, osservatori, chat interna ed e-mail di collaborazione.
  mentionMessage:       { en: '{author} mentioned you in {entity} "{title}"', it: '{author} ti ha menzionato in {entity} «{title}»' },
  mentionChatMessage:   { en: '{author} mentioned you in the internal chat of {entity} "{title}"', it: '{author} ti ha menzionato nella chat interna di {entity} «{title}»' },
  watcherComment:       { en: 'New comment by {author}', it: 'Nuovo commento di {author}' },
  watcherInternalChat:  { en: '{author} wrote in the internal chat', it: '{author} ha scritto nella chat interna' },
  emailMentionSubject:  { en: '[{tenant}] {author} mentioned you in {entity} {title}', it: '[{tenant}] {author} ti ha menzionato in {entity} {title}' },
  emailMentionHeading:  { en: 'You were mentioned', it: 'Sei stato menzionato' },
  goToComment:          { en: 'Go to the comment', it: 'Vai al commento' },
  emailWatcherSubject:  { en: '[{tenant}] Update on {entity} {title}', it: '[{tenant}] Aggiornamento su {entity} {title}' },
  update:               { en: 'Update', it: 'Aggiornamento' },
  entity:               { en: 'Entity', it: 'Entità' },
  digestSubject:        { en: '[{tenant}] Daily IT digest', it: '[{tenant}] Riepilogo giornaliero IT' },
  digestHeading:        { en: 'Daily digest', it: 'Riepilogo giornaliero' },
  digestOpenIncidents:  { en: 'Open incidents', it: 'Incident aperti' },
  digestResolvedToday:  { en: 'Resolved today', it: 'Risolti oggi' },
  digestOngoingChanges: { en: 'Changes in progress', it: 'Change in corso' },
  digestSlaBreaches:    { en: 'SLA breaches', it: 'SLA violati' },
  digestRecentEvents:   { en: 'Latest events', it: 'Ultimi eventi' },
  digestNoEvents:       { en: 'No recent events', it: 'Nessun evento recente' },
  goToDashboard:        { en: 'Go to the dashboard', it: 'Vai alla dashboard' },
  reportExecuted:       { en: 'Scheduled report "{name}" ran ({count} sections).', it: 'Il report schedulato «{name}» è stato eseguito ({count} sezioni).' },
  /**
   * I CORPI dei messaggi che escono (revisione totale · E-13): erano inglese
   * fisso anche per un cliente con il prodotto in italiano — «29 min left
   * before the SLA deadline», «412 alarms in 9 min». Le chiavi combaciano con
   * quelle che il pannello usa (`message_key`), così il corpo dell'e-mail e
   * quello in-app dicono la stessa cosa nella stessa lingua.
   */
  'inApp.sla.warning':          { en: '{number} — {title}: {minutes} min left before the SLA deadline', it: '{number} — {title}: {minutes} min alla scadenza dello SLA' },
  'inApp.sla.responseElapsed':  { en: '{number} — {title}: the response time has elapsed', it: '{number} — {title}: il tempo di presa in carico è scaduto' },
  'inApp.storm.ended':          { en: '{source} — {events} alarms in {minutes} min', it: '{source} — {events} allarmi in {minutes} min' },
} as const satisfies Record<string, Texts>

export type NotificationTextKey = keyof typeof TEXTS

/** Vero se la chiave del corpo di una notifica ha una frase in questa tabella. */
export function isNotificationTextKey(key: string): key is NotificationTextKey {
  return Object.prototype.hasOwnProperty.call(TEXTS, key)
}

/** Un testo fisso delle notifiche, con i parametri `{nome}` sostituiti. */
export function notificationText(locale: NotificationLocale, key: NotificationTextKey, params: Record<string, string> = {}): string {
  return TEXTS[key][locale.language].replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m)
}

/** Il titolo di una regola: la frase della chiave nella lingua del cliente, o il testo scritto nella regola. */
export function notificationTitle(locale: NotificationLocale, titleKey: string): string {
  return NOTIFICATION_TITLES[titleKey]?.[locale.language] ?? titleKey
}

/** Una data nei messaggi: lingua e fuso del cliente. */
export function formatNotificationDate(locale: NotificationLocale, date: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale.language === 'it' ? 'it-IT' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: locale.timeZone,
  }).format(date)
}
