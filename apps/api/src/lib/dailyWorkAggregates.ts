/**
 * GLI AGGREGATI DEL LAVORO QUOTIDIANO (20 set 2026).
 *
 * Programma «Miglioramento continuo», ondata 2 — senza AI, di proposito.
 * Sono le misure su cui un analista si fonderà; se sono sbagliate, sono
 * sbagliate le proposte. Perciò si costruiscono prima, si guardano con gli
 * occhi, e solo dopo si lascia che un modello le legga.
 *
 * ## Tre cose che la revisione ha imposto, e che qui si vedono
 *
 * **1. La COPERTURA prima di tutto.** Il progetto diceva «il carburante c'è
 * già». Misurato: su `c-one` ci sono 1.519 incident e 93 voci
 * `incident.created` — il 94% del parco è entrato per import, senza passare
 * dalle mutation. Un aggregato che non dichiara quanto vede mente per
 * omissione, quindi `copertura()` è la prima funzione del file e il primo
 * numero della pagina.
 *
 * **2. Mediana e p90, MAI la media.** Su `c-one`, il passo `assigned` ha una
 * media di 5,57 ore contro una mediana di 1,14: la media è tirata da un
 * singolo caso da 55 giorni. Chi leggesse la media crederebbe a un problema
 * che riguarda tre ticket su 1.185.
 *
 * **3. Gli zeri finti si buttano.** `ticketImportService` chiude i passi
 * aperti con `duration_ms = 0`. Uno zero così è indistinguibile da una misura
 * vera, e abbassa ogni statistica: si escludono, e si dice quanti erano.
 *
 * ## E una che riguarda questo programma
 * Gli aggregati **escludono sé stessi**: le azioni sulle proposte e l'attore
 * che le ha fatte. Senza, accettare una proposta è una mutation, finisce nel
 * registro, l'analista la legge, trova «una sequenza ripetuta di
 * `proposal.accepted`» e propone di automatizzarla. L'anello si chiude e si
 * presenta come una proposta sensata.
 */
import { getSession } from '@opengraphity/neo4j'
import { runQuery, runQueryOne } from '../graphql/resolvers/ci-utils.js'
import { humanActorClause, SYNTHETIC_ACTORS_PARAM, syntheticActorIds } from './auditActors.js'
import { actionKey, isGenericMutationAction } from './auditActionMap.js'

/**
 * LE SOGLIE, scritte come regola del motore e non lasciate al buon senso.
 *
 * Senza, la prima notte la pagina si riempie di proposte fondate su tre
 * righe: la voce di catalogo più usata dell'intero sistema ne ha 16 (c-test,
 * 20 set 2026), e «la voce che nessuno usa da sei mesi» su c-one sarebbe vera
 * per 5 voci su 6 — vera per costruzione e priva di significato.
 */
export const SOGLIE = {
  /** Finestra minima perché una misura nel tempo voglia dire qualcosa. */
  finestraMinimaGiorni: 14,
  /** Occorrenze minime perché un fenomeno sia un fenomeno. */
  occorrenzeMinime: 30,
  /** Un passo con meno esecuzioni di così non ha una mediana credibile. */
  esecuzioniMinimePerPasso: 30,
  /** Una coppia di azioni conta solo se si ripete, su oggetti diversi, per mano di più persone. */
  coppia: { occorrenze: 10, oggettiDistinti: 3, autoriDistinti: 2, minutiMassimi: 15 },
} as const

/** Le azioni di questo stesso programma: guardarle sarebbe guardarsi allo specchio. */
const AZIONI_DEL_PROGRAMMA_PARAM = '__azioniDelProgramma'
const AZIONI_DEL_PROGRAMMA = [
  'proposal.accepted', 'proposal.rejected', 'proposal.postponed',
  'proposal.undone', 'proposal.execution_failed', 'proposal.analysis_run',
  'anomaly.resolved', 'anomaly.scan_triggered',
]

