/**
 * IL GIRO DELLE PROPOSTE (20 set 2026).
 *
 * ## Perché una coda propria e non `REPEATABLE_JOBS`
 * La tabella cron di `maintenance.worker.ts` sembrava il posto naturale — «il
 * giro notturno è una riga» — e non lo è, per tre ragioni verificate nel
 * codice:
 *
 *  1. `startMaintenanceWorker()` gira nel processo **API**, e
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
 * Si accumulano e si alza alla fine, come `anomalyScannerProcessor`: un giro
 * con un cliente rotto non deve risultare completato, ma nemmeno impedire agli
 * altri sei di avere le loro proposte.
 */
import type { Job, Worker } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { getSession } from '@opengraphity/neo4j'
import { getQueue, createWorker, getSharedRedis } from '../lib/bullmq.js'
import { logger } from '../lib/logger.js'
import { analizzaConfigurazione } from '../lib/proposalAnalysts.js'
import { analizzaPiattaforma } from '../lib/platformAnalyst.js'
import { analizzaLavoroQuotidiano } from '../lib/dailyWorkAnalyst.js'
import { analizzaConfigurazioneConIlModello } from '../lib/configurationAnalyst.js'
import { scriviProposta, scadiLeVecchie, risvegliaLeRimandate, type ProposalToWrite } from '../lib/proposals.js'

export const PROPOSAL_SCANNER_QUEUE = 'proposal-scanner'

export interface ProposalScanJobData { tenantId?: string }

/**
 * I clienti su cui girare.
 *
 * Si escludono i sospesi — un tenant sospeso non deve ricevere proposte che
 * nessuno leggerà — e lo scope di sistema, che non è un cliente. Le due
 * convenzioni nel codice erano incoerenti (`eventRetention` li prende tutti,
 * `backfill-embeddings` esclude `system`): qui la regola è scritta una volta
 * e sta in un posto solo.
 */
async function clientiDaAnalizzare(): Promise<string[]> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (t:Tenant)
      WHERE t.id <> 'system' AND coalesce(t.status, 'active') <> 'suspended'
      RETURN t.id AS id ORDER BY id
    `))
    return res.records.map((r) => r.get('id') as string)
  } finally {
    await session.close()
  }
}

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

export async function proposalScannerProcessor(job: Job<ProposalScanJobData>): Promise<void> {
  const richiesto = job.data?.tenantId

  /*
   * La manutenzione del ciclo di vita gira PRIMA dell'analisi, e solo nel
   * giro generale: scadere le vecchie libera gli slot del tetto, e senza
   * quello un cliente con cinque proposte ignorate non ne riceverebbe mai
   * più — in silenzio, in un modo indistinguibile dal funzionare.
   */
  if (!richiesto) {
    const scadute = await scadiLeVecchie()
    const risvegliate = await risvegliaLeRimandate()
    if (scadute > 0 || risvegliate > 0) {
      logger.info({ module: 'proposals', scadute, risvegliate }, 'proposal-scanner: lifecycle swept')
    }
  }

  const clienti = richiesto ? [richiesto] : await clientiDaAnalizzare()
  const falliti: string[] = []
  for (const tenantId of clienti) {
    try {
      /*
       * Anche il giro notturno passa dal lucchetto: se un amministratore ha
       * appena cliccato «Analizza adesso», rifarlo costa il doppio e non
       * produce niente di nuovo — `scriviProposta` scarterebbe tutto come
       * già presente, ma i gettoni sono già spesi.
       */
      const esito = await conIlLucchetto(tenantId, () => analizzaCliente(tenantId))
      if (esito === null) {
        logger.info({ module: 'proposals', tenantId }, 'proposal-scanner: already running, skipped')
      }
    } catch (err) {
      falliti.push(tenantId)
      logger.error(
        { module: 'proposals', tenantId, err: err instanceof Error ? err.message : String(err) },
        'proposal-scanner: tenant failed',
      )
    }
  }
  if (falliti.length > 0) {
    throw new Error(`proposal-scanner: ${String(falliti.length)} tenant(s) failed: ${falliti.join(', ')} — see log`)
  }
}

export function getProposalScannerQueue() {
  return getQueue<ProposalScanJobData>(PROPOSAL_SCANNER_QUEUE)
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
  let preso = false
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
 * Il giro notturno: una volta al giorno, tutti i clienti.
 *
 * Le 4:30 e non le 3: le purghe della manutenzione girano fra le 3:30 e le
 * 4:15, e anche se le due cose non si toccano, due lavori pesanti insieme su
 * un pool Neo4j condiviso sono un rischio gratuito.
 */
export async function startProposalScanner(): Promise<Worker<ProposalScanJobData>> {
  const worker = createWorker<ProposalScanJobData>(PROPOSAL_SCANNER_QUEUE, proposalScannerProcessor)

  /*
   * JOB SCHEDULER, non piu' «repeat» (21 set 2026, BullMQ 6).
   *
   * BullMQ 6 ha RIMOSSO i job ripetibili: `repeat` su `add()`, la classe
   * `Repeat`, `getRepeatableJobs()` e `removeRepeatable*()` non esistono piu'.
   * Al loro posto i Job Scheduler, che hanno un'identita' esplicita — il primo
   * argomento — invece di essere dedotta da (nome, opzioni di ripetizione).
   *
   * La ricorrenza si registra a ogni avvio del worker, come prima: non c'e'
   * stato da migrare, e `upsert` significa che riavviare non ne crea una
   * seconda.
   */
  await getProposalScannerQueue().upsertJobScheduler(
    'proposal-scanner-nightly',
    { pattern: '30 4 * * *' },
    { name: 'scan', data: {}, opts: { removeOnComplete: true } },
  )

  logger.info({ module: 'proposals' }, 'proposal-scanner started (nightly 04:30)')
  return worker
}
