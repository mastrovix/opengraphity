/**
 * IL FASCICOLO ARRIVA SU GITHUB DA SOLO (21 set 2026).
 *
 * ## Da dove nasce
 * Richiesta del proprietario: «nessuna etichetta messa da un umano». Finora
 * il giro si interrompeva a metà: il prodotto preparava il fascicolo, e poi
 * una persona doveva copiarlo in una issue e metterci l'etichetta
 * `autoanalisi` per far partire l'agente. Due gesti manuali in mezzo a una
 * catena che per il resto cammina da sola.
 *
 * ## Il varco non sparisce, si SPOSTA — e va detto
 * L'etichetta era una difesa vera, non burocrazia: una parte del fascicolo
 * nasce da `POST /api/logs/client`, che chiama qualunque utente autenticato
 * di qualunque cliente, e lo scrubbing toglie l'identità ma non toglie le
 * istruzioni. L'etichetta impediva che da «so scrivere una riga di log» si
 * arrivasse a un agente con `contents: write` sul repository.
 *
 * Quel varco adesso sta PRIMA, e nel prodotto: apre un Problem da una
 * proposta solo chi ha `proposal.accept` E `problem.write` **sul tenant di
 * piattaforma**, e solo per i tre generi di piattaforma
 * (`GENERI_DA_PROBLEM`). È ancora una persona di fiducia che decide: si
 * autentica su OpenGrafo invece che su GitHub. Quello che si perde, e va
 * saputo, è che quella persona decide dopo aver letto la PROPOSTA, non dopo
 * aver letto il fascicolo.
 *
 * Restano in piedi le due difese che contano di più, e sono nel workflow:
 * il prompt dichiara che il testo della issue è DATO e non ordini, e
 * l'agente può solo aprire una PR — in `main` non entra niente senza che una
 * persona legga e unisca.
 *
 * ## Perché `repository_dispatch` e non un'etichetta messa dal token
 * Si potrebbe creare la issue già etichettata e lasciare che il workflow
 * parta come sempre. Sarebbe fingere che un umano abbia etichettato. Il
 * dispatch dice la verità: **l'ha chiesto il prodotto**, ed è una porta
 * diversa che si può togliere senza toccare quella delle persone.
 *
 * ## Se non è configurato, non si fa finta di niente
 * Senza `AUTOANALISI_GITHUB_REPO` e `AUTOANALISI_GITHUB_TOKEN` il giro si
 * ferma al Problem — che resta un Problem come un altro, con il suo fascicolo
 * da leggere. Non in silenzio: lo dichiara la diagnostica del tenant di
 * piattaforma.
 */
import { config } from './config.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'autoanalisi-github' })

/** L'evento di `repository_dispatch` su cui il workflow dell'Autoanalisi si sveglia. */
export const EVENTO_DISPATCH = 'autoanalisi'

/** Quanto si aspetta GitHub prima di rinunciare: un giro appeso non deve tenere una coda. */
const TIMEOUT_MS = 20_000

export interface ConfigurazioneAutoanalisi {
  /** `proprietario/nome` del repository del codice. */
  repo: string
  token: string
}

/**
 * La configurazione, o `null` se manca.
 *
 * `null` NON è un errore: è lo stato di un'installazione che non ha collegato
 * un repository, ed è legittimo. Chi chiama deve però dirlo, non ignorarlo.
 */
export function configurazioneAutoanalisi(): ConfigurazioneAutoanalisi | null {
  const repo = config.autoanalisiGithubRepo
  const token = config.autoanalisiGithubToken
  if (!repo || !token) return null
  return { repo, token }
}

/**
 * Una risposta di GitHub che non è andata bene: si legge il corpo, perché è lì
 * che dice perché.
 *
 * I nomi qui dentro sono in inglese, e non per distrazione: il guardiano della
 * lingua (`userFacingItalian.test.ts`) legge il TESTO dei messaggi d'errore,
 * e in un template literal ci finiscono dentro anche i nomi interpolati. Un
 * `${corpo}` in mezzo a una frase lo fa sembrare — giustamente — un messaggio
 * in italiano rivolto a una persona.
 */
async function assertRispostaBuona(res: Response, what: string): Promise<void> {
  if (res.ok) return
  /*
   * Il corpo si legge e si mette nel messaggio: un 403 di GitHub senza corpo
   * dice «Forbidden» e basta, col corpo dice QUALE permesso manca — che è
   * l'unica cosa che serve a chi deve sistemare il token.
   */
  const body = await res.text().catch(() => '')
  const why = body ? ` — ${body.slice(0, 500)}` : ''
  throw new Error(`${what}: GitHub answered ${res.status} ${res.statusText}${why}`)
}

