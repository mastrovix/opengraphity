/**
 * IL CATALOGO CHIUSO DELLE AZIONI (20 set 2026).
 *
 * Una proposta accettata non esegue «quello che ha scritto il modello»:
 * esegue una voce di questo elenco, con parametri tipizzati e validati dal
 * server. Stesso PRINCIPIO di `actionExecutor.ts`, ma **esecutore nuovo** —
 * quelle dieci azioni sono legate a un'entità (`ActionExecutionContext` porta
 * `entityId`, `entityType`, `entity`) e nessuna tocca la configurazione.
 *
 * ## Una proposta, una azione
 * `executeActions` si ferma alla prima azione fallita e non annulla quelle
 * già fatte: non c'è transazione né compensazione. Con più azioni per
 * proposta, un'accettazione a metà lascerebbe un cambiamento a metà. Con una
 * sola, il problema non esiste.
 *
 * ## Ogni azione dice come si disfa
 * Non «ogni azione ha la sua inversa», che per un'azione che sovrascrive un
 * campo è falso: l'inversa non è un'altra voce del catalogo, è lo STATO
 * PRECEDENTE.
 *
 * E quello stato si SALVA, non si tiene in memoria. Una chiusura JavaScript
 * restituita da `esegui()` sarebbe comoda e sbagliata: fra l'accettazione e
 * il ripensamento passano ore o giorni, e il processo nel mezzo si riavvia.
 * L'azione consegna un `undoState` serializzabile, che finisce sul nodo della
 * proposta; disfare lo rilegge da lì.
 *
 * ## Perché una sola azione nell'ondata 1
 * Non è un ripiego. Delle cinque azioni che il progetto elencava, una esiste
 * (l'articolo KB), una è un resolver da estrarre, una richiede di riscrivere
 * il modulo intero contro chi lo sta compilando, una non ha nemmeno la
 * proprietà, una non ha l'entità. Questa è l'unica che si chiude in modo
 * deterministico e totalmente reversibile — un campo unico sul tenant — e
 * serve a provare il cammino accetta → esegui → disfa per intero, che è
 * l'unica parte rischiosa della spina.
 */
import { getSession } from '@opengraphity/neo4j'
import { randomUUID } from 'node:crypto'
import {
  PROPOSAL_FORBIDDEN_ACTION_TYPES, isProposalActionType,
  AUTOMATION_ENTITY_TYPES, TRIGGER_EVENT_TYPES, automationEventSupported,
  type ProposalActionType,
} from '@opengraphity/types'
import { assertAzioniAmmesseDaProposta } from './automationOrigin.js'
import { runQueryOne } from '../graphql/resolvers/ci-utils.js'
import { NotFoundError, ValidationError } from './errors.js'
import { PORTAL_SEVERITY_VOCABULARY, portalSeverityOptions } from './portalSeverityOptions.js'
import { domainVocabulary } from './domainMatrix.js'
import { logger } from './logger.js'

/** Quello che l'esecuzione consegna a chi l'ha chiesta. */
export interface EsitoAzione {
  /** Che cosa è cambiato, in dati: finisce in `details` della voce di Audit. */
  details:   Record<string, unknown>
  /**
   * Lo stato precedente, serializzabile, da cui si ricostruisce il
   * ripristino. `null` quando l'azione non è disfabile — e allora la pagina
   * non offre «disfa», invece di offrirlo e fallire.
   */
  undoState: Record<string, unknown> | null
}

/**
 * LA SBARRA, prima di qualunque altra cosa.
 *
 * Il testo dei ticket e dei log lo scrivono utenti, clienti e sistemi
 * esterni; un giorno un analista AI comporrà i parametri leggendo quel testo.
 * Una proposta che nomina l'esecuzione di uno script, una chiamata a un
 * webhook o una transizione di workflow si rifiuta QUI, prima che qualcuno
 * possa accettarla — e si rifiuta anche se il tipo compare annidato nei
 * parametri, perché «crea un'automazione disattivata» porta le sue azioni
 * dentro un JSON.
 */
