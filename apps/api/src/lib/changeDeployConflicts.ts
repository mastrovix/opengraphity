/**
 * I CONFLITTI DI RILASCIO DI UNA CHANGE (18 set 2026).
 *
 * La domanda, come l'ha posta il proprietario: «quali change, **per il solo
 * deploy** e non per la validazione, operano su uno stesso CI in una finestra
 * che si sovrappone alla mia?». È la domanda del CAB, e prima di questa
 * funzione l'unico modo di risponderla era aprire il calendario e guardare i
 * colori — cioè a occhio, su una pagina diversa da quella in cui si decide.
 *
 * ## Solo i rilasci
 * Le validazioni si possono pestare i piedi senza conseguenze: sono prove, e
 * due squadre possono provare lo stesso CI nello stesso pomeriggio. Il
 * RILASCIO no: due deploy sullo stesso CI nella stessa ora sono due mani sulla
 * stessa macchina. Perciò si confrontano le `releaseWindow` e si ignorano le
 * `validationWindow` — che restano nell'inviluppo indicizzato, e per questo
 * l'inviluppo qui serve solo a SCARTARE candidati, mai a dichiarare un
 * conflitto.
 *
 * ## Lo stesso CI
 * Il piano è per TASK, e ogni task di piano nomina il suo CI (`dp.ci_id`):
 * due change confliggono quando hanno un piano sullo STESSO `ci_id`. Due
 * change che rilasciano nello stesso momento su CI diversi non sono un
 * conflitto — il calendario le segna in ambra, e quello è un avviso di
 * affollamento, non una collisione.
 *
 * ## Le change concluse non confliggono
 * Si guarda la CATEGORIA del passo corrente (`WorkflowStep.category`), non il
 * suo nome: un cliente che rinomina «closed» in «Archiviata» non deve
 * ritrovarsi conflitti con change finite sei mesi prima. Una categoria
 * sconosciuta — o una change senza istanza di workflow, come le più vecchie —
 * conta come IN CORSO: meglio un conflitto in più da leggere che uno in meno
 * da scoprire il giorno del rilascio.
 *
 * ## La regola della sovrapposizione è condivisa
 * `finestreSiSovrappongono` sta in `@opengraphity/types` e la usa anche il
 * calendario: due copie avrebbero risposto in modo diverso alla domanda «un
 * rilascio che finisce quando l'altro comincia è un conflitto?» (no).
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import { finestreSiSovrappongono, sovrapposizione, finestraValida, type FinestraDiRilascio } from '@opengraphity/types'
import { parseDeploySteps } from './deployWindows.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'change-deploy-conflicts' })

/**
 * Il tetto dei piani candidati da aprire. La query è indicizzata
 * (`window_start`), quindi ci arrivano solo i piani che toccano il mio
 * intervallo: il tetto è una rete di sicurezza, non un filtro.
 *
 * Si INTERPOLA nella query: un numero JS arriva a Neo4j come float e `LIMIT`
 * vuole un intero — la lezione del 17 set, che aveva spento l'intera
 * diagnostica di configurazione.
 */
export const MAX_PIANI_CANDIDATI = 500

/** Le categorie di passo che dicono «questa change non succede più». */
export const CATEGORIE_CONCLUSE: readonly string[] = ['closed', 'resolved', 'failed', 'cancelled']

export interface ConflittoDiRilascio {
  /** La change che confligge. */
  changeId: string
  code:     string
  title:    string
  currentStep: string | null
  /** Il CI su cui le due change si incontrano. */
  ciId:   string
  ciName: string
  /** La MIA finestra di rilascio su quel CI, e la sua. */
  mine:   FinestraDiRilascio
  theirs: FinestraDiRilascio
  /** La parte in comune: è la mezz'ora (o il giorno) in cui si pestano i piedi. */
  overlap: FinestraDiRilascio
}

interface RigaPiano {
  changeId:    string
  code:        string
  title:       string
  currentStep: string | null
  categoria:   string | null
  ciId:        string
  ciName:      string
  steps:       unknown
}

