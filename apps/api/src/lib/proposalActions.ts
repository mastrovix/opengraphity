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
import {
  PROPOSAL_FORBIDDEN_ACTION_TYPES, isProposalActionType,
  type ProposalActionType,
} from '@opengraphity/types'
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

type Esecutore = (tenantId: string, params: Record<string, unknown>) => Promise<EsitoAzione>
type Ripristino = (tenantId: string, undoState: Record<string, unknown>) => Promise<void>

const CATALOGO: Readonly<Record<ProposalActionType, { esegui: Esecutore; disfa: Ripristino | null }>> = {
  'portal_severities.remove_stale': {
    esegui: (tenantId) => togliSeveritaStantie(tenantId),
    disfa:  ripristinaSeverita,
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
