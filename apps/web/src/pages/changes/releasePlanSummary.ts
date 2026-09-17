/**
 * IL PIANO COMPLESSIVO DI UNA CHANGE, in ordine di data (decisione del
 * proprietario, 17 set 2026).
 *
 * Fino a qui le finestre si potevano leggere solo aprendo un CI per volta
 * (`PlanModal`): chi approva non aveva modo di vedere in un colpo cosa succede
 * quella notte e in che ordine. Il dato c'era già tutto —
 * `GET_CHANGE_AFFECTED_CIS` porta, per ogni CI impattato, il suo `deployPlan`
 * coi passi e le due finestre — ma nessuno lo metteva in fila.
 *
 * ## Una riga per FINESTRA, non per passo e non per CI
 * Il piano complessivo è una sequenza temporale: ogni finestra è una voce, col
 * suo TIPO (validazione o rilascio), il TASK che la porta e il CI a cui si
 * riferisce. Un passo del piano produce quindi DUE voci, che stanno in due
 * punti diversi della cronologia — ed è giusto così: la validazione di un CI
 * può cadere fra i rilasci di altri due, e un elenco raggruppato per CI lo
 * nasconderebbe.
 *
 * L'elenco si popola TASK PER TASK: ogni piano che viene compilato aggiunge le
 * sue voci al posto giusto nella cronologia, senza aspettare gli altri.
 *
 * ## Il task è l'indirizzo, il CI è il contesto
 * Nel grafo l'unica relazione è `(Change)-[:HAS_DEPLOY_PLAN]->(DeployPlanTask)`,
 * e il CI è un riferimento per proprietà (`ci_id`): l'identità del task è la
 * COPPIA change+CI (`change_key`). Per questo ogni voce porta il codice
 * `TASK…`: chi approva deve poter dire «manca TASK00000051», non «manca il
 * piano di quel CI».
 *
 * ## Tollerante nel mostrare, severa nel mettere in fila
 * `saveDeployPlan` pretende inizio e fine con offset esplicito, quindi le
 * finestre scritte dal prodotto sono buone. Ma un piano importato o scritto
 * via API prima di quella regola può portare date vuote o illeggibili: quelle
 * non si possono ordinare, quindi NON entrano nella cronologia (né
 * nell'inviluppo, dove un `Date.parse` fallito darebbe un `NaN` silenzioso) e
 * si contano a parte, per dirlo. È la regola di sempre: niente fallback
 * silenziosi.
 */
import type { AffectedCI, DeployStep, TimeWindow } from '@/types/change'
import { TASK_STATUS } from '@/lib/taskStatus'

/** Il tipo di finestra. Sono le due che ogni passo del piano porta con sé. */
export type TipoFinestra = 'validation' | 'release'

/** Una voce della cronologia: una finestra, col suo tipo, il suo task e il suo CI. */
export interface VoceDiPiano {
  tipo:      TipoFinestra
  start:     string
  end:       string
  /** Millisecondi dell'inizio: è la chiave dell'ordinamento. */
  inizio:    number
  fine:      number
  stepTitle: string
  taskCode:  string | null
  ciId:      string
  ciName:    string
}

/** Un piano che non si può mettere in fila: nessun passo, o finestre illeggibili. */
export interface PianoSenzaDate {
  ciId:     string
  ciName:   string
  taskCode: string | null
  stato:    string | null
  teamName: string | null
  /** Vero se di passi non ce n'è nemmeno uno; falso se ci sono passi ma con date inservibili. */
  vuoto:    boolean
}

export interface RiepilogoRilascio {
  /** Le voci in ordine di data: è il piano complessivo. */
  voci:             readonly VoceDiPiano[]
  /** I piani che non hanno una data da mettere in fila, elencati per essere reclamati. */
  senzaDate:        readonly PianoSenzaDate[]
  /** L'estremo sinistro e destro delle finestre di RILASCIO: «cosa va in produzione, da quando a quando». */
  inviluppo:        { start: string; end: string } | null
  /**
   * Quanti blocchi di rilascio restano dopo aver fuso le finestre che si
   * toccano. Serve a non far leggere «dal 21 al 25» come un fermo di quattro
   * giorni: se è più di 1, il rilascio è a spezzoni.
   */
  finestreDistinte: number
  /** L'avanzamento nell'unità che conta: i task. Su tutti i CI impattati. */
  taskChiusi:       number
  taskTotali:       number
  /** Quanti piani hanno almeno un passo scritto, e quanti sono chiusi: due cose diverse. */
  pianiCompilati:   number
  pianiCompletati:  number
  pianiTotali:      number
}