/** Le finestre di RILASCIO di un piano, per CI. Le validazioni non entrano. */
function rilasciDi(steps: unknown, dove: string): FinestraDiRilascio[] {
  try {
    return parseDeploySteps(steps)
      .map((s) => s.releaseWindow)
      .filter((w): w is FinestraDiRilascio => finestraValida(w))
  } catch (err) {
    /*
     * Un piano illeggibile NON diventa «nessun conflitto»: quello sarebbe il
     * silenzio nel posto peggiore — una change che rilascia sul mio CI e non
     * me lo dice. Si annota, e chi legge i log trova quale piano guardare.
     */
    log.warn({ dove, err }, 'piano di rilascio illeggibile: escluso dal confronto dei conflitti')
    return []
  }
}

/**
 * I conflitti di rilascio della change, ordinati per inizio della
 * sovrapposizione: il primo della lista è quello che arriva prima.
 */
export async function deployConflictsForChange(
  session: Session, tenantId: string, changeId: string,
): Promise<ConflittoDiRilascio[]> {
  // I MIEI piani. `tenant-ok`: il filtro di tenant è sulla change e sul piano.
  const miei = await runQuery<{ ciId: string; steps: unknown }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {tenant_id: $tenantId})
    WHERE dp.ci_id IS NOT NULL AND coalesce(dp.steps, '[]') <> '[]'
    RETURN dp.ci_id AS ciId, dp.steps AS steps
  `, { changeId, tenantId })

  /** ciId → le mie finestre di rilascio su quel CI. */
  const mieFinestre = new Map<string, FinestraDiRilascio[]>()
  for (const p of miei) {
    const f = rilasciDi(p.steps, `change ${changeId}, CI ${p.ciId}`)
    if (f.length > 0) mieFinestre.set(p.ciId, [...(mieFinestre.get(p.ciId) ?? []), ...f])
  }
  // Nessun rilascio pianificato: non c'è niente con cui confliggere, e non si
  // interroga il database una seconda volta.
  if (mieFinestre.size === 0) return []

  const tutte = [...mieFinestre.values()].flat()
  const inizio = tutte.reduce((min, f) => (f.start < min ? f.start : min), tutte[0]!.start)
  const fine   = tutte.reduce((max, f) => (f.end   > max ? f.end   : max), tutte[0]!.end)

  /*
   * I CANDIDATI, scartati nel DATABASE su tre condizioni indicizzate o a
   * buon mercato: un altro `ci_id` fra i miei, un inviluppo che tocca il mio
   * intervallo, e non cancellata. Solo i sopravvissuti aprono il JSON.
   */
  const candidati = await runQuery<RigaPiano>(session, `
    MATCH (o:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {tenant_id: $tenantId})
    WHERE o.id <> $changeId
      AND coalesce(o.deleted, false) = false
      AND dp.ci_id IN $ciIds
      AND coalesce(dp.steps, '[]') <> '[]'
      AND dp.window_start IS NOT NULL AND dp.window_end IS NOT NULL
      AND dp.window_start <= $fine AND dp.window_end >= $inizio
    MATCH (ci:ConfigurationItem {id: dp.ci_id, tenant_id: $tenantId})
    OPTIONAL MATCH (o)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})-[:CURRENT_STEP]->(st:WorkflowStep)
    RETURN o.id AS changeId, o.code AS code, o.title AS title,
           st.name AS currentStep, st.category AS categoria,
           dp.ci_id AS ciId, ci.name AS ciName, dp.steps AS steps
    ORDER BY o.code
    LIMIT ${MAX_PIANI_CANDIDATI}
  `, { changeId, tenantId, ciIds: [...mieFinestre.keys()], inizio, fine })

  const out: ConflittoDiRilascio[] = []
  for (const r of candidati) {
    if (r.categoria !== null && CATEGORIE_CONCLUSE.includes(r.categoria)) continue
    const mieSulCI = mieFinestre.get(r.ciId) ?? []
    for (const loro of rilasciDi(r.steps, `change ${r.code}, CI ${r.ciId}`)) {
      for (const mia of mieSulCI) {
        const comune = sovrapposizione(mia, loro)
        if (!comune || !finestreSiSovrappongono(mia, loro)) continue
        out.push({
          changeId: r.changeId, code: r.code, title: r.title, currentStep: r.currentStep,
          ciId: r.ciId, ciName: r.ciName, mine: mia, theirs: loro, overlap: comune,
        })
      }
    }
  }

  // Per inizio della sovrapposizione: chi legge vuole sapere cosa arriva
  // prima, non chi ha il codice più basso.
  return out.sort((a, b) => (a.overlap.start < b.overlap.start ? -1 : a.overlap.start > b.overlap.start ? 1 : a.code.localeCompare(b.code)))
}
