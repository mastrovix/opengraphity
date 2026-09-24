/**
 * IL GIRO DELLE PROPOSTE (20 set 2026).
 *
 * ## Perché una coda propria e non `REPEATABLE_JOBS`
 * La tabella cron di `maintenance.worker.ts` sembrava il posto naturale — «il
 * giro notturno è una riga» — e non lo è, per tre ragioni verificate nel
 * codice:
 *
 *  1. `startMaintenanceWorker()` girava nel processo **API** (dal 23 set 2026
 *     gira nel servizio `worker`, gruppo `maintenance`, ma la ragione resta), e
 *     `workerProfiles.ts` racconta perché `events` ed `embedding` sono stati
 *     estratti: «~70 slot di job sopra un pool Neo4j da 50 condiviso con i
 *     resolver». Un giro che per ogni cliente legge la configurazione e un
 *     giorno aspetterà un modello è esattamente il carico che quell'estrazione
 *     voleva togliere da lì.
 *  2. Quella coda ha concorrenza 1 e i job si aggiungono con payload VUOTO:
 *     non c'è dove mettere il tenant, quindi non esiste un «fai girare adesso
 *     per questo cliente».
 *  3. Un job unico che gira tutti i clienti in sequenza supera il
 *     `lockDuration` predefinito senza rinnovarlo: BullMQ lo dichiara
 *     *stalled* e lo riesegue. Con un job per tenant e un `jobId`
 *     deterministico, la riesecuzione è innocua.
 *
 * Lo scanner delle anomalie aveva già risolto tutto questo. Questa è la stessa
 * forma.
 *
 * ## Il fallimento di un cliente non ferma gli altri
 * Ogni cliente ha la sua coda e il suo job (23 set 2026): un cliente rotto fa
 * fallire il SUO giro, visibile in BullMQ, e gli altri non se ne accorgono.
 */
import type { Job, Queue } from 'bullmq'
import type { TenantWorkerPool } from '@opengraphity/events'
import { randomUUID } from 'node:crypto'
import { createTenantWorkers, getSharedRedis } from '../lib/bullmq.js'
import { logger } from '../lib/logger.js'
import { audit } from '../lib/audit.js'
import { analizzaConfigurazione } from '../lib/proposalAnalysts.js'
import { analizzaPiattaforma } from '../lib/platformAnalyst.js'
import { analizzaLavoroQuotidiano } from '../lib/dailyWorkAnalyst.js'
import { analizzaConfigurazioneConIlModello } from '../lib/configurationAnalyst.js'
import { scriviProposta, scadiLeVecchie, risvegliaLeRimandate, purgaLeChiuse, type ProposalToWrite } from '../lib/proposals.js'

export const PROPOSAL_SCANNER_QUEUE = 'proposal-scanner'

/** The nightly job of a tenant, in its queue `proposal-scanner@<tenant>` (23 Sep 2026). */
export interface ProposalScanJobData { tenantId: string }

/** Il giro di un cliente solo. Restituisce quante proposte sono nate. */
/**
 * Gli analisti, in ordine. Ognuno guarda dei dati e consegna proposte; chi
 * non ha niente da dire torna una lista vuota.
 *
 * L'analista della piattaforma (ondata 4) è il primo con un modello dentro, e
 * decide DA SÉ di non girare: tenant sbagliato, interruttore spento, poche
 * firme, nessuna chiave. Non alza mai per una di queste ragioni — sono stati
 * normali, e qui dentro un'eccezione farebbe risultare fallito il giro di un
 * cliente che sta funzionando come configurato.
 */
const ANALISTI: ReadonlyArray<(tenantId: string) => Promise<ProposalToWrite[]>> = [
  analizzaConfigurazione,
  analizzaPiattaforma,
  analizzaLavoroQuotidiano,
  analizzaConfigurazioneConIlModello,
]

