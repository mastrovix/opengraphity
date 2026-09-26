/**
 * IL DEPOSITO DELLE PROPOSTE DI MIGLIORAMENTO (20 set 2026).
 *
 * Programma «Miglioramento continuo», ondata 1 — la spina.
 *
 * ## Il buco che riempie
 * Nel prodotto nessuna proposta dell'AI sopravvive al click: il progettista
 * dei moduli e quello dei report restituiscono un oggetto che il browser
 * tiene in memoria, i candidati Problem si ricalcolano a ogni apertura.
 * «Ogni mattina trovi le proposte» richiede invece che una proposta DURI:
 * nasca di notte, aspetti, venga letta, accettata o rifiutata, e ricordi di
 * esserlo stata.
 *
 * La regola che NON cambia è quella scritta accanto a
 * `proposeServiceRequestDesign`: «l'AI non ha una porta sua per scrivere».
 * Qui l'AI non scrive niente — scrive questo modulo, su richiesta di un
 * analista che è codice, e l'esecuzione la autorizza una persona.
 *
 * ## La lapide
 * Una proposta rifiutata non può tornare, ma non può nemmeno restare per
 * sempre: la purga a 12 mesi porterebbe via la memoria del rifiuto e il giro
 * successivo la riproporrebbe. Perciò il rifiuto lascia un nodo minuscolo,
 * `:ProposalRejection` — impronta, esito, fascia delle prove, data — che la
 * purga non tocca. Pesa pochi byte e vive quanto il tenant.
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import {
  PROPOSAL_OPEN_STATUSES, PROPOSAL_EXPIRY_DAYS, PROPOSAL_LIMIT_DEFAULTS, PROPOSAL_RETENTION_MONTHS,
  evidenceGrade, proposalMayReturn, isProposalVerification,
  type ProposalArea, type ProposalStatus, type ProposalEvidence,
  type ProposalRejectionKind, type ProposalVerification,
} from '@opengraphity/types'
import { runQuery, runQueryOne } from './db.js'
import { logger } from './logger.js'

/** Quello che un analista consegna. Il resto lo mette questo modulo. */
export interface ProposalToWrite {
  tenantId:    string
  area:        ProposalArea
  /** La chiave della frase: la compone il client nella lingua di chi guarda. */
  kind:        string
  /** Solo dati da interpolare nella chiave. Mai prosa. */
  params:      Record<string, string>
  /** Il soggetto stabile su cui si calcola l'impronta: mai id di ticket, mai conteggi. */
  scope:       string
  evidence:    ProposalEvidence
  /** Una voce del catalogo chiuso, o `null` per una proposta da leggere e basta. */
  action:      { type: string; params: Record<string, unknown> } | null
  /** Prosa del modello, solo per gli analisti AI. Con la lingua in cui è scritta. */
  rationale?:       string | null
  rationaleLanguage?: string | null
  /**
   * The CAUSE of an operational remedy, without the day of its episode (26 Sep
   * 2026): `queue:notifications`. The rule «never twice on the same cause
   * without a person» reads it; other areas leave it out.
   */
  cause?:           string | null
}

