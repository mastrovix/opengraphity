/**
 * I TESTI CHE IL PRODOTTO SCRIVE DENTRO I TICKET, nella lingua del cliente.
 *
 * Una descrizione generata da un allarme, un commento automatico, la nota di
 * una transizione fatta dal sistema: sono DATI salvati sul ticket, non testo
 * dell'interfaccia, quindi il browser non li traduce. Erano scritti in
 * italiano direttamente nel codice e un cliente con il prodotto in inglese li
 * leggeva così (giro del 14 set 2026: «Evento di monitoraggio… prima:
 * 2026-09-13T11:30:11.938Z», «Riassegnato al team …»).
 *
 * Qui ogni testo ha la sua chiave e le sue lingue; si risolve nella lingua
 * predefinita del cliente (`languageFor`), e le date nel suo fuso.
 * `systemText.test.ts` pretende che ogni chiave abbia ogni lingua.
 */
import { LINGUE, type Lingua } from './enumValueLabels.js'
import { languageFor } from './tenantLanguage.js'

type Params = Record<string, string | number>

export const SYSTEM_TEXTS = {
  'event.incident.title':       { en: 'Monitoring event: {title}',                          it: 'Evento di monitoraggio: {title}' },
  'event.incident.resource':    { en: 'Resource: {resource} ({kind})',                        it: 'Risorsa: {resource} ({kind})' },
  'event.incident.severity':    { en: 'Severity: {severity}',                                 it: 'Severità: {severity}' },
  'event.incident.occurrences': { en: 'Occurrences: {count} (first: {first}, last: {last})', it: 'Occorrenze: {count} (prima: {first}, ultima: {last})' },
  'incident.reassignedTeam':    { en: 'Reassigned to team {team}',                            it: 'Riassegnato al team {team}' },
  'incident.assignedUser':      { en: 'Assigned to {user}',                                   it: 'Assegnato a {user}' },
  'incident.reassignedUser':    { en: 'Reassigned to {user}',                                 it: 'Riassegnato a {user}' },
  'workflow.transitionComment': { en: 'Workflow: {step}',                                     it: 'Workflow: {step}' },
  'workflow.transitionCommentNotes': { en: 'Workflow: {step} — {notes}',                      it: 'Workflow: {step} — {notes}' },
  'change.rfcCreated':          { en: 'RFC {code} created',                                   it: 'RFC {code} creata' },
  'change.resolvedByChange':    { en: 'Resolved by change {code}',                            it: 'Risolto dalla change {code}' },
  'change.changeInStep':        { en: 'Change in step "{step}"',                              it: 'Change nel passo "{step}"' },
  'change.resolvingDetached':   { en: 'Resolving change detached',                            it: 'Change risolutiva scollegata' },
  'change.preApproved':         { en: 'Standard: pre-approved',                               it: 'Standard: pre-approvata' },
  'change.approvalsComplete':   { en: 'Approvals complete',                                   it: 'Approvazioni complete' },
  'change.approvalRejected':    { en: 'Approval rejected: {note}',                            it: 'Approvazione rifiutata: {note}' },
  'portal.reopened':            { en: 'Reopened from the portal',                             it: 'Riaperto dal portale' },
  'notification.escalationDefault': { en: '{title}: not resolved after {minutes} minutes',      it: '{title}: non risolto dopo {minutes} minuti' },
  'approval.publicationRejected': { en: 'Publication rejected',                               it: 'Pubblicazione rifiutata' },
  'approval.requestRejected':   { en: 'Request rejected',                                     it: 'Richiesta rifiutata' },
  // I nomi dei ruoli di fabbrica (senza nome proprio si leggono tradotti dalla chiave):
  // un ruolo del cliente non può chiamarsi così (secondo giro UI · V-16). Uguali a `roles.*` del web.
  'role.factory.admin':         { en: 'Admin',                                                it: 'Admin' },
  'role.factory.operator':      { en: 'Operator',                                             it: 'Operatore' },
  'role.factory.viewer':        { en: 'Viewer',                                               it: 'Visualizzatore' },
  'role.factory.end_user':      { en: 'End user',                                             it: 'Utente finale' },
  'approval.requested':         { en: 'Approval requested',                                   it: 'Approvazione richiesta' },
  'approval.kbPublished':       { en: 'Article published',                                    it: 'Articolo pubblicato' },
  'approval.kbPublishedMessage': { en: 'Your article was approved and published',             it: 'Il tuo articolo è stato approvato e pubblicato' },
  'approval.approved':          { en: 'Request approved',                                     it: 'Richiesta approvata' },
  'approval.approvedMessage':   { en: 'The request was approved',                             it: 'La richiesta è stata approvata' },

  // Event Management: commenti, titoli e descrizioni scritti dal monitoraggio.
  'event.alarmReturnedAfterClose': { en: 'Alarm back after the incident was closed: {title} ({resource}) — opened {ref}', it: 'Allarme tornato dopo la chiusura: {title} ({resource}) — aperto {ref}' },
  'event.alarmReturned':        { en: 'Alarm back: {title} ({resource})',                     it: 'Allarme tornato: {title} ({resource})' },
  'event.alarmCorrelated':      { en: 'Correlated alarm: {title}, {severity}, occurrences {count}', it: 'Allarme correlato: {title}, {severity}, ricorrenze {count}' },
  'event.stormStillRunning':    { en: 'Storm still running from source "{source}": alarm back ({title})', it: 'Tempesta ancora in corso dalla sorgente "{source}": allarme tornato ({title})' },
  'event.flapping':             { en: 'Flapping alarm: {transitions} transitions in {minutes} minutes, correlation suspended', it: 'Allarme instabile: {transitions} passaggi in {minutes} minuti, correlazione sospesa' },
  'event.history.flapping':     { en: '{transitions} transitions in {minutes} min',             it: '{transitions} passaggi in {minutes} min' },
  'event.history.sourceDeleted': { en: 'source deleted: no payload can clear it any more', it: 'sorgente eliminata: nessun payload potrà più farlo rientrare' },
  'event.history.stable':       { en: 'no transition in {minutes} min',                         it: 'nessun passaggio in {minutes} min' },
  'storm.title':                { en: 'Alert storm from {source}: {rate} alarms per minute',    it: 'Tempesta di allarmi da {source}: {rate} allarmi al minuto' },
  'storm.description.head':     { en: 'Alert storm from source "{source}": {rate} new alarms per minute (policy threshold reached at {since}).', it: 'Tempesta di allarmi dalla sorgente "{source}": {rate} allarmi nuovi al minuto (soglia della policy raggiunta alle {since}).' },
  'storm.description.body':     { en: 'Alarms received during the storm are attached to this incident instead of opening one incident per CI.', it: 'Gli allarmi ricevuti durante la tempesta vengono agganciati a questo incident invece di aprire un incident per ogni CI.' },
  'storm.description.cis':      { en: 'First CIs involved: {cis}',                             it: 'Primi CI coinvolti: {cis}' },
  'storm.description.noCis':    { en: 'No CI recognised so far among the storm alarms.',        it: 'Nessun CI riconosciuto finora tra gli allarmi della tempesta.' },
  'storm.duplicate':            { en: 'Duplicate incident: the storm of source "{source}" is already tracked by incident {incident}; alarms are attached to that one', it: 'Incident duplicato: la tempesta della sorgente "{source}" è già tracciata dall\'incident {incident}; gli allarmi vengono agganciati a quello' },
  'storm.continuesAfterClose':  { en: 'The storm of source "{source}" continues after this incident was closed: new alarms are attached to incident {incident}', it: 'La tempesta della sorgente "{source}" continua dopo la chiusura di questo incident: i nuovi allarmi vengono agganciati all\'incident {incident}' },
  'storm.ended':                { en: 'Storm ended: {events} events in {minutes} minutes',      it: 'Tempesta terminata: {events} eventi in {minutes} minuti' },
  'cascade.ciDeleted':          { en: 'The CI "{ci}" was deleted from the CMDB: it was the only impacted CI of this incident, which stays open but can no longer be closed by monitoring (its correlated alarms have no CI any more).', it: 'Il CI "{ci}" è stato eliminato dalla CMDB: era l\'unico CI impattato di questo incident, che resta aperto ma non potrà più essere chiuso dal monitoraggio (gli allarmi correlati non hanno più un CI).' },
  'cascade.serviceMapDeleted':  { en: 'The service "{service}" is no longer monitored: its component map was deleted. The incident stays open but will no longer be closed automatically when the service recovers.', it: 'Il servizio "{service}" non è più monitorato: la mappa dei componenti è stata eliminata. L\'incident resta aperto ma non verrà più chiuso automaticamente dal ripristino del servizio.' },
  'autoResolve.hop':            { en: 'Automatic closure by monitoring: moving to {step}',       it: 'Chiusura automatica dal monitoraggio: passaggio a {step}' },
  'autoResolve.cause':          { en: 'Monitoring alarm cleared: {title}',                     it: 'Allarme di monitoraggio rientrato: {title}' },
  'autoResolve.resolvedComment': { en: 'Resolved automatically: all correlated monitoring alarms have cleared (last: {title}){via}', it: 'Risolto automaticamente: tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: {title}){via}' },
  'autoResolve.via':            { en: ' — through {steps}',                                     it: ' — passando per {steps}' },
  'autoResolve.historyVia':     { en: 'through {steps}',                                        it: 'passando per {steps}' },
  'autoResolve.cannotResolve':  { en: 'All correlated monitoring alarms have cleared (last: {title}); the incident is in "{step}" and cannot be resolved automatically from this step', it: 'Tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: {title}); l\'incident è in "{step}" e non può essere risolto automaticamente da questo passo' },
  'autoResolve.historyCannot':  { en: 'the incident is in "{step}" and cannot be resolved automatically from this step', it: 'l\'incident è in "{step}" e non può essere risolto automaticamente da questo passo' },
  'autoResolve.suppressedOne':  { en: '1 monitoring alarm silenced{by} is still in the change window: it does not keep the incident open; at the end of the window it is re-evaluated and, if still firing, reopens it', it: '1 allarme di monitoraggio silenziato{by} resta in finestra di change: non tiene aperto l\'incident; a fine finestra viene rivalutato e, se ancora acceso, lo riapre' },
  'autoResolve.suppressedOther': { en: '{count} monitoring alarms silenced{by} are still in the change window: they do not keep the incident open; at the end of the window they are re-evaluated and, if still firing, reopen it', it: '{count} allarmi di monitoraggio silenziati{by} restano in finestra di change: non tengono aperto l\'incident; a fine finestra vengono rivalutati e, se ancora accesi, lo riaprono' },
  'autoResolve.suppressedBy':   { en: ' by {changes}',                                          it: ' da {changes}' },
  // Servizi monitorati: l'incident del servizio.
  'service.health.down':        { en: 'down',                                                   it: 'non disponibile' },
  'service.health.degraded':    { en: 'degraded',                                               it: 'degradato' },
  'service.health.maintenance': { en: 'in maintenance',                                         it: 'in manutenzione' },
  'service.health.operational': { en: 'operational',                                            it: 'operativo' },
  'service.health.unknown':     { en: 'unknown',                                                it: 'sconosciuto' },
  'service.title':              { en: 'Service {service}: {health}',                            it: 'Servizio {service}: {health}' },
  'service.cause':              { en: '- {ci} ({health}){critical}{path}',                      it: '- {ci} ({health}){critical}{path}' },
  'service.causeCritical':      { en: ', critical',                                             it: ', critico' },
  'service.causePath':          { en: ' — path: {path}',                                        it: ' — percorso: {path}' },
  'service.technicalHeading':   { en: 'Technical incidents already open on the components:',    it: 'Incident tecnici già aperti sui componenti:' },
  'service.descriptionHead':    { en: 'The service "{service}" is {health} according to the component map.', it: 'Il servizio "{service}" è {health} secondo la mappa dei componenti.' },
  'service.descriptionScore':   { en: 'Impact score: {score}/100.',                             it: 'Punteggio d\'impatto: {score}/100.' },
  'service.descriptionCauses':  { en: 'Components that weigh ({count}):',                       it: 'Componenti che pesano ({count}):' },
  'service.maintenance':        { en: 'Service in maintenance: evaluation suspended (a change in its window affects a critical component of "{service}")', it: 'Servizio in manutenzione: la valutazione resta sospesa (una change in finestra riguarda un componente critico di "{service}")' },
  'service.reopenNote':         { en: 'The service "{service}" is {health} again (score {score}/100)', it: 'Il servizio "{service}" è di nuovo {health} (punteggio {score}/100)' },
  'service.reopenComment':      { en: 'Reopened by monitoring: {description}',                  it: 'Riaperto dal monitoraggio: {description}' },
  'service.causesUpdated':      { en: 'Cause updated: the service is {health} (score {score}/100). Components that weigh ({count}):\n{causes}', it: 'Causa aggiornata: il servizio è {health} (punteggio {score}/100). Componenti che pesano ({count}):\n{causes}' },
  'service.keptOpenNever':      { en: 'The rule of the service "{service}" was changed to "never open incidents": this incident stays open and must be closed by hand.', it: 'La regola del servizio "{service}" è passata a "mai aprire incident": questo incident resta aperto, va chiuso a mano.' },
  'service.keptOpenUnknown':    { en: 'The service "{service}" has an unknown state (no component with a known health): the incident stays open.', it: 'Il servizio "{service}" è di stato sconosciuto (nessun componente con una salute nota): l\'incident resta aperto.' },
  'service.keptOpenBelow':      { en: 'The service "{service}" is {health}, below the opening threshold ("{threshold}"): the incident stays open.', it: 'Il servizio "{service}" è {health}, sotto la soglia di apertura ("{threshold}"): l\'incident resta aperto.' },
  'service.resolveCause':       { en: 'Service back {health}',                                  it: 'Servizio tornato {health}' },
  'service.back':               { en: 'The service "{service}" is back {health} (score {score}/100)', it: 'Il servizio "{service}" è tornato {health} (punteggio {score}/100)' },
  'service.cannotResolve':      { en: '{back}; the incident is in "{step}" and cannot be resolved automatically from this step', it: '{back}; l\'incident è in "{step}" e non può essere risolto automaticamente da questo passo' },
  'service.resolvedComment':    { en: 'Resolved automatically: {back}{via}',                    it: 'Risolto automaticamente: {back}{via}' },
  // Note della cronologia dei servizi monitorati (giro del 14 set 2026, #60): erano italiane per tutti.
  'serviceMap.rules.changed':      { en: 'Rules updated: {changes}',                             it: 'Regole aggiornate: {changes}' },
  'serviceMap.rules.change':       { en: '{field} {from} → {to}',                                it: '{field} {from} → {to}' },
  'serviceMap.rules.down_share_pct':     { en: 'down threshold',                                 it: 'soglia giù' },
  'serviceMap.rules.degraded_share_pct': { en: 'degraded threshold',                             it: 'soglia degradato' },
  'serviceMap.rules.min_nodes':          { en: 'minimum components',                             it: 'minimo componenti' },
  'serviceMap.rules.unknown_nodes':      { en: 'components without health',                      it: 'componenti senza salute' },
  'serviceMap.rules.open_incident_from': { en: 'open incident from',                             it: 'apri incident da' },
  'serviceMap.rules.during_storm':       { en: 'during a storm',                                 it: 'durante una tempesta' },
  'serviceMap.rules.unknown.ignore':      { en: 'ignored',                                       it: 'ignorati' },
  'serviceMap.rules.unknown.operational': { en: 'operational',                                   it: 'operativi' },
  'serviceMap.rules.open.never':          { en: 'never',                                         it: 'mai' },
  'serviceMap.rules.open.down':           { en: 'down',                                          it: 'giù' },
  'serviceMap.rules.open.degraded':       { en: 'degraded',                                      it: 'degradato' },
  'serviceMap.rules.storm.hold':          { en: 'hold the evaluation',                           it: 'sospendi la valutazione' },
  'serviceMap.rules.storm.evaluate':      { en: 'evaluate anyway',                               it: 'valuta comunque' },
  'serviceMap.nodes.changedOne':   { en: '1 component updated: {names}',                         it: '1 componente aggiornato: {names}' },
  'serviceMap.nodes.changedMany':  { en: '{count} components updated: {names}',                  it: '{count} componenti aggiornati: {names}' },
  'serviceMap.andOthers':          { en: '{shown}, and {rest} more',                             it: '{shown}, e altri {rest}' },
  'serviceMap.proposalApplied':    { en: 'Map updated: +{added}, −{removed}, excluded {excluded}', it: 'Mappa aggiornata: +{added}, −{removed}, esclusi {excluded}' },
  'serviceMap.missingComponents':  { en: 'Components no longer in the CMDB: {names}',            it: 'Componenti non più presenti nella CMDB: {names}' },
  'serviceMap.stormOne':           { en: 'Source in a storm: {sources}. Evaluation on hold: the health stays the one of the last evaluation.', it: 'Sorgente in tempesta: {sources}. Valutazione sospesa: la salute resta quella dell\'ultima valutazione.' },
  'serviceMap.stormMany':          { en: 'Sources in a storm: {sources}. Evaluation on hold: the health stays the one of the last evaluation.', it: 'Sorgenti in tempesta: {sources}. Valutazione sospesa: la salute resta quella dell\'ultima valutazione.' },
  'serviceMap.upstreamOne':        { en: 'Component in an upstream change window: {items}.',     it: 'Componente in finestra di change a monte: {items}.' },
  'serviceMap.upstreamMany':       { en: 'Components in an upstream change window: {items}.',    it: 'Componenti in finestra di change a monte: {items}.' },
  'serviceMap.upstreamItem':       { en: '{name} ({change} on {via})',                           it: '{name} ({change} su {via})' },
  'serviceMap.sync.counts':        { en: '+{added}, −{removed}, ~{moved} moved',                 it: '+{added}, −{removed}, ~{moved} spostati' },
  'serviceMap.sync.retiredOne':    { en: '; 1 retired component left out of the calculation',    it: '; 1 componente dismesso escluso dal calcolo' },
  'serviceMap.sync.retiredMany':   { en: '; {count} retired components left out of the calculation', it: '; {count} componenti dismessi esclusi dal calcolo' },
  'serviceMap.autoSync.enabled':   { en: 'Automatic update enabled',                             it: 'Aggiornamento automatico attivato' },
  'serviceMap.autoSync.disabled':  { en: 'Automatic update disabled',                            it: 'Aggiornamento automatico disattivato' },
  'serviceMap.exclusionRemoved':   { en: 'Exclusion removed: {name}',                            it: 'Esclusione rimossa: {name}' },
  'serviceMap.scope.changed':      { en: 'Scope updated: {changes}',                             it: 'Ambito aggiornato: {changes}' },
  'serviceMap.scope.types':        { en: 'relationships {from} → {to}',                          it: 'relazioni {from} → {to}' },
  'serviceMap.scope.depth':        { en: 'depth {from} → {to}',                                  it: 'profondità {from} → {to}' },
  'serviceMap.sync.manual':        { en: 'Synchronization requested by {actor}: {counts}',       it: 'Sincronizzazione richiesta da {actor}: {counts}' },
  'serviceMap.sync.automatic':     { en: 'Automatic synchronization: {counts}',                  it: 'Sincronizzazione automatica: {counts}' },
  'serviceMap.sync.limitUnknown':  { en: 'Synchronization skipped: the map built now goes over the cap of {cap} components ({detail}). Reduce the depth or exclude some components.', it: 'Sincronizzazione saltata: la mappa costruita adesso supera il tetto di {cap} componenti ({detail}). Riduci la profondità o escludi dei componenti.' },
  'serviceMap.sync.limit':         { en: 'Synchronization skipped: the map built now would have {total} components and goes over the cap of {cap} components ({detail}). Reduce the depth or exclude some components.', it: 'Sincronizzazione saltata: la mappa costruita adesso avrebbe {total} componenti e supera il tetto di {cap} componenti ({detail}). Riduci la profondità o escludi dei componenti.' },
  'serviceMap.sync.limitDetail':   { en: '{proposed} proposed, {final} after the synchronization', it: '{proposed} proposti, {final} dopo la sincronizzazione' },
} as const satisfies Record<string, Record<Lingua, string>>