/** Millisecondi di una data di finestra, oppure null se vuota o illeggibile. */
function istante(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** Una finestra ordinabile: entrambi gli estremi leggibili e in ordine. */
function ordinabile(w: TimeWindow | null | undefined): { da: number; a: number } | null {
  const da = istante(w?.start)
  const a  = istante(w?.end)
  if (da == null || a == null || a < da) return null
  return { da, a }
}

/**
 * Fonde le finestre che si toccano e conta i blocchi che restano. Due finestre
 * adiacenti (una finisce quando l'altra comincia) sono UN blocco: per chi
 * approva è un fermo continuo, e spezzarlo in due sarebbe una falsa allerta.
 */
export function contaFinestreDistinte(finestre: readonly { da: number; a: number }[]): number {
  if (finestre.length === 0) return 0
  const ordinate = [...finestre].sort((x, y) => x.da - y.da)
  let blocchi = 1
  let fine = ordinate[0]!.a
  for (const f of ordinate.slice(1)) {
    if (f.da > fine) blocchi += 1
    fine = Math.max(fine, f.a)
  }
  return blocchi
}

/** I tre task che l'avanzamento conta: assessment funzionale, tecnico, piano. */
function statiDeiTask(a: AffectedCI): Array<string | null> {
  return [
    a.assessmentOwner?.status   ?? null,
    a.assessmentSupport?.status ?? null,
    a.deployPlan?.status        ?? null,
  ]
}

/** Le due voci di un passo, tenendo solo quelle con una finestra ordinabile. */
function vociDelPasso(step: DeployStep, a: AffectedCI): VoceDiPiano[] {
  const base = { stepTitle: step.title, taskCode: a.deployPlan?.code ?? null, ciId: a.ci.id, ciName: a.ci.name }
  const coppie: Array<[TipoFinestra, TimeWindow | null | undefined]> = [
    ['validation', step.validationWindow],
    ['release',    step.releaseWindow],
  ]
  return coppie.flatMap(([tipo, w]) => {
    const o = ordinabile(w)
    if (!o || !w) return []
    return [{ ...base, tipo, start: w.start, end: w.end, inizio: o.da, fine: o.a }]
  })
}

export function riepilogoRilascio(affected: readonly AffectedCI[]): RiepilogoRilascio {
  const voci = affected.flatMap((a) => (a.deployPlan?.steps ?? []).flatMap((s) => vociDelPasso(s, a)))

  /*
   * A pari inizio la validazione viene prima del rilascio: è l'ordine del
   * processo, e due voci con la stessa ora messe a caso farebbero leggere un
   * rilascio prima della sua verifica. A parità di tutto, il nome del CI, così
   * l'elenco non cambia ordine fra due aperture della pagina.
   */
  const peso = (t: TipoFinestra) => (t === 'validation' ? 0 : 1)
  const ordinate = [...voci].sort((x, y) =>
    x.inizio - y.inizio || peso(x.tipo) - peso(y.tipo) || x.ciName.localeCompare(y.ciName))

  const senzaDate: PianoSenzaDate[] = affected
    .map((a) => {
      const steps = a.deployPlan?.steps ?? []
      const conDate = steps.some((s) => ordinabile(s.validationWindow) || ordinabile(s.releaseWindow))
      if (conDate) return null
      return {
        ciId:     a.ci.id,
        ciName:   a.ci.name,
        taskCode: a.deployPlan?.code ?? null,
        stato:    a.deployPlan?.status ?? null,
        // Senza assegnazione, il gruppo di supporto del CI: è chi quel piano lo compilerà.
        teamName: a.deployPlan?.assignedTeam?.name ?? a.ci.supportGroup?.name ?? null,
        vuoto:    steps.length === 0,
      }
    })
    .filter((x): x is PianoSenzaDate => x !== null)
    .sort((x, y) => x.ciName.localeCompare(y.ciName))

  const rilasci = ordinate.filter((v) => v.tipo === 'release').map((v) => ({ da: v.inizio, a: v.fine }))
  const inviluppo = rilasci.length === 0 ? null : {
    start: new Date(Math.min(...rilasci.map((f) => f.da))).toISOString(),
    end:   new Date(Math.max(...rilasci.map((f) => f.a))).toISOString(),
  }

  const tuttiGliStati = affected.flatMap(statiDeiTask)

  return {
    voci:             ordinate,
    senzaDate,
    inviluppo,
    finestreDistinte: contaFinestreDistinte(rilasci),
    taskChiusi:       tuttiGliStati.filter((s) => s === TASK_STATUS.COMPLETED).length,
    taskTotali:       tuttiGliStati.length,
    pianiCompilati:   affected.filter((a) => (a.deployPlan?.steps ?? []).length > 0).length,
    pianiCompletati:  affected.filter((a) => a.deployPlan?.status === TASK_STATUS.COMPLETED).length,
    pianiTotali:      affected.length,
  }
}
