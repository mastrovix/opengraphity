/**
 * UN PROBLEM NATO DA UNA PROPOSTA CAMMINA DA SOLO (21 set 2026).
 *
 * Due movimenti, la stessa regola: si parte in analisi quando il Problem
 * nasce, e si arriva a «risolto» quando la modifica proposta dall'agente è
 * stata UNITA. In mezzo non c'è nessun clic che aggiunga informazione.
 *
 * ## Da dove nasce
 * Richiesta del proprietario: «quando apro il problem da una proposal, il
 * workflow del problem deve partire automaticamente […] e quando tutto è
 * completato anche il problem deve risolversi automaticamente». Prima il
 * Problem nasceva nel passo iniziale e restava lì finché una persona non
 * cliccava «Inizia analisi» — un gesto che non aggiungeva nessuna
 * informazione: chi apre un Problem da una proposta ha GIÀ letto la proposta
 * e ha GIÀ deciso che c'è qualcosa da capire.
 *
 * ## Il passo si riconosce dal RUOLO, non dal nome
 * `under_investigation` e `resolved` si chiamano così nel workflow di
 * fabbrica, e il cliente può rinominarli. Quello che non cambia è il ruolo
 * che il disegnatore dichiara nel metamodello: lo SCOPO (`purpose`) dove il
 * ruolo non si legge dallo stato — l'analisi — e la CATEGORIA (`category`)
 * dove il ruolo È lo stato visibile — risolto. È la stessa distinzione che
 * fanno già `requestApproval.ts` e le regole degli incident.
 *
 * ## SI CAMMINA SULLA VIA CHE IL CLIENTE HA DISEGNATO, e può essere lunga
 * La prima versione guardava un passo solo: «esiste una transizione dal passo
 * attuale a uno che soddisfa il criterio?». Per l'avvio bastava. Per la
 * chiusura NO, e la revisione l'ha trovato prima che lo trovasse un Problem
 * vero: nel workflow di fabbrica da `under_investigation` NON si va a
 * `resolved` in un passo. Le uscite sono `change_requested`, `rejected`,
 * `deferred`, `known_error` — e la via più corta è
 *
 *     under_investigation → known_error → resolved
 *
 * cioè DUE passi. Con la versione a un passo solo la chiusura automatica non
 * sarebbe scattata MAI: ogni giro avrebbe scritto «nessun passo raggiungibile»
 * in un log, e il Problem sarebbe rimasto aperto per sempre. I test non
 * l'hanno visto perché il risultato della query era finto.
 *
 * E quella via non è una scorciatoia: in ITIL un Problem di cui si conosce la
 * causa e si è identificato il rimedio È un Known Error. L'analisi dell'agente
 * è l'analisi della causa, la PR è il rimedio: passare di lì è il cammino
 * giusto, non un aggiramento.
 *
 * Quindi si cerca il cammino PIÙ CORTO, fatto solo di transizioni che il
 * cliente ha dichiarato, e lo si percorre un passo alla volta. Al massimo
 * `MAX_PASSI`: oltre, non è più «la via ovvia» ma un labirinto attraversato da
 * una macchina, e allora è meglio fermarsi e dirlo.
 *
 * ## Se non si può, si dice
 * Nessun fallback silenzioso: se il passo non esiste, non è raggiungibile, o
 * una guardia rifiuta, il Problem RESTA dov'è — nel punto del cammino in cui
 * è arrivato — e la ragione finisce in un log di errore col numero del
 * Problem. Non si fa fallire il chiamante: all'andata ha già creato e legato
 * il Problem, al ritorno sta guardando una coda di Problem e uno che va
 * storto non deve fermare gli altri.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { transitionTicket } from '../services/ticketTransition.js'
import { logger } from './logger.js'

/** Lo scopo del passo in cui un Problem è «in analisi». */
export const SCOPO_INDAGINE = 'investigation'