export function assertAzioneAmmessa(type: string, params: Record<string, unknown>): ProposalActionType {
  if (!isProposalActionType(type)) {
    throw new ValidationError(
      `"${type}" is not an action of the closed catalogue`,
      { key: 'errors.proposal.actionUnknown', params: { action: type } },
    )
  }
  const serializzati = JSON.stringify(params)
  for (const vietato of PROPOSAL_FORBIDDEN_ACTION_TYPES) {
    if (serializzati.includes(vietato)) {
      throw new ValidationError(
        `a proposal may never carry "${vietato}", not even nested in its parameters`,
        { key: 'errors.proposal.actionForbidden', params: { action: vietato } },
      )
    }
  }
  return type
}

/**
 * `portal_severities.remove_stale` — toglie dalle severità del portale i
 * valori che il Dizionario non ha più.
 *
 * Chiude il rilievo `portal_severities_stale`, che è un errore vero e non un
 * avviso: dal portale non si apre nessun ticket, e gli utenti finali lo
 * scoprono per primi.
 *
 * Tre cose che questa azione fa e che il catalogo pretenderà da tutte:
 *  - **ricalcola da sé quali valori sono stantii**, invece di fidarsi dei
 *    parametri della proposta: fra la notte in cui è nata e il click possono
 *    essere passati giorni, e il Dizionario può essere cambiato;
 *  - **si ferma se toglierli tutti** lascerebbe il portale senza nessuna
 *    severità — cioè ugualmente inutilizzabile. Meglio dirlo che «risolvere»
 *    un errore sostituendolo con un altro;
 *  - **cattura lo stato precedente** per intero, e lo riscrive tale e quale
 *    per disfare. Il ripristino non passa da `setPortalSeverityOptions`, che
 *    rifiuterebbe proprio i valori stantii che stiamo rimettendo: si ripristina
 *    quello che c'era, non quello che sarebbe valido.
 */
async function togliSeveritaStantie(tenantId: string): Promise<EsitoAzione> {
  const prima = await portalSeverityOptions(tenantId)
  if (prima === null || prima.length === 0) {
    throw new ValidationError(
      'the portal has no severities set: there is nothing stale to remove',
      { key: 'errors.proposal.portalSeveritiesEmpty' },
    )
  }
  const vocabolario = await domainVocabulary(tenantId, PORTAL_SEVERITY_VOCABULARY)
  const restano  = prima.filter((o) => vocabolario.includes(o.value))
  const stantie  = prima.filter((o) => !vocabolario.includes(o.value)).map((o) => o.value)

  if (stantie.length === 0) {
    throw new ValidationError(
      'every portal severity is still in the dictionary: nothing to do',
      { key: 'errors.proposal.portalSeveritiesAlreadyClean' },
    )
  }
  if (restano.length === 0) {
    throw new ValidationError(
      'removing them would leave the portal with no severity at all, and nobody could open a ticket',
      { key: 'errors.proposal.portalSeveritiesWouldEmpty' },
    )
  }

  const grezzoPrima = JSON.stringify(prima)
  await scriviOpzioni(tenantId, JSON.stringify(restano))

  return {
    details:   { removed: stantie, kept: restano.map((o) => o.value) },
    undoState: { options: grezzoPrima },
  }
}

/** Il ripristino: riscrive esattamente quello che c'era. */
async function ripristinaSeverita(tenantId: string, undoState: Record<string, unknown>): Promise<void> {
  const grezzo = undoState['options']
  if (typeof grezzo !== 'string' || grezzo === '') {
    throw new ValidationError(
      'the saved previous state of the portal severities is unreadable: nothing was restored',
      { key: 'errors.proposal.undoStateUnreadable' },
    )
  }
  await scriviOpzioni(tenantId, grezzo)
}