export async function analizzaCliente(tenantId: string): Promise<{ create: number; saltate: Record<string, number> }> {
  const proposte: ProposalToWrite[] = []
  for (const analista of ANALISTI) {
    try {
      proposte.push(...await analista(tenantId))
    } catch (err) {
      // Un analista che cade non porta via gli altri: le proposte di chi ha
      // funzionato si scrivono comunque, e il giro del cliente fallisce solo
      // se a cadere è tutto (l'eccezione risale da `proposalScannerProcessor`).
      logger.error(
        { module: 'proposals', tenantId, analista: analista.name, err: err instanceof Error ? err.message : String(err) },
        'proposal-scanner: analista fallito',
      )
    }
  }
  const saltate: Record<string, number> = {}
  let create = 0
  for (const p of proposte) {
    const esito = await scriviProposta(p)
    if (esito.scritta) create += 1
    else saltate[esito.motivo] = (saltate[esito.motivo] ?? 0) + 1
  }
  logger.info({ module: 'proposals', tenantId, create, saltate }, 'proposal-scanner: tenant analysed')
  return { create, saltate }
}

/**
 * Il giro notturno di UN cliente, nella sua coda. Un cliente sospeso non ci
 * arriva: le sue code sono in pausa finché non viene riattivato.
 */
export async function proposalScannerProcessor(job: Job<ProposalScanJobData>): Promise<void> {
  const { tenantId } = job.data

  /*
   * La manutenzione del ciclo di vita gira PRIMA dell'analisi: scadere le
   * vecchie libera gli slot del tetto, e senza quello un cliente con cinque
   * proposte ignorate non ne riceverebbe mai più — in silenzio, in un modo
   * indistinguibile dal funzionare.
   */
  const scadute = await scadiLeVecchie(tenantId)
  const risvegliate = await risvegliaLeRimandate(tenantId)
  const purgate = await purgaLeChiuse(tenantId)
  if (scadute > 0 || risvegliate > 0 || purgate > 0) {
    logger.info({ module: 'proposals', tenantId, scadute, risvegliate, purgate }, 'proposal-scanner: lifecycle swept')
  }

  /*
   * Anche il giro notturno passa dal lucchetto: se un amministratore ha
   * appena cliccato «Analizza adesso», rifarlo costa il doppio e non produce
   * niente di nuovo — `scriviProposta` scarterebbe tutto come già presente,
   * ma i gettoni sono già spesi.
   */
  const esito = await conIlLucchetto(tenantId, () => analizzaCliente(tenantId))
  if (esito === null) {
    logger.info({ module: 'proposals', tenantId }, 'proposal-scanner: already running, skipped')
    return
  }
  await recordAnalysisRun(tenantId, esito, 'nightly')
}

/**
 * THE RUN LEAVES ITS TRACE (tour of 23 Sep 2026).
 *
 * The page says when the analysis last ran, and tells «never ran» apart from
 * «ran and found nothing» — reading the `proposal.analysis_run` entries. Only
 * the button wrote one: a tenant analysed every night for a month, with
 * nothing to propose, read «never ran». The run by the queue writes the same
 * entry, as the product (`system`), so it stays out of what people did.
 */
export async function recordAnalysisRun(
  tenantId: string, esito: { create: number; saltate: Record<string, number> }, source: 'nightly',
): Promise<void> {
  await audit({ tenantId, userId: 'system', userEmail: 'system', role: 'system' } as never,
    'proposal.analysis_run', 'Proposal', tenantId, { created: esito.create, skipped: esito.saltate, source })
}

