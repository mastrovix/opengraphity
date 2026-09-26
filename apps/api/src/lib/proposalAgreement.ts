/**
 * ESSERE D'ACCORDO CON UNA PROPOSTA CHE NON HA NIENTE DA ESEGUIRE
 * (20 set 2026, segnalazione del proprietario: «come faccio ad accettare???»).
 *
 * ## Il buco, e che era mio
 * L'ondata 1 ha previsto `action: null` «quando la proposta è solo da
 * leggere», e `acceptProposal` alza `nothingToExecute` quando non c'è niente
 * da eseguire. Poi gli analisti delle ondate 4 e 5 hanno prodotto quasi solo
 * letture: SEI generi su otto nascono senza azione. Le due metà non le ho
 * mai collegate.
 *
 * Il risultato a schermo: un amministratore che legge «tre processi sbagliano
 * insieme, è una causa sola» ed è D'ACCORDO ha tre uscite — rifiutare (cioè
 * dire il falso, e piantare una lapide che blocca quell'impronta 30 giorni),
 * «non ora», o lasciarla scadere. L'unico esito che il prodotto non offriva
 * era quello giusto.
 *
 * ## I DUE gesti, e perché sono due (decisione del proprietario)
 *
 *  - **Preso atto** — «l'ho vista, è vera, non serve altro». La proposta esce
 *    dalla lista e resta nell'Audit Log. Nessun effetto sul resto del
 *    prodotto, ed è dichiarato: è il gesto per chi è d'accordo e basta.
 *  - **Apri un Problem** — «è vera e qualcuno ci deve lavorare». Nasce un
 *    Problem vero, con dentro il rationale e le prove, e da lì in poi lo
 *    segue il processo che il cliente ha già.
 *
 * Due gesti e non uno perché dicono due cose diverse, e fonderli avrebbe
 * costretto a scegliere fra aprire lavoro che nessuno farà e non avere modo
 * di essere d'accordo.
 *
 * ## `problem.open` NON entra nel catalogo delle azioni, e non è una svista
 * `PROPOSAL_ACTION_TYPES` è ciò che il MODELLO può proporre. Metterci dentro
 * l'apertura di un Problem vorrebbe dire che un analista, di notte, può
 * decidere da solo di aprire ticket in casa di un cliente — un passo molto
 * più grande di quello che il proprietario ha chiesto. Qui il Problem lo apre
 * una PERSONA che ha letto, su una proposta che esiste già: il catalogo resta
 * della stessa misura di ieri.
 */
import type { ProposalRow } from './proposals.js'

/**
 * I generi per cui «Apri un Problem» ha senso.
 *
 * Elencati e non dedotti dall'area, così aggiungerne uno è un gesto che si
 * vede — la stessa regola di `FUNZIONI_CON_TETTO` in `aiBudget.ts`.
 *
 * Ci sono i tre guasti di piattaforma e basta, e il motivo è che un Problem
 * in ITIL è la causa di uno o più incident: «tre processi sbagliano insieme
 * sul trasporto delle code» lo è. «Il passo *resolved* tiene i ticket fermi
 * 29 ore» NON lo è — non è rotto niente, è un processo da migliorare, e
 * l'oggetto giusto per quello in questo prodotto non esiste ancora. Aprirci
 * un Problem sopra vorrebbe dire sporcare la lista dei problem di cose che
 * problem non sono, e nessuno si fiderebbe più di quella lista.
 */
export const GENERI_DA_PROBLEM: ReadonlySet<string> = new Set([
  'proposal.platformRecurringError',
  'proposal.platformErrorSpike',
  'proposal.platformSharedFault',
  // A customer's report (26 Sep 2026): a person of the customer said it is a fault of OpenGrafo.
  'proposal.platformCustomerReport',
])

/**
 * THE REMEDIES THAT DID NOT HOLD (26 Sep 2026, area `operations`).
 *
 * Here a Problem IS the right object: the product tried its remedy, the
 * verification says it did not hold, and the same thing keeps breaking — a
 * cause to find, in the customer's own list of problems. A set of its own and
 * not `GENERI_DA_PROBLEM`: that one also says which Problems carry a dossier
 * to GitHub (`problemDossier.ts`), and a customer's running never leaves the
 * product.
 */
export const GENERI_OPERATIVI_DA_PROBLEM: ReadonlySet<string> = new Set([
  'proposal.operationsFailedJobsNotHeld',
  'proposal.operationsStuckAlarmsNotHeld',
  'proposal.operationsStaleServiceMapNotHeld',
  'proposal.operationsCIHealthOutOfStepNotHeld',
  'proposal.operationsStuckWorkflowsNotHeld',
])