export type SystemTextKey = keyof typeof SYSTEM_TEXTS

/** Il testo nella lingua data, con i parametri sostituiti. Un parametro mancante è un errore, non un buco. */
export function systemTextIn(lingua: Lingua, key: SystemTextKey, params: Params = {}): string {
  const template = SYSTEM_TEXTS[key][lingua]
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (!(name in params)) throw new Error(`systemText "${key}": missing parameter "${name}"`)
    return String(params[name])
  })
}

/** Il testo nella lingua predefinita del cliente. */
export async function systemText(tenantId: string, key: SystemTextKey, params: Params = {}): Promise<string> {
  return systemTextIn(await languageFor(tenantId), key, params)
}

/**
 * Il locale Intl di una lingua del prodotto, come nel web: `en` da solo è la
 * convenzione americana («Sep 14, 2026, 1:07 AM», giro nel browser del 14 set
 * 2026 #51), che accanto alle date del resto del prodotto non si legge.
 */
export function intlLocaleOf(lingua: Lingua): string {
  return lingua === 'en' ? 'en-GB' : lingua === 'it' ? 'it-IT' : lingua
}

/** Un istante nella lingua del cliente e nel fuso dato («14 Sept 2026, 00:48»). */
export function formatInstantIn(lingua: Lingua, iso: string, timeZone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(intlLocaleOf(lingua), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(d)
}

/**
 * Il nome della lingua per un modello AI («English», «Italian»): le bozze che
 * il modello scrive dentro i ticket (note di risoluzione, articoli KB, triage)
 * vanno nella lingua del cliente, non in un italiano fisso nel prompt.
 */
export const LANGUAGE_NAME_FOR_MODEL: Readonly<Record<Lingua, string>> = { en: 'English', it: 'Italian' }

export async function modelLanguageFor(tenantId: string): Promise<string> {
  return LANGUAGE_NAME_FOR_MODEL[await languageFor(tenantId)]
}

export { LINGUE }