function parametriComuni(tenantId: string, daISO: string) {
  return {
    tenantId,
    da: daISO,
    [SYNTHETIC_ACTORS_PARAM]: syntheticActorIds(),
    [AZIONI_DEL_PROGRAMMA_PARAM]: AZIONI_DEL_PROGRAMMA,
  }
}

const NON_DEL_PROGRAMMA = `NOT a.action IN $${AZIONI_DEL_PROGRAMMA_PARAM}`

function daQuando(giorni: number): string {
  return new Date(Date.now() - giorni * 86_400_000).toISOString()
}

// ── 1 · La copertura ─────────────────────────────────────────────────────────

export interface Copertura {
  /** Quanti ticket esistono. */
  ticket: number
  /** Di quanti il registro ha la voce di creazione. */
  conVoceDiCreazione: number
  /** Voci del registro nella finestra. */
  vociTotali: number
  /** Di quelle, quante sono di una persona. */
  vociUmane: number
  /** Di quelle umane, quante sono voci generiche `mutation.*` (di seconda qualità). */
  vociGeneriche: number
  /** Azioni che la normalizzazione non ha saputo leggere: si contano, non si nascondono. */
  azioniNonLette: number
  finestraGiorni: number
}

/**
 * Quanto vedono gli aggregati.
 *
 * È il primo numero da guardare: se la copertura è bassa, ogni altra misura di
 * questo file parla di una minoranza dei fatti, e va detto prima che qualcuno
 * ci fondi una decisione.
 */
export async function copertura(tenantId: string, finestraGiorni = 30): Promise<Copertura> {
  const session = getSession(undefined, 'READ')
  try {
    const da = daQuando(finestraGiorni)
    const params = parametriComuni(tenantId, da)

    const ticket = await runQueryOne<{ n: number; creati: number }>(session, `
      MATCH (t) WHERE (t:Incident OR t:Problem OR t:Change OR t:ServiceRequest)
        AND t.tenant_id = $tenantId AND coalesce(t.deleted, false) = false
      WITH count(t) AS n
      OPTIONAL MATCH (a:AuditEntry {tenant_id: $tenantId})
        WHERE a.action IN ['incident.created', 'change_created', 'problem.created', 'request.created']
      RETURN n, count(a) AS creati
    `, params)

    const voci = await runQuery<{ action: string; userId: string | null; n: number }>(session, `
      MATCH (a:AuditEntry {tenant_id: $tenantId})
      WHERE a.created_at >= $da
      RETURN a.action AS action, a.user_id AS userId, count(*) AS n
    `, params)

    let vociTotali = 0, vociUmane = 0, vociGeneriche = 0, azioniNonLette = 0
    for (const r of voci) {
      const n = Number(r.n)
      vociTotali += n
      const umana = !syntheticActorIds().includes(String(r.userId ?? '')) && String(r.userId ?? '').trim() !== ''
      if (umana) {
        vociUmane += n
        if (isGenericMutationAction(r.action)) vociGeneriche += n
        if (actionKey(r.action) === null) azioniNonLette += n
      }
    }

    return {
      ticket: Number(ticket?.n ?? 0),
      conVoceDiCreazione: Number(ticket?.creati ?? 0),
      vociTotali, vociUmane, vociGeneriche, azioniNonLette,
      finestraGiorni,
    }
  } finally {
    await session.close()
  }
}

// ── 2 · Le azioni umane, per finestra, autore e oggetto ──────────────────────

export interface AzioniPerOggetto {
  object: string
  verb:   string
  n:      number
  autoriDistinti: number
  oggettiDistinti: number
}

