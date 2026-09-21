/**
 * UN PROBLEM NATO DA UNA PROPOSTA CAMMINA DA SOLO (21 set 2026).
 *
 * Due movimenti, la stessa regola: si parte in analisi quando il Problem
 * nasce, e si arriva a «risolto» quando la modifica proposta dall'agente è
 * stata UNITA. In mezzo non c'è nessun clic che aggiunga informazione.
 *
 * ## Da dove nasce
 * Richiesta del proprietario: «quando apro il problem da una proposal, il
 * workflow del problem deve partire automaticamente». Prima il Problem
 * nasceva nel passo iniziale e restava lì finché una persona non cliccava
 * «Inizia analisi» — un gesto che non aggiungeva nessuna informazione: chi
 * apre un Problem da una proposta ha GIÀ letto la proposta e ha GIÀ deciso
 * che c'è qualcosa da capire. Il passo iniziale diceva il falso.
 *
 * ## Perché si cerca lo SCOPO e non il nome
 * Il passo non si chiama `under_investigation`: si chiama così nel workflow
 * di fabbrica, e il cliente può rinominarlo. Quello che non cambia è il suo
 * SCOPO, `purpose: 'investigation'`, che il disegnatore scrive nel
 * metamodello proprio perché il codice possa riconoscere un passo senza
 * dipendere da come è stato chiamato. Stessa regola di `requestApproval.ts`
 * per l'approvazione.
 *
 * Si guarda inoltre solo fra i passi RAGGIUNGIBILI dal passo attuale: se il
 * cliente ha disegnato un workflow in cui dal passo iniziale non si va in
 * analisi, quel disegno vince e questa funzione non lo scavalca.
 *
 * ## Se non si può, si dice
 * Nessun fallback silenzioso: se il passo di scopo `investigation` non
 * esiste, non è raggiungibile, o la transizione viene rifiutata da una
 * guardia, il Problem RESTA dov'è e la ragione finisce in un log di errore
 * con dentro il numero del Problem. Non si fa fallire la mutazione: il
 * Problem è già stato creato e legato, e cancellarlo perché non si è potuto
 * avanzare di un passo sarebbe peggio del problema che risolve.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
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

/** Com'è andata. `avviata` falso non è un errore della mutazione: è un fatto da leggere. */
export interface EsitoIndagine {
  avviata: boolean
  /** Il passo in cui il Problem si trova ADESSO, comunque sia andata. */
  passo: string | null
  motivo: 'avviata' | 'nessun_passo_di_analisi' | 'transizione_rifiutata' | 'errore'
  dettaglio?: string
}

/*
 * Il passo di analisi RAGGIUNGIBILE dal passo attuale, il più avanti nella
 * sequenza per primo: `step_order` è l'ordine che il disegnatore dichiara, e
 * ordinare rende la scelta la stessa a ogni chiamata anche nel caso — legale
 * ma strano — di due passi con lo stesso scopo.
 */
const PASSO_DI_ANALISI_CYPHER = `
  MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
  MATCH (wi)-[:CURRENT_STEP]->(cur:WorkflowStep)
  OPTIONAL MATCH (cur)-[:TRANSITIONS_TO]->(target:WorkflowStep {purpose: $scopo})
  WITH wi, cur, target ORDER BY target.step_order ASC
  RETURN wi.id AS instanceId, cur.name AS passoAttuale, target.name AS passoDiAnalisi
  LIMIT 1
`

/*
 * Il passo RISOLTO raggiungibile dal passo attuale. Stessa forma della query
 * qui sopra, criterio diverso: `category` invece di `purpose` — vedi
 * `CATEGORIA_RISOLTO` per il perché.
 */
const PASSO_RISOLTO_CYPHER = `
  MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
  MATCH (wi)-[:CURRENT_STEP]->(cur:WorkflowStep)
  OPTIONAL MATCH (cur)-[:TRANSITIONS_TO]->(target:WorkflowStep {category: $categoria})
  WITH wi, cur, target ORDER BY target.step_order ASC
  RETURN wi.id AS instanceId, cur.name AS passoAttuale, target.name AS passoDiAnalisi
  LIMIT 1
`

/**
 * Porta un Problem nel suo passo di analisi.
 *
 * `triggerType: 'automatic'` e non `'manual'`: nella storia del Problem si
 * deve leggere che ad avanzare è stato il prodotto, non una persona che non
 * ha cliccato niente.
 */
export async function avviaIndagine(
  tenantId: string, problemId: string, problemNumber: string, userId: string,
): Promise<EsitoIndagine> {
  /*
   * NIENTE ESCE DA QUI SOTTO FORMA DI ECCEZIONE, ed è una scelta, non una
   * dimenticanza: il chiamante ha già creato e legato il Problem, e un errore
   * qui non deve far fallire la sua mutazione — chi ha cliccato si vedrebbe
   * dire «non ho aperto niente» mentre il Problem esiste. Non è un fallback
   * silenzioso: l'errore si scrive per intero e l'esito lo dichiara.
   */
  try {
    return await avviaIndagineODiciPerche(tenantId, problemId, problemNumber, userId)
  } catch (err) {
    logger.error(
      { err, module: 'proposals', tenantId, problem: problemNumber },
      'proposals: starting the investigation failed, the problem stays in its initial step',
    )
    return {
      avviata: false, passo: null, motivo: 'errore',
      dettaglio: err instanceof Error ? err.message : String(err),
    }
  }
}