/**
 * La CATEGORIA del passo in cui un Problem è risolto.
 *
 * Categoria e non scopo, e non è un'incoerenza: il passo `resolved` del
 * workflow di fabbrica non dichiara un `purpose` — il suo ruolo È lo stato
 * visibile, e per quello il metamodello usa `category`, come già fanno gli
 * incident. Lo scopo serve dove il ruolo non si legge dallo stato.
 */
export const CATEGORIA_RISOLTO = 'resolved'

/**
 * Quanti passi al massimo si percorrono da soli.
 *
 * Tre perché la via di fabbrica ne chiede due (`under_investigation →
 * known_error → resolved`) e uno di margine copre un cliente che ha aggiunto
 * un passo in mezzo. Oltre, un ticket che attraversa mezzo workflow senza che
 * nessuno l'abbia guardato è più preoccupante di un ticket fermo.
 */
export const MAX_PASSI = 3

/** Com'è andata. `fatto` falso non è un errore del chiamante: è un fatto da leggere. */
export interface EsitoMovimento {
  fatto: boolean
  /** Il passo in cui il Problem si trova ADESSO, comunque sia andata. */
  passo: string | null
  /** I passi effettivamente percorsi, in ordine. Vuoto se non ci si è mossi. */
  percorsi: string[]
  motivo: 'fatto' | 'nessun_cammino' | 'transizione_rifiutata' | 'errore'
  dettaglio?: string
}

/*
 * IL CAMMINO PIÙ CORTO verso un passo che soddisfa il criterio, fatto solo di
 * transizioni dichiarate dal cliente.
 *
 * `shortestPath` e non un semplice vicino: vedi il perché in testa al file.
 * Fra due cammini della stessa lunghezza vince quello che arriva al passo
 * dichiarato PRIMA nella sequenza (`step_order`), così la scelta è la stessa a
 * ogni chiamata invece di dipendere dall'ordine in cui il database risponde.
 *
 * `nodes(cammino)` comincia dal passo ATTUALE: si salta con `[1..]`, perché
 * quello è già dove siamo.
 *
 * `MATCH (wd)-[:HAS_STEP]->(cur)` restringe alla STESSA definizione: senza,
 * si partirebbe da tutti i passi dell'installazione — ogni tenant, ogni tipo
 * di ticket — per poi buttarli via con la raggiungibilità.
 *
 * ## DUE COPIE, DI PROPOSITO
 * Cambia una parola sola fra le due, e la prima stesura le componeva con una
 * funzione. Sbagliato: `scripts/check-cypher.mjs` manda EXPLAIN su ogni query
 * LETTERALE che trova nei sorgenti, e verifica che porti il `tenant_id`. Una
 * query assemblata a runtime gli è INVISIBILE — provato rompendola apposta:
 * il guardiano restava verde.
 *
 * Fra dieci righe duplicate e due query che nessuno controlla, in questo
 * repository vincono le dieci righe.
 */
const CAMMINO_ANALISI = `
  MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
  MATCH (wi)-[:CURRENT_STEP]->(cur:WorkflowStep)
  MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(cur)
  OPTIONAL MATCH (wd)-[:HAS_STEP]->(arrivo:WorkflowStep {purpose: $scopo})
    WHERE (cur)-[:TRANSITIONS_TO*1..3]->(arrivo)
  WITH wi, cur, arrivo, shortestPath((cur)-[:TRANSITIONS_TO*1..3]->(arrivo)) AS cammino
  ORDER BY length(cammino) ASC, arrivo.step_order ASC
  RETURN wi.id AS instanceId, cur.name AS passoAttuale,
         CASE WHEN cammino IS NULL THEN [] ELSE [n IN nodes(cammino) | n.name][1..] END AS passi
  LIMIT 1
`