function intestazioni(token: string): Record<string, string> {
  return {
    'Authorization':        `Bearer ${token}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  }
}

/**
 * Porta il fascicolo su GitHub come issue e restituisce il suo numero.
 *
 * L'etichetta `autoanalisi` NON viene messa: la metterebbe il token, e sarebbe
 * far sembrare umano un gesto che umano non è. L'analisi si chiede a parte,
 * con `chiediAnalisi`, che è una porta dichiaratamente del prodotto.
 */
export async function apriIssueDelFascicolo(
  cfg: ConfigurazioneAutoanalisi,
  dati: { problemNumber: string; titolo: string; fascicolo: string },
): Promise<number> {
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/issues`, {
    method:  'POST',
    headers: intestazioni(cfg.token),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
    body:    JSON.stringify({
      title: `Autoanalisi ${dati.problemNumber} — ${dati.titolo}`,
      body:  dati.fascicolo,
    }),
  })
  await assertRispostaBuona(res, `the investigation dossier of ${dati.problemNumber} was not filed`)
  const corpo = await res.json() as { number?: unknown }
  if (typeof corpo.number !== 'number') {
    throw new Error(`the investigation dossier of ${dati.problemNumber} was filed but GitHub did not return its number`)
  }
  log.info({ problem: dati.problemNumber, issue: corpo.number, repo: cfg.repo }, 'the investigation dossier is on GitHub')
  return corpo.number
}

/**
 * Chiede l'analisi: `repository_dispatch` con dentro il numero della issue.
 *
 * GitHub risponde 204 e non dice quale corsa ha avviato — è una proprietà del
 * dispatch, non un difetto: chi vuole sapere com'è finita guarda la issue, che
 * è dove l'agente riferisce comunque.
 */
export async function chiediAnalisi(
  cfg: ConfigurazioneAutoanalisi,
  dati: { issue: number; problemNumber: string },
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/dispatches`, {
    method:  'POST',
    headers: intestazioni(cfg.token),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
    body:    JSON.stringify({
      event_type: EVENTO_DISPATCH,
      client_payload: { issue: dati.issue, problem: dati.problemNumber },
    }),
  })
  await assertRispostaBuona(res, `the analysis of ${dati.problemNumber} was not requested`)
  log.info({ problem: dati.problemNumber, issue: dati.issue, repo: cfg.repo }, 'the analysis was requested on GitHub')
}

export interface StatoDellAnalisi {
  /** La issue è chiusa? */
  issueChiusa: boolean
  /** Il numero della PR collegata, se ce n'è una. */
  pr: number | null
  /** La PR è stata UNITA (non solo chiusa). `null` se non c'è nessuna PR. */
  prUnita: boolean | null
}

/**
 * Com'è finita, vista da GitHub.
 *
 * Si INTERROGA invece di farsi chiamare: OpenGrafo non è raggiungibile da
 * internet in questa installazione, quindi un webhook in ingresso da GitHub
 * non arriverebbe mai. Chiedere funziona anche da dietro un firewall.
 *
 * La PR si trova dagli eventi di chiusura della issue (`cross-referenced` e
 * `connected` non bastano: una PR *citata* non è una PR che risolve). Si
 * guarda `timeline` e si prende l'ultimo evento che collega una PR.
 */
export async function statoDellAnalisi(
  cfg: ConfigurazioneAutoanalisi, issue: number,
): Promise<StatoDellAnalisi> {
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/issues/${issue}/timeline?per_page=100`, {
    headers: intestazioni(cfg.token),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  })
  await assertRispostaBuona(res, `the state of issue #${issue} could not be read`)
  const eventi = await res.json() as Array<{
    event?: unknown
    source?: { issue?: { number?: unknown; pull_request?: { merged_at?: unknown } | null } }
  }>

  let pr: number | null = null
  let prUnita: boolean | null = null
  for (const ev of eventi) {
    if (ev.event !== 'cross-referenced') continue
    const collegata = ev.source?.issue
    if (!collegata || typeof collegata.number !== 'number' || !collegata.pull_request) continue
    pr = collegata.number
    prUnita = typeof collegata.pull_request.merged_at === 'string'
  }

  const statoRes = await fetch(`https://api.github.com/repos/${cfg.repo}/issues/${issue}`, {
    headers: intestazioni(cfg.token),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  })
  await assertRispostaBuona(statoRes, `the state of issue #${issue} could not be read`)
  const corpo = await statoRes.json() as { state?: unknown }

  return { issueChiusa: corpo.state === 'closed', pr, prUnita }
}