/**
 * IL LUCCHETTO, QUELLO VERO (20 set 2026, rimedio c).
 *
 * Qui c'era `enqueueProposalScan`, che accodava un job con un `jobId` per
 * minuto — e aveva ZERO chiamanti. Il commento in `resolvers/proposals.ts`
 * diceva «per il click basta il lock, che è il `jobId` per minuto»: il lock
 * esisteva, il cammino che lo usava no. `runProposalAnalysis` chiamava
 * `analizzaCliente` in linea, quindi due click ravvicinati — o un click
 * mentre il giro notturno lavorava sullo stesso cliente — facevano partire
 * tre chiamate al modello due volte.
 *
 * Adesso è un lucchetto di Redis con scadenza, preso da TUTTI i cammini che
 * analizzano un cliente. La scadenza serve perché un processo che muore a
 * metà non lasci un cliente bloccato per sempre; il token serve perché a
 * rilasciarlo sia solo chi l'ha preso, e non un secondo giro che nel
 * frattempo l'ha riacquisito dopo la scadenza.
 */
export const LUCCHETTO_SECONDI = 300

function chiaveDelLucchetto(tenantId: string): string {
  return `proposal-scan-lock:${tenantId}`
}

/**
 * Esegue `lavoro` se il cliente non è già in analisi.
 *
 * Restituisce `null` quando il lucchetto è di qualcun altro: chi chiama
 * decide se è un errore da mostrare (il bottone) o una riga di log (il giro
 * notturno). Se Redis non risponde si PROCEDE — il lucchetto evita una spesa
 * doppia, e rinunciare all'analisi perché il lucchetto è irraggiungibile
 * sarebbe spegnere la funzione per proteggere un'ottimizzazione. È il verso
 * opposto del varco dell'archivio (rimedio a), e per una ragione diversa:
 * là si protegge il dato di un cliente, qui solo un costo.
 */
export async function conIlLucchetto<T>(
  tenantId: string, lavoro: () => Promise<T>,
): Promise<T | null> {
  const chiave = chiaveDelLucchetto(tenantId)
  const token = randomUUID()
  let preso: boolean
  try {
    preso = (await getSharedRedis().set(chiave, token, 'EX', LUCCHETTO_SECONDI, 'NX')) === 'OK'
  } catch (err) {
    logger.warn(
      { module: 'proposals', tenantId, err: err instanceof Error ? err.message : String(err) },
      'proposal-scanner: lock unavailable, analysing anyway',
    )
    return lavoro()
  }
  if (!preso) return null
  try {
    return await lavoro()
  } finally {
    try {
      // Si rilascia solo se è ancora IL NOSTRO: dopo la scadenza il lucchetto
      // può essere di un altro giro, e cancellarlo lo lascerebbe scoperto.
      const attuale = await getSharedRedis().get(chiave)
      if (attuale === token) await getSharedRedis().del(chiave)
    } catch { /* scade da solo: non vale un errore */ }
  }
}

/**
 * Il giro notturno di un cliente, nella sua coda: un Job Scheduler (BullMQ 6)
 * con un'identità esplicita — `upsert` da ogni processo e a ogni avvio non ne
 * crea un secondo.
 *
 * Le 4:30 e non le 3: le purghe della manutenzione girano fra le 3:30 e le
 * 4:15, e anche se le due cose non si toccano, due lavori pesanti insieme su
 * un pool Neo4j condiviso sono un rischio gratuito.
 */
export async function scheduleProposalScan(queue: Queue, tenantId: string): Promise<void> {
  await queue.upsertJobScheduler(
    'proposal-scanner-nightly',
    { pattern: '30 4 * * *' },
    { name: 'scan', data: { tenantId }, opts: { removeOnComplete: true } },
  )
}

/**
 * One worker per tenant on `proposal-scanner@<tenant>`, each with its tenant's
 * nightly run. Every tenant's run fires at 04:30: one at a time in this
 * process, as when one job went through the tenants in turn — N analyses at
 * once would be N concurrent calls to the model and N graph reads.
 */
export function startProposalScanner(): TenantWorkerPool<ProposalScanJobData> {
  return createTenantWorkers<ProposalScanJobData>(PROPOSAL_SCANNER_QUEUE, proposalScannerProcessor, { schedule: scheduleProposalScan, processLimit: 1 })
}
