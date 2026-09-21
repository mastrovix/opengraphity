/**
 * IL GIRO SI CHIUDE DA SOLO (21 set 2026).
 *
 * ## Che cosa fa
 * Due lavori, i due capi della stessa catena:
 *
 *  - `porta-il-fascicolo`: un Problem è appena nato da una proposta — si
 *    costruisce il fascicolo d'indagine, si apre la issue su GitHub, si scrive
 *    il suo numero SUL Problem e si chiede l'analisi;
 *  - `controlla`: ogni tanto si chiede a GitHub com'è finita, e quando la PR
 *    proposta dall'agente risulta UNITA il Problem passa a «risolto».
 *
 * ## Perché in coda e non dentro il clic
 * La mutation che apre il Problem deve tornare subito a chi ha cliccato:
 * GitHub sta dall'altra parte di internet, e una rete lenta non deve
 * trasformarsi in un bottone che sembra rotto. Il Problem esiste già ed è già
 * in analisi quando il lavoro parte — quello che la coda aggiunge è il
 * fascicolo su GitHub, che può arrivare un istante dopo.
 *
 * ## Perché si INTERROGA invece di farsi chiamare
 * Un webhook di GitHub verso OpenGrafo non arriverebbe: questa installazione
 * non è raggiungibile da internet. Chiedere funziona anche da dietro un
 * firewall, e il costo è una richiesta ogni quarto d'ora per ogni Problem
 * ancora aperto che ha una issue — cioè quasi sempre zero.
 *
 * ## Quando l'agente dice «non c'è niente da cambiare»
 * Succede, ed è successo davvero al primo giro. In quel caso NON si tocca il
 * Problem: resta aperto e in analisi, col verdetto dell'agente scritto sulla
 * issue. «È un guasto di trasporto» è una diagnosi, non una soluzione, e
 * chiudere il Problem da soli nasconderebbe un problema vero che nessuno ha
 * risolto. Lo stesso vale per una PR chiusa senza essere unita.
 */
import type { Worker } from 'bullmq'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { logger } from '../lib/logger.js'
import { fascicoloDelProblem } from '../lib/problemDossier.js'
import { segnaRisolto } from '../lib/indagineAutomatica.js'
import { TENANT_DI_PIATTAFORMA } from '../lib/serverLogEvents.js'
import {
  configurazioneAutoanalisi, apriIssueDelFascicolo, chiediAnalisi, statoDellAnalisi,
} from '../lib/autoanalisiGitHub.js'

const log = logger.child({ module: 'autoanalisi' })

export const AUTOANALISI_QUEUE = 'autoanalisi'

/** Ogni quanto si chiede a GitHub com'è finita. */
export const INTERVALLO_CONTROLLO_MS = 15 * 60_000

/** L'attore delle transizioni automatiche: si legge nella storia del Problem. */
export const ATTORE = 'autoanalisi'

export interface PortaIlFascicoloData {
  tenantId:      string
  problemId:     string
  problemNumber: string
  titolo:        string
}

// ── Il legame con GitHub, scritto sul Problem ────────────────────────────────

/*
 * Il numero della issue sta SUL Problem, non in una tabella a parte: è da lì
 * che ogni controllo riparte, e un legame che vive altrove si perde la prima
 * volta che qualcuno guarda il Problem e non trova niente.
 */
const SCRIVI_ISSUE_CYPHER = `
  MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
  SET p.autoanalisi_issue = $issue, p.autoanalisi_issue_at = $now
`

/*
 * I Problem che aspettano una risposta: hanno una issue e non sono ancora
 * chiusi. `is_open` del passo attuale e non lo stato del Problem, perché è il
 * passo a dire se il ticket è ancora in giro — e regge alla rinomina.
 */
const IN_ATTESA_CYPHER = `
  MATCH (p:Problem {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:CURRENT_STEP]->(cur:WorkflowStep)
  WHERE p.autoanalisi_issue IS NOT NULL AND coalesce(cur.is_open, true) = true
  RETURN p.id AS id, p.number AS number, p.autoanalisi_issue AS issue, cur.name AS passo
  ORDER BY p.autoanalisi_issue_at ASC
  LIMIT 50
`

/** Mette in coda il trasporto del fascicolo su GitHub. Non aspetta GitHub. */
export async function enqueuePortaIlFascicolo(data: PortaIlFascicoloData): Promise<void> {
  await getQueue<PortaIlFascicoloData>(AUTOANALISI_QUEUE).add('porta-il-fascicolo', data, {
    /*
     * Un solo trasporto per Problem: se la mutation viene ritentata, o due
     * repliche la servono, non si aprono due issue per lo stesso Problem.
     */
    jobId:            `fascicolo-${data.tenantId}-${data.problemId}`,
    removeOnComplete: true,
    removeOnFail:     50,
    attempts:         3,
    backoff:          { type: 'exponential', delay: 30_000 },
  })
}