const CAMMINO_RISOLTO = `
  MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
  MATCH (wi)-[:CURRENT_STEP]->(cur:WorkflowStep)
  MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(cur)
  OPTIONAL MATCH (wd)-[:HAS_STEP]->(arrivo:WorkflowStep {category: $categoria})
    WHERE (cur)-[:TRANSITIONS_TO*1..3]->(arrivo)
  WITH wi, cur, arrivo, shortestPath((cur)-[:TRANSITIONS_TO*1..3]->(arrivo)) AS cammino
  ORDER BY length(cammino) ASC, arrivo.step_order ASC
  RETURN wi.id AS instanceId, cur.name AS passoAttuale,
         CASE WHEN cammino IS NULL THEN [] ELSE [n IN nodes(cammino) | n.name][1..] END AS passi
  LIMIT 1
`

/*
 * Il `3` scritto nelle due query È `MAX_PASSI`: in Cypher il tetto di un
 * cammino a lunghezza variabile non può essere un parametro, e interpolarlo
 * renderebbe la query invisibile al guardiano (vedi sopra). Questo test lo
 * tiene onesto: se qualcuno cambia la costante e non le query, cade.
 */
if (!CAMMINO_ANALISI.includes(`*1..${MAX_PASSI}]`) || !CAMMINO_RISOLTO.includes(`*1..${MAX_PASSI}]`)) {
  throw new Error(`[indagineAutomatica] MAX_PASSI is ${MAX_PASSI} but the queries do not walk that far: update both`)
}

interface Movimento {
  cypher: string
  /** I parametri del criterio: `{ scopo }` oppure `{ categoria }`. */
  criterio: Record<string, string>
  /** Per i log: che cosa si stava tentando. */
  senzaCammino: string
  rifiutata:    string
  riuscita:     string
}

/*
 * IL CORPO CONDIVISO DAI DUE MOVIMENTI.
 *
 * Avvio e chiusura fanno la stessa cosa — trova il cammino, percorrilo, e se
 * non si può dillo — e cambiano solo per il criterio e per le frasi. Tenerli
 * separati avrebbe voluto dire due copie della stessa gestione degli errori,
 * che è il posto dove le copie divergono.
 */
async function muovi(
  tenantId: string, problemId: string, problemNumber: string, userId: string, m: Movimento,
): Promise<EsitoMovimento> {
  const session = getSession(undefined, 'WRITE')
  const percorsi: string[] = []
  try {
    const row = await runQueryOne<{ instanceId: string; passoAttuale: string; passi: string[] }>(
      session, m.cypher, { tenantId, problemId, ...m.criterio },
    )
    if (!row) {
      logger.error(
        { module: 'proposals', tenantId, problem: problemNumber },
        'proposals: the problem has no workflow instance, it cannot be moved',
      )
      return { fatto: false, passo: null, percorsi, motivo: 'nessun_cammino' }
    }
    if (row.passi.length === 0) {
      logger.error(
        { module: 'proposals', tenantId, problem: problemNumber, step: row.passoAttuale, maxSteps: MAX_PASSI, ...m.criterio },
        m.senzaCammino,
      )
      return { fatto: false, passo: row.passoAttuale, percorsi, motivo: 'nessun_cammino' }
    }

    /*
     * Un passo alla volta, e ci si ferma al primo rifiuto: una guardia che
     * dice «non ancora» a metà strada è una risposta, non un incidente — il
     * Problem resta dov'è arrivato, che è comunque più avanti di prima.
     */
    let passoCorrente = row.passoAttuale
    for (const prossimo of row.passi) {
      // The pipeline of the transitions (wave 7 · B1): a refusal is also
      // noted on the problem, once per reason.
      const esito = await transitionTicket(session, {
        tenantId, instanceId: row.instanceId, toStep: prossimo,
        actor: { kind: 'system', path: 'investigation', userId }, triggerType: 'automatic',
      })
      if (!esito.moved) {
        const dettaglio = esito.refusal.message
        logger.error(
          { module: 'proposals', tenantId, problem: problemNumber, from: passoCorrente, to: prossimo, walked: percorsi, reason: dettaglio },
          m.rifiutata,
        )
        return { fatto: false, passo: passoCorrente, percorsi, motivo: 'transizione_rifiutata', dettaglio }
      }
      percorsi.push(prossimo)
      passoCorrente = prossimo
    }

    logger.info(
      { module: 'proposals', tenantId, problem: problemNumber, step: passoCorrente, walked: percorsi },
      m.riuscita,
    )
    return { fatto: true, passo: passoCorrente, percorsi, motivo: 'fatto' }
  } finally {
    await session.close()
  }
}