export async function azioniUmane(
  tenantId: string,
  finestraGiorni = 30,
): Promise<AzioniPerOggetto[]> {
  const session = getSession(undefined, 'READ')
  try {
    const righe = await runQuery<{ action: string; n: number; autori: number; oggetti: number }>(session, `
      MATCH (a:AuditEntry {tenant_id: $tenantId})
      WHERE a.created_at >= $da AND ${humanActorClause('a')} AND ${NON_DEL_PROGRAMMA}
      RETURN a.action AS action, count(*) AS n,
             count(DISTINCT a.user_id) AS autori,
             count(DISTINCT a.entity_id) AS oggetti
      ORDER BY n DESC
    `, parametriComuni(tenantId, daQuando(finestraGiorni)))

    /*
     * La normalizzazione si applica DOPO il conteggio, così due nomi diversi
     * della stessa operazione (`change_created` e `change.created`) si
     * sommano invece di comparire come due righe.
     */
    const per = new Map<string, AzioniPerOggetto>()
    for (const r of righe) {
      const k = actionKey(r.action)
      if (k === null) continue
      const [object = '', verb = ''] = [k.slice(0, k.lastIndexOf('.')), k.slice(k.lastIndexOf('.') + 1)]
      const gia = per.get(k)
      if (gia) {
        gia.n += Number(r.n)
        gia.autoriDistinti = Math.max(gia.autoriDistinti, Number(r.autori))
        gia.oggettiDistinti = Math.max(gia.oggettiDistinti, Number(r.oggetti))
      } else {
        per.set(k, {
          object, verb, n: Number(r.n),
          autoriDistinti: Number(r.autori), oggettiDistinti: Number(r.oggetti),
        })
      }
    }
    return [...per.values()].sort((a, b) => b.n - a.n)
  } finally {
    await session.close()
  }
}

// ── 3 · Quanto stanno fermi i ticket, per passo ──────────────────────────────

export interface TempoNelPasso {
  stepName: string
  n:        number
  medianaOre: number
  p90Ore:     number
  oltre48h:   number
  /** Quante esecuzioni sono state scartate perché portavano uno zero finto. */
  zeriScartati: number
}

/**
 * Il tempo di attraversamento dei passi.
 *
 * Mediana e p90, mai la media (vedi l'intestazione). Gli zeri si scartano e si
 * contano: sono le chiusure d'ufficio dell'import, non misure.
 */
export async function tempiNeiPassi(
  tenantId: string,
  finestraGiorni = 30,
): Promise<TempoNelPasso[]> {
  const session = getSession(undefined, 'READ')
  try {
    /*
     * `percentileCont` è una funzione di AGGREGAZIONE: lavora sulle righe, non
     * su una lista. La prima versione di questa query raccoglieva le durate con
     * `collect()` e gliele passava — «Type mismatch: expected Float but was
     * List<Float>» — e non l'ha vista nessun guardiano, perché
     * `scripts/check-cypher.mjs` salta le query composte e questa gli è
     * sfuggita. L'ha trovata l'averla eseguita sul grafo vero.
     */
    const righe = await runQuery<{
      step: string; n: number; mediana: number; p90: number; oltre: number; zeri: number
    }>(session, `
      // From the index on (tenant, exit), D67: walking every instance read a million executions.
      MATCH (w:WorkflowStepExecution {tenant_id: $tenantId})
      WHERE w.exited_at >= $da AND w.duration_ms IS NOT NULL
      WITH w.step_name AS step,
           CASE WHEN w.duration_ms > 0 THEN w.duration_ms / 3600000.0 ELSE null END AS ore,
           CASE WHEN w.duration_ms = 0 THEN 1 ELSE 0 END AS zero
      WITH step,
           count(ore) AS n,
           percentileCont(ore, 0.5) AS mediana,
           percentileCont(ore, 0.9) AS p90,
           sum(CASE WHEN ore > 48 THEN 1 ELSE 0 END) AS oltre,
           sum(zero) AS zeri
      WHERE n > 0
      RETURN step, n, mediana, p90, oltre, zeri
      ORDER BY mediana DESC
    `, parametriComuni(tenantId, daQuando(finestraGiorni)))

    return righe.map((r) => ({
      stepName: String(r.step),
      n: Number(r.n),
      medianaOre: Math.round(Number(r.mediana) * 100) / 100,
      p90Ore: Math.round(Number(r.p90) * 100) / 100,
      oltre48h: Number(r.oltre),
      zeriScartati: Number(r.zeri),
    }))
  } finally {
    await session.close()
  }
}