export interface ProposalRow {
  id:          string
  tenantId:    string
  area:        ProposalArea
  kind:        string
  params:      Record<string, string>
  fingerprint: string
  evidence:    ProposalEvidence
  evidenceGrade: number
  occurrences: number
  windowDays:  number
  action:      { type: string; params: Record<string, unknown> } | null
  rationale:   string | null
  rationaleLanguage: string | null
  status:      ProposalStatus
  createdAt:   string
  decidedAt:   string | null
  decidedBy:   string | null
  rejectedKind: ProposalRejectionKind | null
  rejectedNote: string | null
  notNowUntil:  string | null
  /** L'id della voce di Audit dell'azione eseguita: dalla proposta si arriva a cosa è successo. */
  auditEntryId: string | null
  executionError: string | null
  /**
   * Lo stato precedente salvato al momento dell'esecuzione: è da qui che si
   * disfa. Una chiusura in memoria non sopravvivrebbe al riavvio fra
   * l'accettazione e il ripensamento.
   */
  undoState: Record<string, unknown> | null
  /**
   * Il Problem aperto da questa proposta (20 set 2026).
   *
   * Non sta in `undoState`, che è «lo stato PRECEDENTE da cui si ripristina»:
   * un Problem aperto è il contrario, è quello che è nato dopo. Mescolarli
   * avrebbe fatto sembrare disfabile una cosa che non lo è — un Problem non
   * si «annulla», si chiude nel suo processo.
   */
  openedProblem: { id: string; number: string } | null
  /** True quando l'azione è stata disfatta: non si disfa due volte. */
  undone: boolean
  /** The cause of an operational remedy (see `ProposalToWrite.cause`). */
  cause: string | null
  /** What the executed action did, kept for its verification (operational remedies). */
  executionDetails: Record<string, unknown> | null
  /** Whether an operational remedy held, checked some minutes after it ran. */
  verification: ProposalVerification | null
  verifiedAt: string | null
  verificationDetail: Record<string, unknown> | null
}

/**
 * L'IMPRONTA.
 *
 * `area · kind · scope`, e `scope` è il SOGGETTO, mai le prove: la
 * definizione di workflow più il passo, la voce di catalogo più il campo. Se
 * ci entrassero i conteggi, ogni notte con un numero diverso sarebbe una
 * proposta nuova — che è esattamente il fallimento che il tetto di cinque
 * deve evitare.
 *
 * Non si usa una funzione di hash: leggibile è meglio, perché questa stringa
 * finisce in un messaggio di errore quando il vincolo di unicità scatta, e
 * chi lo legge deve capire di quale proposta si parla.
 */
export function fingerprintOf(area: string, kind: string, scope: string): string {
  return `${area}:${kind}:${scope}`
}

function leggiJson<T>(grezzo: unknown, dove: string): T | null {
  if (typeof grezzo !== 'string' || grezzo === '') return null
  try {
    return JSON.parse(grezzo) as T
  } catch {
    // Niente ripiego silenzioso: un JSON illeggibile nel grafo è un difetto
    // NOSTRO, e va visto — ma non deve far sparire la riga dalla pagina.
    logger.error({ module: 'proposals', dove }, 'proposals: JSON illeggibile nel grafo')
    return null
  }
}

function mappa(r: Record<string, unknown>): ProposalRow {
  const evidence = leggiJson<ProposalEvidence>(r['evidence'], 'evidence')
    ?? { n: 0, windowDays: 0, refs: [] }
  return {
    id:          String(r['id']),
    tenantId:    String(r['tenantId']),
    area:        String(r['area']) as ProposalArea,
    kind:        String(r['kind']),
    params:      leggiJson<Record<string, string>>(r['params'], 'params') ?? {},
    fingerprint: String(r['fingerprint']),
    evidence,
    evidenceGrade: Number(r['evidenceGrade'] ?? 0),
    occurrences:   Number(r['occurrences'] ?? 0),
    windowDays:    Number(r['windowDays'] ?? 0),
    action:      leggiJson<{ type: string; params: Record<string, unknown> }>(r['action'], 'action'),
    rationale:   r['rationale'] == null ? null : String(r['rationale']),
    rationaleLanguage: r['rationaleLanguage'] == null ? null : String(r['rationaleLanguage']),
    status:      String(r['status']) as ProposalStatus,
    createdAt:   String(r['createdAt']),
    decidedAt:   r['decidedAt'] == null ? null : String(r['decidedAt']),
    decidedBy:   r['decidedBy'] == null ? null : String(r['decidedBy']),
    rejectedKind: r['rejectedKind'] == null ? null : String(r['rejectedKind']) as ProposalRejectionKind,
    rejectedNote: r['rejectedNote'] == null ? null : String(r['rejectedNote']),
    notNowUntil:  r['notNowUntil'] == null ? null : String(r['notNowUntil']),
    auditEntryId: r['auditEntryId'] == null ? null : String(r['auditEntryId']),
    executionError: r['executionError'] == null ? null : String(r['executionError']),
    undoState: leggiJson<Record<string, unknown>>(r['undoState'], 'undoState'),
    openedProblem: leggiJson<{ id: string; number: string }>(r['openedProblem'], 'openedProblem'),
    undone: r['undone'] === true,
    cause: r['cause'] == null ? null : String(r['cause']),
    executionDetails: leggiJson<Record<string, unknown>>(r['executionDetails'], 'executionDetails'),
    verification: isProposalVerification(r['verification']) ? r['verification'] : null,
    verifiedAt: r['verifiedAt'] == null ? null : String(r['verifiedAt']),
    verificationDetail: leggiJson<Record<string, unknown>>(r['verificationDetail'], 'verificationDetail'),
  }
}