/**
 * Porta un Problem nel suo passo di analisi.
 *
 * `triggerType: 'automatic'` e non `'manual'`: nella storia del Problem si
 * deve leggere che ad avanzare è stato il prodotto, non una persona che non
 * ha cliccato niente.
 */
export async function avviaIndagine(
  tenantId: string, problemId: string, problemNumber: string, userId: string,
): Promise<EsitoMovimento> {
  /*
   * NIENTE ESCE DA QUI SOTTO FORMA DI ECCEZIONE, ed è una scelta, non una
   * dimenticanza: il chiamante ha già creato e legato il Problem, e un errore
   * qui non deve far fallire la sua mutazione — chi ha cliccato si vedrebbe
   * dire «non ho aperto niente» mentre il Problem esiste. Non è un fallback
   * silenzioso: l'errore si scrive per intero e l'esito lo dichiara.
   */
  return senzaEccezioni(tenantId, problemNumber, 'starting the investigation', () =>
    muovi(tenantId, problemId, problemNumber, userId, {
      cypher:       CAMMINO_ANALISI,
      criterio:     { scopo: SCOPO_INDAGINE },
      senzaCammino: 'proposals: no step with the investigation purpose is reachable, the problem stays where it is',
      rifiutata:    'proposals: a transition towards the investigation step was refused, the problem stays where it got to',
      riuscita:     'proposals: the problem opened from a proposal went straight into investigation',
    }))
}

/**
 * Porta un Problem nel suo passo RISOLTO, perché la modifica proposta
 * dall'agente è stata unita.
 *
 * Non chiude il Problem: lo segna risolto, che è un passo diverso. La verifica
 * della soluzione e la chiusura restano di chi gestisce il processo — il
 * workflow di fabbrica ha apposta «Verifica soluzione e chiudi», ed è un
 * giudizio, non un fatto che GitHub possa comunicare.
 */
export async function segnaRisolto(
  tenantId: string, problemId: string, problemNumber: string, userId: string,
): Promise<EsitoMovimento> {
  return senzaEccezioni(tenantId, problemNumber, 'marking the problem as resolved', () =>
    muovi(tenantId, problemId, problemNumber, userId, {
      cypher:       CAMMINO_RISOLTO,
      criterio:     { categoria: CATEGORIA_RISOLTO },
      senzaCammino: 'proposals: no step in the resolved category is reachable, the problem stays where it is',
      rifiutata:    'proposals: a transition towards the resolved step was refused, the problem stays where it got to',
      riuscita:     'proposals: the merged change closed the loop, the problem is resolved',
    }))
}

/** Un errore qui si scrive e si dichiara, non si propaga: vedi `avviaIndagine`. */
async function senzaEccezioni(
  tenantId: string, problemNumber: string, cosa: string, corpo: () => Promise<EsitoMovimento>,
): Promise<EsitoMovimento> {
  try {
    return await corpo()
  } catch (err) {
    logger.error(
      { err, module: 'proposals', tenantId, problem: problemNumber, what: cosa },
      'proposals: an automatic move of the problem failed, it stays where it is',
    )
    return {
      fatto: false, passo: null, percorsi: [], motivo: 'errore',
      dettaglio: err instanceof Error ? err.message : String(err),
    }
  }
}