// ── I due lavori ─────────────────────────────────────────────────────────────

async function portaIlFascicolo(data: PortaIlFascicoloData): Promise<void> {
  const cfg = configurazioneAutoanalisi()
  if (!cfg) {
    /*
     * Non è un errore da ritentare: è un'installazione che non ha collegato un
     * repository. Si dice una volta e si smette — il Problem resta un Problem
     * come un altro, e la diagnostica del tenant lo dichiara.
     */
    log.warn(
      { tenantId: data.tenantId, problem: data.problemNumber },
      'no GitHub repository is configured for the self-analysis: the dossier stays in the product',
    )
    return
  }

  const fascicolo = await fascicoloDelProblem(data.tenantId, data.problemId)
  if (!fascicolo) {
    /*
     * Fail-loud: chi ha aperto il Problem si aspetta che l'indagine parta, e
     * un fascicolo che non si costruisce è un difetto — non un caso normale.
     */
    throw new Error(`the investigation dossier of ${data.problemNumber} could not be built: nothing was filed on GitHub`)
  }

  const issue = await apriIssueDelFascicolo(cfg, {
    problemNumber: data.problemNumber, titolo: data.titolo, fascicolo,
  })

  const session = getSession(undefined, 'WRITE')
  try {
    await session.run(SCRIVI_ISSUE_CYPHER, {
      tenantId: data.tenantId, problemId: data.problemId, issue, now: new Date().toISOString(),
    })
  } finally {
    await session.close()
  }

  /*
   * Il legame si scrive PRIMA di chiedere l'analisi: se il dispatch fallisce e
   * il lavoro viene ritentato, `jobId` impedisce una seconda issue e il numero
   * è già al sicuro. Al contrario si sarebbe potuto avviare un'analisi su una
   * issue che il Problem non conosce.
   */
  await chiediAnalisi(cfg, { issue, problemNumber: data.problemNumber })
}

async function controlla(): Promise<void> {
  const cfg = configurazioneAutoanalisi()
  if (!cfg) return

  const session = getSession(undefined, 'READ')
  let attesa: Array<{ id: string; number: string; issue: number; passo: string }>
  try {
    attesa = await runQuery(session, IN_ATTESA_CYPHER, { tenantId: TENANT_DI_PIATTAFORMA })
  } finally {
    await session.close()
  }
  if (attesa.length === 0) return

  for (const p of attesa) {
    /*
     * Un Problem che va storto non ferma gli altri: la ricorrenza guarda
     * l'intera coda, e una issue cancellata a mano non deve lasciare fermi i
     * Problem che vengono dopo.
     */
    try {
      const stato = await statoDellAnalisi(cfg, p.issue)
      if (stato.prUnita !== true) {
        log.debug({ problem: p.number, issue: p.issue, pr: stato.pr, step: p.passo }, 'the analysis has not produced a merged change yet')
        continue
      }
      const esito = await segnaRisolto(TENANT_DI_PIATTAFORMA, p.id, p.number, ATTORE)
      log.info(
        { problem: p.number, issue: p.issue, pr: stato.pr, resolved: esito.avviata, step: esito.passo },
        'the change proposed for this problem was merged',
      )
    } catch (err) {
      log.error({ err, problem: p.number, issue: p.issue }, 'the state of this analysis could not be read, the others go on')
    }
  }
}

// ── Coda e worker ────────────────────────────────────────────────────────────

export async function startAutoanalisiWorker(): Promise<Worker<PortaIlFascicoloData>> {
  const worker = createWorker<PortaIlFascicoloData>(AUTOANALISI_QUEUE, async (job) => {
    if (job.name === 'controlla') { await controlla(); return }
    await portaIlFascicolo(job.data)
  })

  /*
   * La ricorrenza si registra a ogni avvio, come le altre: `upsert` significa
   * che riavviare non ne crea una seconda, e non c'è stato da migrare.
   */
  await getQueue<PortaIlFascicoloData>(AUTOANALISI_QUEUE).upsertJobScheduler(
    'autoanalisi-controlla',
    { every: INTERVALLO_CONTROLLO_MS },
    { name: 'controlla', data: {} as PortaIlFascicoloData, opts: { removeOnComplete: true } },
  )

  log.info({ everyMs: INTERVALLO_CONTROLLO_MS, configured: configurazioneAutoanalisi() !== null }, 'autoanalisi worker started')
  return worker
}

/** Esportate per i test: sono i due lavori, senza la coda intorno. */
export const _perITest = { portaIlFascicolo, controlla }

/** Il Problem e la sua issue, per chi deve mostrarlo. */
export async function issueDelProblem(tenantId: string, problemId: string): Promise<number | null> {
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ issue: unknown }>(session, `
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      RETURN p.autoanalisi_issue AS issue
    `, { tenantId, problemId })
    const n = row?.issue
    return typeof n === 'number' ? n : null
  } finally {
    await session.close()
  }
}