const CAMPI = `
  p.id AS id, p.tenant_id AS tenantId, p.area AS area, p.kind AS kind,
  p.params AS params, p.fingerprint AS fingerprint, p.evidence AS evidence,
  p.evidence_grade AS evidenceGrade, p.occurrences AS occurrences,
  p.window_days AS windowDays, p.action AS action,
  p.rationale AS rationale, p.rationale_language AS rationaleLanguage,
  p.status AS status, p.created_at AS createdAt,
  p.decided_at AS decidedAt, p.decided_by AS decidedBy,
  p.rejected_kind AS rejectedKind, p.rejected_note AS rejectedNote,
  p.not_now_until AS notNowUntil, p.audit_entry_id AS auditEntryId,
  p.execution_error AS executionError, p.undo_state AS undoState,
  coalesce(p.undone, false) AS undone, p.opened_problem AS openedProblem,
  p.cause AS cause, p.execution_details AS executionDetails,
  p.verification AS verification, p.verified_at AS verifiedAt,
  p.verification_detail AS verificationDetail
`

/** Perché una proposta non è stata scritta: si dice, non si tace. */
export type EsitoScrittura =
  | { scritta: true;  proposal: ProposalRow }
  | { scritta: false; motivo: 'gia_presente' | 'rifiutata_di_recente' | 'tetto_aperte' | 'tetto_giornaliero' }

/**
 * Scrive una proposta, se le regole lo consentono.
 *
 * Le quattro porte, in ordine: esiste già con quell'impronta (e allora non si
 * tocca: le prove nuove non devono resettare una decisione presa); è stata
 * rifiutata e non è passato abbastanza tempo o le prove non sono cambiate di
 * fascia; il cliente ha già il massimo di proposte aperte; ne sono già nate
 * troppe oggi.
 */