/** La scrittura grezza: la usano sia l'azione sia il suo ripristino. */
async function scriviOpzioni(tenantId: string, grezzo: string): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const riga = await runQueryOne<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.portal_severity_options = $options, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, options: grezzo, now: new Date().toISOString() })
    if (!riga) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
}

/**
 * `automation.create_disabled` — crea un'automazione SPENTA (20 set 2026).
 *
 * La seconda voce del catalogo, e la prima che CREA qualcosa. Tre cose la
 * rendono accettabile, e vanno lette insieme:
 *
 *  1. **nasce spenta**, sempre: accettare la proposta non mette in moto
 *     niente, mette a disposizione qualcosa da leggere e poi accendere;
 *  2. **porta `origin: 'ai_proposal'`**, che non è un'etichetta ma una
 *     regola: da quel momento ogni accensione rivalida le sue azioni contro
 *     l'allowlist ristretta (`lib/automationOrigin.ts`);
 *  3. **l'inversa è cancellarla.** È l'unico caso in cui «disfare» vuol dire
 *     eliminare, ed è legittimo proprio perché la proposta l'aveva creata:
 *     si toglie ciò che si era messo, non qualcosa che c'era prima. Questo
 *     corrigge il «non cancellerà nulla» della prima stesura del progetto.
 *
 * I parametri NON li compone un modello: li calcola il codice dagli aggregati
 * (vedi `lib/dailyWorkAnalyst.ts`). Qui si rivalida comunque tutto, perché una
 * sbarra che si fida di chi la chiama non è una sbarra.
 */
/**
 * La cache dei trigger, scordata con un import PIGRO.
 *
 * `triggerEngine` tira dentro BullMQ, che apre connessioni Redis al solo
 * essere importato. Importarlo in cima a questo file renderebbe pesante un
 * modulo che era leggero: ogni test che tocca il catalogo delle azioni si
 * porterebbe dietro la coda — ed è successo davvero, `proposalActions.test.ts`
 * è caduto sul `logger.child` di `bullmq.ts`. Qui serve solo nel momento in
 * cui un'automazione viene creata o cancellata, e in quel momento il processo
 * ha già tutto acceso.
 */
async function scordaLaCacheDeiTrigger(tenantId: string): Promise<void> {
  const { invalidateTriggerCache } = await import('./triggerEngine.js')
  invalidateTriggerCache(tenantId)
}