/*
 * IL CORPO CONDIVISO DAI DUE MOVIMENTI.
 *
 * Avvio e chiusura fanno la stessa cosa — trova il passo raggiungibile che
 * soddisfa un criterio, transita, e se non si può dillo — e cambiano solo per
 * il criterio e per le frasi. Tenerli separati avrebbe voluto dire due copie
 * della stessa gestione degli errori, che è il posto dove le copie divergono.
 */
interface Movimento {
  cypher: string
  /** I parametri del criterio: `{ scopo }` oppure `{ categoria }`. */
  criterio: Record<string, string>
  /** Per i log: che cosa si stava tentando. */
  senzaPasso: string
  rifiutata:  string
  riuscita:   string
}

async function muovi(
  tenantId: string, problemId: string, problemNumber: string, userId: string, m: Movimento,
): Promise<EsitoIndagine> {
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ instanceId: string; passoAttuale: string; passoDiAnalisi: string | null }>(
      session, m.cypher, { tenantId, problemId, ...m.criterio },
    )
    if (!row) {
      logger.error(
        { module: 'proposals', tenantId, problem: problemNumber },
        'proposals: the problem has no workflow instance, it cannot be moved',
      )
      return { avviata: false, passo: null, motivo: 'nessun_passo_di_analisi' }
    }
    if (!row.passoDiAnalisi) {
      logger.error(
        { module: 'proposals', tenantId, problem: problemNumber, step: row.passoAttuale, ...m.criterio },
        m.senzaPasso,
      )
      return { avviata: false, passo: row.passoAttuale, motivo: 'nessun_passo_di_analisi' }
    }

    const esito = await workflowEngine.transition(
      session,
      {
        instanceId:  row.instanceId,
        toStepName:  row.passoDiAnalisi,
        triggeredBy: userId,
        triggerType: 'automatic',
        tenantId,
      },
      { userId, entityData: {} },
    )
    if (!esito.success) {
      const dettaglio = esito.error ?? 'unknown reason'
      logger.error(
        { module: 'proposals', tenantId, problem: problemNumber, from: row.passoAttuale, to: row.passoDiAnalisi, reason: dettaglio },
        m.rifiutata,
      )
      return { avviata: false, passo: row.passoAttuale, motivo: 'transizione_rifiutata', dettaglio }
    }

    logger.info(
      { module: 'proposals', tenantId, problem: problemNumber, step: row.passoDiAnalisi },
      m.riuscita,
    )
    return { avviata: true, passo: row.passoDiAnalisi, motivo: 'avviata' }
  } finally {
    await session.close()
  }
}

async function avviaIndagineODiciPerche(
  tenantId: string, problemId: string, problemNumber: string, userId: string,
): Promise<EsitoIndagine> {
  return muovi(tenantId, problemId, problemNumber, userId, {
    cypher:     PASSO_DI_ANALISI_CYPHER,
    criterio:   { scopo: SCOPO_INDAGINE },
    senzaPasso: 'proposals: no step with the investigation purpose is reachable from the current one, the problem stays where it is',
    rifiutata:  'proposals: the transition to the investigation step was refused, the problem stays where it is',
    riuscita:   'proposals: the problem opened from a proposal went straight into investigation',
  })
}

/**
 * Porta un Problem nel suo passo RISOLTO, perché la modifica proposta
 * dall'agente è stata unita.
 *
 * Non chiude il Problem: lo segna risolto, che è un passo diverso. La verifica
 * della soluzione e la chiusura restano di chi gestisce il processo — il
 * workflow di fabbrica ha apposta «Verifica soluzione e chiudi», ed è un
 * giudizio, non un fatto che GitHub possa comunicare.
 *
 * Come l'avvio, da qui non esce mai un'eccezione: chi chiama è una ricorrenza
 * che guarda molti Problem, e uno che va storto non deve fermare gli altri.
 */
export async function segnaRisolto(
  tenantId: string, problemId: string, problemNumber: string, userId: string,
): Promise<EsitoIndagine> {
  try {
    return await muovi(tenantId, problemId, problemNumber, userId, {
      cypher:     PASSO_RISOLTO_CYPHER,
      criterio:   { categoria: CATEGORIA_RISOLTO },
      senzaPasso: 'proposals: no step in the resolved category is reachable from the current one, the problem stays where it is',
      rifiutata:  'proposals: the transition to the resolved step was refused, the problem stays where it is',
      riuscita:   'proposals: the merged change closed the loop, the problem is resolved',
    })
  } catch (err) {
    logger.error(
      { err, module: 'proposals', tenantId, problem: problemNumber },
      'proposals: marking the problem as resolved failed, it stays where it is',
    )
    return {
      avviata: false, passo: null, motivo: 'errore',
      dettaglio: err instanceof Error ? err.message : String(err),
    }
  }
}