export async function scriviProposta(
  p: ProposalToWrite,
  limiti: { maxOpen: number; maxPerDay: number } = PROPOSAL_LIMIT_DEFAULTS,
  adesso: Date = new Date(),
): Promise<EsitoScrittura> {
  const fingerprint = fingerprintOf(p.area, p.kind, p.scope)
  const session = getSession(undefined, 'WRITE')
  try {
    /*
     * Only a proposal still IN PLAY holds its place (review of 23 Sep 2026):
     * open, accepted or «not now». A rejected or expired one used to block
     * the fingerprint for ever — the return rule after a rejection
     * (`proposalMayReturn`) and the return of an expired one never ran. Now
     * they fall through to the rejection record; if the proposal may come
     * back, the closed node gives way (the fingerprint is unique) and the
     * rejection stays in its record.
     */
    const gia = await runQueryOne<{ status: string }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, area: $area, fingerprint: $fingerprint})
      RETURN p.status AS status
    `, { tenantId: p.tenantId, area: p.area, fingerprint })
    if (gia && !PROPOSAL_STATUSES_THAT_MAY_RETURN.includes(gia.status)) return { scritta: false, motivo: 'gia_presente' }

    // La lapide di un rifiuto vive oltre la purga della proposta.
    const lapide = await runQueryOne<{ grade: number; at: string }>(session, `
      MATCH (r:ProposalRejection {tenant_id: $tenantId, fingerprint: $fingerprint})
      RETURN r.evidence_grade AS grade, r.rejected_at AS at
    `, { tenantId: p.tenantId, fingerprint })
    if (lapide) {
      const puo = proposalMayReturn({
        rejectedGrade: Number(lapide.grade ?? 0),
        currentN:      p.evidence.n,
        rejectedAt:    new Date(String(lapide.at)),
        now:           adesso,
      })
      if (!puo) return { scritta: false, motivo: 'rifiutata_di_recente' }
    }
    if (gia) {
      await runQuery(session, `
        MATCH (p:Proposal {tenant_id: $tenantId, area: $area, fingerprint: $fingerprint})
        WHERE p.status IN $closed
        DETACH DELETE p
      `, { tenantId: p.tenantId, area: p.area, fingerprint, closed: [...PROPOSAL_STATUSES_THAT_MAY_RETURN] })
    }

    const conteggi = await runQueryOne<{ aperte: number; oggi: number }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId})
      WITH collect(p) AS tutte
      RETURN size([x IN tutte WHERE x.status IN $aperte]) AS aperte,
             size([x IN tutte WHERE x.created_at >= $daMezzanotte]) AS oggi
    `, {
      tenantId: p.tenantId,
      aperte: [...PROPOSAL_OPEN_STATUSES],
      daMezzanotte: new Date(Date.UTC(adesso.getUTCFullYear(), adesso.getUTCMonth(), adesso.getUTCDate())).toISOString(),
    })
    if (Number(conteggi?.aperte ?? 0) >= limiti.maxOpen)   return { scritta: false, motivo: 'tetto_aperte' }
    if (Number(conteggi?.oggi ?? 0)   >= limiti.maxPerDay) return { scritta: false, motivo: 'tetto_giornaliero' }

    const righe = await runQuery<Record<string, unknown>>(session, `
      CREATE (p:Proposal {
        id: $id, tenant_id: $tenantId, area: $area, kind: $kind,
        params: $params, fingerprint: $fingerprint, evidence: $evidence,
        evidence_grade: $grade, occurrences: $n, window_days: $windowDays,
        action: $action, rationale: $rationale, rationale_language: $rationaleLanguage,
        status: 'open', created_at: $now,
        decided_at: null, decided_by: null,
        rejected_kind: null, rejected_note: null, not_now_until: null,
        audit_entry_id: null, execution_error: null,
        undo_state: null, undone: false,
        cause: $cause, execution_details: null,
        verification: null, verified_at: null, verification_detail: null
      })
      RETURN ${CAMPI}
    `, {
      id: uuidv4(), tenantId: p.tenantId, area: p.area, kind: p.kind,
      params: JSON.stringify(p.params), fingerprint,
      evidence: JSON.stringify(p.evidence),
      grade: evidenceGrade(p.evidence.n),
      n: p.evidence.n, windowDays: p.evidence.windowDays,
      action: p.action ? JSON.stringify(p.action) : null,
      rationale: p.rationale ?? null,
      rationaleLanguage: p.rationaleLanguage ?? null,
      cause: p.cause ?? null,
      now: adesso.toISOString(),
    })
    const riga = righe[0]
    if (!riga) throw new Error(`proposals: CREATE returned no row for ${fingerprint}`)
    return { scritta: true, proposal: mappa(riga) }
  } finally {
    await session.close()
  }
}

export interface FiltroProposte {
  status?: readonly ProposalStatus[]
  area?:   readonly ProposalArea[]
  limit:   number
  offset:  number
}