/** Gli stati in cui una proposta è ancora da decidere. */
const DA_DECIDERE: ReadonlySet<string> = new Set(['open', 'not_now'])

/**
 * Si può dire «preso atto»?
 *
 * Solo dove `acceptProposal` NON può arrivare: una proposta che porta
 * un'azione si accetta eseguendola, e avere due bottoni che vogliono dire
 * quasi la stessa cosa sulla stessa riga confonde chi decide. Questo gesto
 * esiste per riempire il buco, non per raddoppiare quello che c'è.
 */
export function puoPrendereAtto(row: Pick<ProposalRow, 'status' | 'action'>): boolean {
  return DA_DECIDERE.has(row.status) && row.action == null
}

/** Si può aprire un Problem da qui? */
export function puoAprireUnProblem(row: Pick<ProposalRow, 'status' | 'action' | 'kind'>): boolean {
  return puoPrendereAtto(row) && (GENERI_DA_PROBLEM.has(row.kind) || GENERI_OPERATIVI_DA_PROBLEM.has(row.kind))
}

/** Quanto del rationale entra nella descrizione del Problem. */
export const MAX_DESCRIZIONE = 4_000

/**
 * Il titolo del Problem.
 *
 * NON è la frase della proposta: quella la compone il browser nella lingua di
 * chi guarda (`proposals.kind.*`), e qui siamo nel server, che non sa in che
 * lingua leggerà chi aprirà il Problem domani. Si usano i dati, che sono
 * gli stessi in ogni lingua.
 *
 * `template` è già il template SCRUBBATO (`serverLogScrub.ts`): nel titolo di
 * un Problem non entra un messaggio grezzo, come non entra nell'archivio.
 */
export function titoloDelProblem(params: Record<string, string> | undefined, kind?: string): string {
  const p = params ?? {}
  const operativo = kind ? TITOLI_OPERATIVI[kind]?.(p) : undefined
  if (operativo) return operativo.slice(0, 500)
  const pezzi = [p['service'], p['module']].filter((x) => x != null && x !== '').join(' · ')
  const testa = p['template'] ?? p['step'] ?? ''
  const titolo = [testa, pezzi].filter((x) => x !== '').join(' — ')
  return (titolo === '' ? 'Recurring fault reported by the platform analyst' : titolo).slice(0, 500)
}

/** The title of a Problem opened on a remedy that did not hold: from the data, like the others. */
const TITOLI_OPERATIVI: Readonly<Record<string, (p: Record<string, string>) => string>> = {
  'proposal.operationsFailedJobsNotHeld':        (p) => `Jobs keep failing in queue ${p['queue'] ?? '?'} after a retry`,
  'proposal.operationsStuckAlarmsNotHeld':       (p) => `Alarms stay stuck after a re-evaluation (${p['count'] ?? '?'})`,
  'proposal.operationsStaleServiceMapNotHeld':   (p) => `Service map "${p['map'] ?? '?'}" stays behind the CMDB after a synchronization`,
  'proposal.operationsCIHealthOutOfStepNotHeld': (p) => `CI health stays out of step with the alarms after a recompute (${p['count'] ?? '?'} CIs)`,
  'proposal.operationsStuckWorkflowsNotHeld':    (p) => `Tickets stay in a wait whose timer ran out (${p['count'] ?? '?'})`,
  // A customer's report (26 Sep 2026): who reported it, which of their problems, and the technical cause when there is one.
  'proposal.platformCustomerReport':             (p) => `Reported by ${p['tenant'] ?? '?'} (${p['problem'] ?? '?'})${p['cause'] ? `: ${p['cause']}` : ''}`,
}

/**
 * La descrizione: il rationale del modello, dichiarato come tale, più le
 * misure.
 *
 * Chi apre il Problem fra un mese deve sapere DA DOVE viene, e che la prosa
 * l'ha scritta un modello — la stessa regola della pagina delle proposte.
 */
export function descrizioneDelProblem(
  row: Pick<ProposalRow, 'rationale' | 'occurrences' | 'windowDays' | 'fingerprint'>,
): string {
  const righe = [
    row.rationale ?? '',
    '',
    `Occurrences: ${String(row.occurrences)} over ${String(row.windowDays)} day(s).`,
    `Proposal fingerprint: ${row.fingerprint}`,
    // No rationale, no model: the operational detectors read counters and the graph (26 Sep 2026).
    row.rationale
      ? 'Opened from an improvement proposal. The analysis above was written by a model and agreed by a person.'
      : 'Opened from an improvement proposal: a remedy of the product did not hold, and a person agreed to look for the cause.',
  ]
  return righe.join('\n').trim().slice(0, MAX_DESCRIZIONE)
}