// ── 4 · Le coppie di azioni che si ripetono ──────────────────────────────────

export interface CoppiaRipetuta {
  prima:  string
  poi:    string
  n:      number
  oggettiDistinti: number
  autoriDistinti:  number
}

/**
 * Due azioni di fila, sullo stesso oggetto e per mano della stessa persona.
 *
 * ## Perché SOLO coppie
 * Le sequenze ricorrenti sono un problema di sequence mining, e in un'ondata
 * ci sta una definizione stretta: bigrammi, stessa entità, stesso autore,
 * entro quindici minuti. Niente trigrammi, niente raggruppamenti. Una
 * definizione che si può leggere e contestare vale più di un algoritmo che
 * nessuno sa spiegare.
 *
 * ## Perché tre soglie e non una
 * `n` da solo non basta: dieci occorrenze su un solo ticket sono una persona
 * che ha corretto un errore, non un'abitudine; dieci per mano di una persona
 * sola sono il suo modo di lavorare, non quello della squadra. Servono tutte
 * e tre.
 */
export async function coppieRipetute(
  tenantId: string,
  finestraGiorni = 30,
): Promise<CoppiaRipetuta[]> {
  const session = getSession(undefined, 'READ')
  try {
    const righe = await runQuery<{
      prima: string; poi: string; n: number; oggetti: number; autori: number
    }>(session, `
      MATCH (a:AuditEntry {tenant_id: $tenantId})
      WHERE a.created_at >= $da AND ${humanActorClause('a')} AND ${NON_DEL_PROGRAMMA}
        AND a.entity_id IS NOT NULL AND a.entity_id <> ''
      // The entries of one person on one object, in time order, and every pair
      // within the window (D67, tour of 23 Sep 2026): the self-join looked up
      // the index once per entry, 2.4 s on the demo tenant; grouping first
      // gives the same pairs in 0.4 s.
      WITH a.entity_id AS entity, a.user_id AS user, a ORDER BY a.created_at
      WITH entity, user, collect({action: a.action, at: a.created_at}) AS seq
      WHERE size(seq) > 1
      UNWIND range(0, size(seq) - 2) AS i
      UNWIND range(i + 1, size(seq) - 1) AS j
      WITH entity, user, seq[i] AS first, seq[j] AS then
      WHERE then.at > first.at
        AND duration.inSeconds(datetime(first.at), datetime(then.at)).seconds <= $finestraSecondi
      RETURN first.action AS prima, then.action AS poi, count(*) AS n,
             count(DISTINCT entity) AS oggetti,
             count(DISTINCT user) AS autori
      ORDER BY n DESC
      LIMIT 200
    `, {
      ...parametriComuni(tenantId, daQuando(finestraGiorni)),
      finestraSecondi: SOGLIE.coppia.minutiMassimi * 60,
    })

    const per = new Map<string, CoppiaRipetuta>()
    for (const r of righe) {
      const kPrima = actionKey(r.prima)
      const kPoi   = actionKey(r.poi)
      if (kPrima === null || kPoi === null) continue
      // Una coppia con sé stessa è una correzione, non una sequenza.
      if (kPrima === kPoi) continue
      const chiave = `${kPrima}→${kPoi}`
      const gia = per.get(chiave)
      if (gia) {
        gia.n += Number(r.n)
        gia.oggettiDistinti = Math.max(gia.oggettiDistinti, Number(r.oggetti))
        gia.autoriDistinti  = Math.max(gia.autoriDistinti, Number(r.autori))
      } else {
        per.set(chiave, {
          prima: kPrima, poi: kPoi, n: Number(r.n),
          oggettiDistinti: Number(r.oggetti), autoriDistinti: Number(r.autori),
        })
      }
    }

    return [...per.values()]
      .filter((c) =>
        c.n >= SOGLIE.coppia.occorrenze
        && c.oggettiDistinti >= SOGLIE.coppia.oggettiDistinti
        && c.autoriDistinti >= SOGLIE.coppia.autoriDistinti)
      .sort((a, b) => b.n - a.n)
  } finally {
    await session.close()
  }
}

