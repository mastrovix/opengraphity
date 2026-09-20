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
import { getSession } from '@opengraphity/neo4j'
import { getQueue, createWorker } from '../lib/bullmq.js'
import { logger } from '../lib/logger.js'
import { analizzaConfigurazione } from '../lib/proposalAnalysts.js'
import { analizzaPiattaforma } from '../lib/platformAnalyst.js'
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
      await analizzaCliente(tenantId)
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
 * «Analizza adesso» per un cliente solo.
 *
 * Il `jobId` per minuto è il lock che impedisce il doppio costo: due click
 * ravvicinati, o un click mentre il giro notturno sta già lavorando su quel
 * cliente, producono un job solo.
 */
export async function enqueueProposalScan(tenantId: string): Promise<void> {
  await getProposalScannerQueue().add('scan-manual', { tenantId }, {
    jobId:            `proposal-manual-${tenantId}-${String(Math.floor(Date.now() / 60_000))}`,
    removeOnComplete: true,
  })
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

  await getProposalScannerQueue().add(
    'scan',
    {},
    { repeat: { pattern: '30 4 * * *' }, jobId: 'proposal-scanner-nightly', removeOnComplete: true },
  )

  logger.info({ module: 'proposals' }, 'proposal-scanner started (nightly 04:30)')
  return worker
}