export async function elencaProposte(
  tenantId: string,
  filtro: FiltroProposte,
): Promise<{ items: ProposalRow[]; total: number }> {
  const session = getSession(undefined, 'READ')
  try {
    // The tenant in the pattern, not in the assembled WHERE: the tenant lints
    // and check-cypher see it there (wave 7 · A3).
    const filtri = [
      ...(filtro.status?.length ? ['p.status IN $status'] : []),
      ...(filtro.area?.length   ? ['p.area IN $area']     : []),
    ]
    const dove = filtri.length > 0 ? `WHERE ${filtri.join(' AND ')}` : ''

    const params = {
      tenantId,
      status: filtro.status ? [...filtro.status] : [],
      area:   filtro.area   ? [...filtro.area]   : [],
      limit:  filtro.limit, offset: filtro.offset,
    }

    const totale = await runQueryOne<{ n: number }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId}) ${dove} RETURN count(p) AS n
    `, params)

    /*
     * `toInteger`: un numero JavaScript per Neo4j è un float, e uno SKIP/LIMIT
     * float fa cadere la query. È lo stesso difetto che il 17 set aveva spento
     * l'intera diagnostica della console.
     */
    const righe = await runQuery<Record<string, unknown>>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId}) ${dove}
      RETURN ${CAMPI}
      ORDER BY p.occurrences DESC, p.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)

    return { items: righe.map(mappa), total: Number(totale?.n ?? 0) }
  } finally {
    await session.close()
  }
}

export async function proposta(tenantId: string, id: string): Promise<ProposalRow | null> {
  const session = getSession(undefined, 'READ')
  try {
    const righe = await runQuery<Record<string, unknown>>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, id: $id}) RETURN ${CAMPI}
    `, { tenantId, id })
    return righe[0] ? mappa(righe[0]) : null
  } finally {
    await session.close()
  }
}

/** I conteggi in testa alla pagina, in una query sola. */
export async function conteggiProposte(tenantId: string): Promise<Record<ProposalStatus, number>> {
  const session = getSession(undefined, 'READ')
  try {
    const righe = await runQuery<{ status: string; n: number }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId})
      RETURN p.status AS status, count(*) AS n
    `, { tenantId })
    const out = { open: 0, accepted: 0, rejected: 0, not_now: 0, expired: 0, superseded: 0 }
    for (const r of righe) {
      const s = String(r.status) as ProposalStatus
      if (s in out) out[s] = Number(r.n)
    }
    return out
  } finally {
    await session.close()
  }
}

/** Segna una proposta come decisa. Non esegue niente: l'esecuzione sta altrove. */
export async function segnaDecisa(
  tenantId: string,
  id: string,
  campi: {
    status: ProposalStatus
    decidedBy: string
    rejectedKind?: ProposalRejectionKind | null
    rejectedNote?: string | null
    notNowUntil?: string | null
    auditEntryId?: string | null
    executionError?: string | null
    undoState?: Record<string, unknown> | null
    undone?: boolean
    openedProblem?: { id: string; number: string } | null
    /** Written only when given: a later decision does not erase what an execution did. */
    executionDetails?: Record<string, unknown> | null
  },
  adesso: Date = new Date(),
): Promise<ProposalRow | null> {
  const session = getSession(undefined, 'WRITE')
  try {
    const righe = await runQuery<Record<string, unknown>>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, id: $id})
      SET p.status = $status,
          p.decided_at = $now,
          p.decided_by = $decidedBy,
          p.rejected_kind = $rejectedKind,
          p.rejected_note = $rejectedNote,
          p.not_now_until = $notNowUntil,
          p.audit_entry_id = $auditEntryId,
          p.execution_error = $executionError,
          p.undo_state = $undoState,
          p.undone = $undone,
          p.opened_problem = $openedProblem,
          p.execution_details = coalesce($executionDetails, p.execution_details)
      RETURN ${CAMPI}
    `, {
      tenantId, id, status: campi.status, now: adesso.toISOString(),
      decidedBy: campi.decidedBy,
      rejectedKind: campi.rejectedKind ?? null,
      rejectedNote: campi.rejectedNote ?? null,
      notNowUntil: campi.notNowUntil ?? null,
      auditEntryId: campi.auditEntryId ?? null,
      executionError: campi.executionError ?? null,
      undoState: campi.undoState ? JSON.stringify(campi.undoState) : null,
      undone: campi.undone ?? false,
      openedProblem: campi.openedProblem ? JSON.stringify(campi.openedProblem) : null,
      executionDetails: campi.executionDetails ? JSON.stringify(campi.executionDetails) : null,
    })
    return righe[0] ? mappa(righe[0]) : null
  } finally {
    await session.close()
  }
}