// ── 5 · Chi usa le funzioni AI che il prodotto ha già ────────────────────────

export interface AdozioneAI {
  feature: string
  n:       number
  autoriDistinti: number
}

/**
 * Le AZIONI AI che il registro ha visto, per cliente.
 *
 * ## Attenzione: NON è l'adozione delle funzioni AI, e il perché conta
 * Scrivendo questo aggregato (ondata 2) avevo messo qui sopra: «la domanda
 * "il triage lo usa qualcuno?" ha già una risposta scritta da settimane, e
 * bastava leggerla». **Era falso**, e l'ho scoperto nell'ondata 6 provando a
 * costruirci sopra una proposta.
 *
 * `auditMutationsPlugin` registra le MUTATION e basta — esce subito su
 * qualunque altra operazione. Ma le funzioni AI accanto al ticket sono
 * QUERY: `triageSuggestion`, `suggestedArticles`, `resolutionDraft`,
 * `problemCandidates`. Il registro non le vede, e non le ha mai viste.
 *
 * Quindi uno zero qui dentro NON vuol dire «nessuno la usa»: vuol dire «il
 * registro non la vede». Sono due cose diverse, e confonderle porterebbe a
 * spegnere una funzione che qualcuno usa ogni giorno. Per questo l'ondata 6
 * NON ha costruito la proposta «funzione inutilizzata» che il progetto
 * prevedeva: la misura su cui sarebbe poggiata è cieca.
 *
 * Quello che si vede davvero: le AI invocate da una mutation — oggi la bozza
 * di articolo KB da un incident — e i cambi di configurazione AI. È poco, ed
 * è detto invece che gonfiato.
 */
/**
 * THE ENTRIES THAT ARE AN AI AT WORK, named one by one (tour of 23 Sep 2026).
 *
 * The filter was `action CONTAINS 'ai'`, and «ai» is inside «claimed»,
 * «email», «maintenance», «domain», «failed», «detail»: taking a task, a
 * maintenance window and a notification preference were counted as AI
 * actions, while the one this section was written for — the KB draft from an
 * incident — was not, because its entry is `kb_article.created`, the same as
 * an article written by hand. Now the draft writes its own entry, and the
 * list is explicit: a new AI mutation is added here, or it is not counted.
 */
export const AI_AUDIT_ACTIONS: readonly string[] = [
  /** The KB draft the model writes from an incident (`createKbDraftFromIncident`). */
  'kb_article.drafted_by_ai',
  /** The two designers that ask the model for a proposal (the mutation registry names them). */
  'mutation.proposeServiceRequestDesign',
  'mutation.proposeReportSection',
  /** «Analyse now» on the improvement proposals: the analysts with a model inside. */
  'proposal.analysis_run',
  /** Turning an AI feature on or off. */
  'tenant.ai_settings.updated',
]

export async function adozioneFunzioniAI(
  tenantId: string,
  finestraGiorni = 30,
): Promise<AdozioneAI[]> {
  const session = getSession(undefined, 'READ')
  try {
    const righe = await runQuery<{ action: string; n: number; autori: number }>(session, `
      MATCH (a:AuditEntry {tenant_id: $tenantId})
      WHERE a.created_at >= $da AND ${humanActorClause('a')}
        AND a.action IN $azioniAI
      RETURN a.action AS action, count(*) AS n, count(DISTINCT a.user_id) AS autori
      ORDER BY n DESC
    `, { ...parametriComuni(tenantId, daQuando(finestraGiorni)), azioniAI: [...AI_AUDIT_ACTIONS] })

    return righe.map((r) => ({
      feature: String(r.action),
      n: Number(r.n),
      autoriDistinti: Number(r.autori),
    }))
  } finally {
    await session.close()
  }
}
