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
  return puoPrendereAtto(row) && GENERI_DA_PROBLEM.has(row.kind)
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
export function titoloDelProblem(params: Record<string, string> | undefined): string {
  const p = params ?? {}
  const pezzi = [p['service'], p['module']].filter((x) => x != null && x !== '').join(' · ')
  const testa = p['template'] ?? p['step'] ?? ''
  const titolo = [testa, pezzi].filter((x) => x !== '').join(' — ')
  return (titolo === '' ? 'Recurring fault reported by the platform analyst' : titolo).slice(0, 500)
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
    'Opened from an improvement proposal. The analysis above was written by a model and agreed by a person.',
  ]
  return righe.join('\n').trim().slice(0, MAX_DESCRIZIONE)
}