/**
 * La lapide del rifiuto. Si scrive insieme al rifiuto e sopravvive alla purga:
 * senza, fra dodici mesi il giro notturno riproporrebbe quello che qualcuno
 * ha già respinto, e quella persona non avrebbe modo di capire perché.
 */
export async function scriviLapide(
  tenantId: string,
  fingerprint: string,
  campi: { kind: ProposalRejectionKind; grade: number },
  adesso: Date = new Date(),
): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) => tx.run(`
      MERGE (r:ProposalRejection {tenant_id: $tenantId, fingerprint: $fingerprint})
      SET r.rejected_kind = $kind, r.evidence_grade = $grade, r.rejected_at = $now
    `, { tenantId, fingerprint, kind: campi.kind, grade: campi.grade, now: adesso.toISOString() }))
  } finally {
    await session.close()
  }
}

/**
 * Le proposte mai lette scadono e liberano lo slot.
 *
 * Senza questa passata bastano cinque proposte ignorate perché il prodotto
 * smetta di proporre qualunque cosa, in silenzio: la pagina resta ferma sulle
 * stesse righe e sembra semplicemente che non ci sia niente di nuovo. È il
 * peggior modo di morire per una funzionalità, perché è indistinguibile dal
 * funzionare. Scadere NON è rifiutare: non si scrive nessuna lapide, e se le
 * prove ci sono ancora la proposta può tornare.
 */
export async function scadiLeVecchie(tenantId: string, adesso: Date = new Date()): Promise<number> {
  const limite = new Date(adesso.getTime() - PROPOSAL_EXPIRY_DAYS * 86_400_000).toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    const righe = await runQuery<{ n: number }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, status: 'open'})
      WHERE p.created_at < $limite
      SET p.status = 'expired', p.decided_at = $now
      RETURN count(p) AS n
    `, { tenantId, limite, now: adesso.toISOString() })
    return Number(righe[0]?.n ?? 0)
  } finally {
    await session.close()
  }
}

/** The closed statuses whose proposal may be written again, when the evidence allows it. */
export const PROPOSAL_STATUSES_THAT_MAY_RETURN: readonly string[] = ['rejected', 'expired']

/**
 * Closed proposals are purged after PROPOSAL_RETENTION_MONTHS (review of 23
 * Sep 2026): the constant was declared and never used, and every proposal
 * ever made stayed in the graph. A rejection survives the purge in its own
 * record (`ProposalRejection`), which is what the return rule reads.
 */
export async function purgaLeChiuse(tenantId: string, adesso: Date = new Date()): Promise<number> {
  const limite = new Date(adesso)
  limite.setUTCMonth(limite.getUTCMonth() - PROPOSAL_RETENTION_MONTHS)
  const session = getSession(undefined, 'WRITE')
  try {
    const righe = await runQuery<{ n: number }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId})
      WHERE p.status IN ['accepted', 'rejected', 'expired'] AND p.decided_at < $limite
      DETACH DELETE p
      RETURN count(*) AS n
    `, { tenantId, limite: limite.toISOString() })
    return Number(righe[0]?.n ?? 0)
  } finally {
    await session.close()
  }
}

/** Le «non ora» tornano aperte quando il loro turno arriva. */
export async function risvegliaLeRimandate(tenantId: string, adesso: Date = new Date()): Promise<number> {
  const session = getSession(undefined, 'WRITE')
  try {
    const righe = await runQuery<{ n: number }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, status: 'not_now'})
      WHERE p.not_now_until IS NOT NULL AND p.not_now_until <= $now
      SET p.status = 'open', p.not_now_until = null
      RETURN count(p) AS n
    `, { tenantId, now: adesso.toISOString() })
    return Number(righe[0]?.n ?? 0)
  } finally {
    await session.close()
  }
}