async function creaAutomazioneDaProposta(
  tenantId: string, params: Record<string, unknown>,
): Promise<EsitoAzione> {
  const nome       = String(params['name'] ?? '').trim()
  const entityType = String(params['entityType'] ?? '')
  const eventType  = String(params['eventType'] ?? '')
  const actions    = params['actions']
  const conditions = params['conditions'] ?? null

  if (nome === '') {
    throw new ValidationError('The proposed automation has no name', { key: 'errors.proposal.automationName', params: {} })
  }
  if (!(AUTOMATION_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw new ValidationError(`"${entityType}" is not a ticket type an automation can watch`, {
      key: 'errors.proposal.automationEntity', params: { value: entityType },
    })
  }
  if (!(TRIGGER_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new ValidationError(`"${eventType}" is not an automation event`, {
      key: 'errors.proposal.automationEvent', params: { value: eventType },
    })
  }
  /*
   * La combinazione evento×ticket deve essere una di quelle che il motore
   * valuta davvero: `automationEventSupported` è la stessa tabella che usa la
   * pagina. Una regola «su aggiornamento di una change» si salverebbe, e non
   * girerebbe mai — il difetto AU-1, che qui non si ripete.
   */
  if (!automationEventSupported(eventType, entityType)) {
    throw new ValidationError(
      `An automation on "${entityType}" does not run on "${eventType}"`,
      { key: 'errors.proposal.automationEventEntity', params: { event: eventType, entity: entityType } },
    )
  }
  // La sbarra ristretta, la prima delle due volte: l'altra è l'accensione.
  assertAzioniAmmesseDaProposta(actions)

  const id  = randomUUID()
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    await session.run(`
      MATCH (t:Tenant {id: $tenantId})
      CREATE (a:AutoTrigger {
        id: $id, tenant_id: $tenantId,
        name: $nome, entity_type: $entityType, event_type: $eventType,
        conditions: $conditions, timer_delay_minutes: null,
        actions: $actions, enabled: false,
        origin: 'ai_proposal',
        execution_count: 0, last_executed_at: null,
        created_at: $now, updated_at: $now
      })
    `, { tenantId, id, nome, entityType, eventType, conditions, actions: actions ?? null, now })
  } finally {
    await session.close()
  }
  await scordaLaCacheDeiTrigger(tenantId)
  return {
    details:   { automationId: id, name: nome, entityType, eventType, enabled: false },
    undoState: { automationId: id, name: nome },
  }
}

/** Disfare = cancellare quello che la proposta aveva creato, e solo quello. */
async function cancellaAutomazioneDaProposta(
  tenantId: string, undoState: Record<string, unknown>,
): Promise<void> {
  const id = String(undoState['automationId'] ?? '')
  if (id === '') return
  const session = getSession(undefined, 'WRITE')
  try {
    /*
     * Si cancella SOLO se è ancora di quell'origine: se nel frattempo
     * qualcuno l'avesse adottata come propria — cioè se fosse cambiata
     * origine — disfare vorrebbe dire portargli via una regola sua.
     */
    await session.run(`
      MATCH (a:AutoTrigger {id: $id, tenant_id: $tenantId})
      WHERE a.origin = 'ai_proposal'
      DETACH DELETE a
    `, { tenantId, id })
  } finally {
    await session.close()
  }
  await scordaLaCacheDeiTrigger(tenantId)
}

type Esecutore = (tenantId: string, params: Record<string, unknown>) => Promise<EsitoAzione>
type Ripristino = (tenantId: string, undoState: Record<string, unknown>) => Promise<void>

const CATALOGO: Readonly<Record<ProposalActionType, { esegui: Esecutore; disfa: Ripristino | null }>> = {
  'portal_severities.remove_stale': {
    esegui: (tenantId) => togliSeveritaStantie(tenantId),
    disfa:  ripristinaSeverita,
  },
  'automation.create_disabled': {
    esegui: creaAutomazioneDaProposta,
    disfa:  cancellaAutomazioneDaProposta,
  },
}

/** Se questa azione si può disfare. La pagina lo chiede prima di offrire il bottone. */
export function azioneDisfabile(type: string): boolean {
  return isProposalActionType(type) && CATALOGO[type].disfa !== null
}

/**
 * Esegue l'azione di una proposta accettata.
 *
 * Chi chiama passa il tenant, non un contesto: l'azione scrive nella
 * configurazione del cliente e non ha bisogno di sapere chi ha cliccato —
 * quello lo registra l'Audit Log, con l'attore vero.
 */
export async function eseguiAzione(
  tenantId: string,
  azione: { type: string; params: Record<string, unknown> },
): Promise<EsitoAzione> {
  const type = assertAzioneAmmessa(azione.type, azione.params)
  logger.info({ module: 'proposals', tenantId, action: type }, 'proposals: executing accepted action')
  return CATALOGO[type].esegui(tenantId, azione.params)
}

/** Disfa un'azione già eseguita, dallo stato salvato al momento dell'esecuzione. */
export async function disfaAzione(
  tenantId: string,
  type: string,
  undoState: Record<string, unknown>,
): Promise<void> {
  const tipo = assertAzioneAmmessa(type, {})
  const disfa = CATALOGO[tipo].disfa
  if (!disfa) {
    throw new ValidationError(
      `"${type}" cannot be undone`,
      { key: 'errors.proposal.actionNotUndoable', params: { action: type } },
    )
  }
  logger.warn({ module: 'proposals', tenantId, action: tipo }, 'proposals: undoing an accepted action')
  await disfa(tenantId, undoState)
}
