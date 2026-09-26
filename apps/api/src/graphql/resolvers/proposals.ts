/**
 * LE PROPOSTE DI MIGLIORAMENTO — i resolver (20 set 2026).
 *
 * Tre regole che qui si vedono, e che valgono per tutto il programma:
 *
 * 1. **L'attore è chi accetta, non «system».** `automationEngine` registra le
 *    sue esecuzioni con un contesto forgiato `{userEmail: 'system'}`, ed è
 *    giusto lì: l'ha decisa una regola. Qui no — l'ha autorizzata una
 *    persona, e il registro deve dire quale.
 * 2. **Le prove si filtrano per permesso di TIPO.** Un elenco di 47 incident
 *    mostrato a chi non può leggere gli incident è una fuga di dati. Il
 *    precedente è `PERMESSO_LETTURA` dei task: il permesso si decide sul
 *    tipo, non sul contenitore. Quello che non si può mostrare si CONTA, e la
 *    pagina dice «N non visibili» invece di tacere.
 * 3. **Un'esecuzione fallita non lascia la proposta «accettata» e basta.** Si
 *    scrive l'errore sul nodo e lo si mostra: una proposta accettata che non
 *    ha fatto niente, e non lo dice, è la bugia peggiore di tutte.
 */
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { requirePermission } from '../../lib/permissions.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { config } from '../../lib/config.js'
import {
  PROPOSAL_REJECTION_NOTE_MIN, PROPOSAL_REJECTION_NOTE_MAX,
  PROPOSAL_LIMIT_DEFAULTS,
  isProposalArea, isProposalStatus, isProposalRejectionKind,
  evidenceGrade,
  type ProposalArea, type ProposalStatus,
} from '@opengraphity/types'
import {
  elencaProposte, proposta, conteggiProposte, segnaDecisa, scriviLapide,
  type ProposalRow,
} from '../../lib/proposals.js'
import { eseguiAzione, disfaAzione, azioneDisfabile } from '../../lib/proposalActions.js'
import {
  puoPrendereAtto, puoAprireUnProblem, titoloDelProblem, descrizioneDelProblem, GENERI_OPERATIVI_DA_PROBLEM,
} from '../../lib/proposalAgreement.js'
import { openGrafoSystemCI } from '../../lib/opengrafoSystemCI.js'
import { setTicketTeam } from '../../services/ticketAssignment.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { TICKET_TEAM_ASSIGNED_EVENT } from '@opengraphity/types'
import { createProblem } from '../../services/problemService.js'
import { legaAllaProposta, fascicoloDelProblem, fascicoloPossibile } from '../../lib/problemDossier.js'
import { avviaIndagine } from '../../lib/indagineAutomatica.js'
import { enqueuePortaIlFascicolo } from '../../jobs/autoanalisiWorker.js'
import { analizzaCliente, conIlLucchetto, scheduleRemedyVerification } from '../../jobs/proposalScanner.js'
import { PERMESSO_LETTURA } from './ticketTasks.js'
import { getSession } from '@opengraphity/neo4j'
import { runQueryOne } from './ci-utils.js'

const LIMITE_PREDEFINITO = 25
const LIMITE_MASSIMO = 100

function paramList(o: Record<string, string | number> | undefined): Array<{ name: string; value: string }> {
  if (!o) return []
  return Object.entries(o).map(([name, value]) => ({ name, value: String(value) }))
}

/**
 * Le prove, filtrate per quello che chi guarda può leggere.
 *
 * `PERMESSO_LETTURA` mappa il tipo di ticket al permesso che serve; un tipo
 * che non è nella mappa non è un ticket e si mostra (una squadra, una voce di
 * catalogo: non sono dati riservati per tipo).
 */
function proveVisibili(row: ProposalRow, ctx: GraphQLContext) {
  let nascosti = 0
  const refs = row.evidence.refs.map((r) => {
    const permesso = (PERMESSO_LETTURA as Record<string, string | undefined>)[r.entityType]
    const visible = permesso == null || ctx.permissions.has(permesso as never)
    if (!visible) nascosti += 1
    return {
      entityType: r.entityType,
      id:         visible ? r.id : '',
      label:      visible ? (r.label ?? null) : null,
      visible,
    }
  })
  return { refs, nascosti }
}

function mappaGql(row: ProposalRow, ctx: GraphQLContext) {
  const { refs, nascosti } = proveVisibili(row, ctx)
  return {
    id: row.id,
    area: row.area,
    kind: row.kind,
    params: paramList(row.params),
    fingerprint: row.fingerprint,
    evidence: {
      n: row.evidence.n,
      windowDays: row.evidence.windowDays,
      refs,
      hiddenRefs: nascosti,
      extra: paramList(row.evidence.extra),
    },
    occurrences: row.occurrences,
    windowDays: row.windowDays,
    actionType: row.action?.type ?? null,
    rationale: row.rationale,
    rationaleLanguage: row.rationaleLanguage,
    status: row.status,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    rejectedKind: row.rejectedKind,
    rejectedNote: row.rejectedNote,
    notNowUntil: row.notNowUntil,
    auditEntryId: row.auditEntryId,
    executionError: row.executionError,
    executionErrorKey: row.executionErrorI18n?.key ?? null,
    executionErrorParams: paramList(row.executionErrorI18n?.params),
    verification: row.verification,
    verifiedAt: row.verifiedAt,
    verificationDetail: paramList((row.verificationDetail ?? undefined) as Record<string, string | number> | undefined),
    /** Serve alla pagina per decidere se offrire «disfa»: non si offre un bottone che fallirà. */
    undoable: row.status === 'accepted' && !row.undone && row.undoState != null
      && row.action != null && azioneDisfabile(row.action.type),
    /*
     * I DUE GESTI DI CHI È D'ACCORDO (20 set 2026).
     *
     * La regola sta in `lib/proposalAgreement.ts` e non qui, perché la
     * decidono in due — questa pagina per mostrare il bottone, e la mutation
     * per rifiutarlo se qualcuno lo chiama lo stesso.
     */
    acknowledgeable: puoPrendereAtto(row),
    problemOpenable: puoAprireUnProblem(row),
    openedProblemId:     row.openedProblem?.id ?? null,
    openedProblemNumber: row.openedProblem?.number ?? null,
  }
}

/** Il nome di chi ha deciso, non il suo UUID. Precedente: `resolvedByName` delle anomalie. */
async function nomeDi(tenantId: string, userId: string | null): Promise<string | null> {
  if (!userId) return null
  const session = getSession(undefined, 'READ')
  try {
    const r = await runQueryOne<{ name: string }>(session,
      'MATCH (u:User {tenant_id: $tenantId, id: $userId}) RETURN u.name AS name', { tenantId, userId })
    return r?.name ?? null
  } finally {
    await session.close()
  }
}

async function proposalsQuery(
  _: unknown,
  args: { status?: string[]; area?: string[]; limit?: number; offset?: number },
  ctx: GraphQLContext,
) {
  requirePermission(ctx, 'proposal.read')

  const status = (args.status ?? []).filter(isProposalStatus) as ProposalStatus[]
  const area   = (args.area ?? []).filter(isProposalArea) as ProposalArea[]
  const limit  = Math.min(Math.max(args.limit ?? LIMITE_PREDEFINITO, 1), LIMITE_MASSIMO)
  const offset = Math.max(args.offset ?? 0, 0)

  const [{ items, total }, counts] = await Promise.all([
    elencaProposte(ctx.tenantId, { status, area, limit, offset }),
    conteggiProposte(ctx.tenantId),
  ])

  return {
    items: items.map((r) => mappaGql(r, ctx)),
    total,
    counts: {
      open: counts.open, accepted: counts.accepted, rejected: counts.rejected,
      notNow: counts.not_now, expired: counts.expired, superseded: counts.superseded,
      openFaults: counts.openFaults,
    },
    maxOpen: PROPOSAL_LIMIT_DEFAULTS.maxOpen,
    lastRunAt: await ultimoGiro(ctx.tenantId),
    /*
     * Senza chiave Anthropic gli analisti AI non esistono e la pagina lo deve
     * dire: restano solo le proposte deterministiche. Meglio saperlo che
     * credere che non ci sia niente da proporre.
     */
    aiAvailable: (config.anthropicApiKey ?? '') !== '',
  }
}

/** Quando è girata l'ultima analisi. `null` = mai: la pagina distingue i due casi. */
async function ultimoGiro(tenantId: string): Promise<string | null> {
  const session = getSession(undefined, 'READ')
  try {
    const r = await runQueryOne<{ at: string }>(session, `
      MATCH (a:AuditEntry {tenant_id: $tenantId, action: 'proposal.analysis_run'})
      RETURN a.created_at AS at ORDER BY a.created_at DESC LIMIT 1
    `, { tenantId })
    return r?.at ?? null
  } finally {
    await session.close()
  }
}

async function proposalQuery(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requirePermission(ctx, 'proposal.read')
  const row = await proposta(ctx.tenantId, args.id)
  return row ? mappaGql(row, ctx) : null
}

async function caricaAperta(ctx: GraphQLContext, id: string, attese: ProposalStatus[]): Promise<ProposalRow> {
  const row = await proposta(ctx.tenantId, id)
  if (!row) throw new NotFoundError('Proposal', id)
  if (!attese.includes(row.status)) {
    throw new ValidationError(
      `this proposal is "${row.status}": only ${attese.join(' or ')} can be decided`,
      { key: 'errors.proposal.alreadyDecided', params: { status: row.status } },
    )
  }
  return row
}

async function acceptProposal(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requirePermission(ctx, 'proposal.accept')
  const row = await caricaAperta(ctx, args.id, ['open', 'not_now'])

  if (!row.action) {
    throw new ValidationError(
      'this proposal has nothing to execute: it is there to be read',
      { key: 'errors.proposal.nothingToExecute' },
    )
  }

  try {
    const esito = await eseguiAzione(ctx.tenantId, row.action)
    /*
     * L'audit PRIMA di segnare la proposta: se il processo cade fra i due, è
     * meglio una voce di registro senza la proposta aggiornata che una
     * proposta «accettata» senza traccia di cosa ha fatto.
     */
    await audit(ctx, 'proposal.accepted', 'Proposal', row.id, {
      area: row.area, kind: row.kind, action: row.action.type, ...esito.details,
    })
    const aggiornata = await segnaDecisa(ctx.tenantId, row.id, {
      status: 'accepted', decidedBy: ctx.userId,
      undoState: esito.undoState, undone: false,
      // What the action did, for the verification of an operational remedy (26 Sep 2026).
      executionDetails: esito.details,
    })
    // An operational remedy is checked some minutes later; if the queue is down, the nightly run does it.
    if (row.area === 'operations') {
      await scheduleRemedyVerification(ctx.tenantId, row.id).catch((err: unknown) => {
        logger.warn({ module: 'proposals', tenantId: ctx.tenantId, id: row.id, err: err instanceof Error ? err.message : String(err) },
          'proposals: remedy verification not queued, the nightly run will verify')
      })
    }
    return mappaGql(aggiornata ?? row, ctx)
  } catch (err) {
    const messaggio = err instanceof Error ? err.message : String(err)
    logger.error({ module: 'proposals', tenantId: ctx.tenantId, id: row.id, err: messaggio },
      'proposals: accepted action failed')
    /*
     * Si registra il FALLIMENTO, non solo il successo: un'azione che non è
     * andata a buon fine è esattamente ciò che qualcuno cercherà nel registro.
     * E la proposta resta aperta, con l'errore scritto: accettarla di nuovo
     * dopo aver sistemato la causa deve essere possibile.
     */
    await audit(ctx, 'proposal.execution_failed', 'Proposal', row.id, {
      area: row.area, kind: row.kind, action: row.action.type, error: messaggio,
    })
    // A refusal the action explains (a ValidationError) is kept in the client's words too:
    // the line under the proposal said the technical message, in English, with ids (26 Sep 2026).
    const i18n = err instanceof GraphQLError ? err.extensions['i18n'] as { key: string; params?: Record<string, string | number> } | undefined : undefined
    await segnaDecisa(ctx.tenantId, row.id, {
      status: 'open', decidedBy: ctx.userId, executionError: messaggio, executionErrorI18n: i18n ?? null,
    })
    throw err
  }
}

async function rejectProposal(
  _: unknown,
  args: { id: string; kind: string; note: string },
  ctx: GraphQLContext,
) {
  requirePermission(ctx, 'proposal.accept')
  const row = await caricaAperta(ctx, args.id, ['open', 'not_now'])

  if (!isProposalRejectionKind(args.kind)) {
    throw new ValidationError(
      `"${args.kind}" is not a rejection kind`,
      { key: 'errors.proposal.rejectionKindUnknown', params: { kind: args.kind } },
    )
  }
  const nota = args.note.trim()
  if (nota.length < PROPOSAL_REJECTION_NOTE_MIN) {
    throw new ValidationError(
      `the rejection note must be at least ${String(PROPOSAL_REJECTION_NOTE_MIN)} characters: it is what the next reader has`,
      { key: 'errors.proposal.rejectionNoteTooShort', params: { min: PROPOSAL_REJECTION_NOTE_MIN } },
    )
  }
  if (nota.length > PROPOSAL_REJECTION_NOTE_MAX) {
    throw new ValidationError(
      `the rejection note is longer than ${String(PROPOSAL_REJECTION_NOTE_MAX)} characters`,
      { key: 'errors.proposal.rejectionNoteTooLong', params: { max: PROPOSAL_REJECTION_NOTE_MAX } },
    )
  }

  const aggiornata = await segnaDecisa(ctx.tenantId, row.id, {
    status: 'rejected', decidedBy: ctx.userId,
    rejectedKind: args.kind, rejectedNote: nota,
  })
  // La lapide sopravvive alla purga: è ciò che impedisce di riproporre.
  await scriviLapide(ctx.tenantId, row.fingerprint, {
    kind: args.kind, grade: evidenceGrade(row.occurrences),
  })
  await audit(ctx, 'proposal.rejected', 'Proposal', row.id, {
    area: row.area, kind: row.kind, rejectedKind: args.kind, note: nota,
  })
  return mappaGql(aggiornata ?? row, ctx)
}

async function postponeProposal(_: unknown, args: { id: string; until: string }, ctx: GraphQLContext) {
  requirePermission(ctx, 'proposal.accept')
  const row = await caricaAperta(ctx, args.id, ['open'])

  const quando = new Date(args.until)
  if (Number.isNaN(quando.getTime())) {
    throw new ValidationError(`"${args.until}" is not a date`, { key: 'errors.proposal.postponeDateInvalid' })
  }
  if (quando.getTime() <= Date.now()) {
    throw new ValidationError(
      'the wake-up date must be in the future, otherwise postponing changes nothing',
      { key: 'errors.proposal.postponeDatePast' },
    )
  }

  const aggiornata = await segnaDecisa(ctx.tenantId, row.id, {
    status: 'not_now', decidedBy: ctx.userId, notNowUntil: quando.toISOString(),
  })
  await audit(ctx, 'proposal.postponed', 'Proposal', row.id, { area: row.area, kind: row.kind, until: quando.toISOString() })
  return mappaGql(aggiornata ?? row, ctx)
}

async function undoProposal(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requirePermission(ctx, 'proposal.accept')
  const row = await proposta(ctx.tenantId, args.id)
  if (!row) throw new NotFoundError('Proposal', args.id)

  if (row.status !== 'accepted' || row.undone || !row.undoState || !row.action) {
    throw new ValidationError(
      'there is nothing to undo on this proposal',
      { key: 'errors.proposal.nothingToUndo' },
    )
  }

  await disfaAzione(ctx.tenantId, row.action.type, row.undoState)
  const aggiornata = await segnaDecisa(ctx.tenantId, row.id, {
    status: 'accepted', decidedBy: row.decidedBy ?? ctx.userId,
    undoState: row.undoState, undone: true,
  })
  await audit(ctx, 'proposal.undone', 'Proposal', row.id, { area: row.area, kind: row.kind, action: row.action.type })
  return mappaGql(aggiornata ?? row, ctx)
}

/**
 * «PRESO ATTO»: sono d'accordo, e non serve altro.
 *
 * Esiste perché fino a oggi non c'era modo di essere d'accordo con le sei
 * proposte su otto che non portano un'azione: restavano «rifiuta» — cioè
 * dire il falso, e per giunta piantare una lapide che blocca quell'impronta
 * per trenta giorni — «non ora», o la scadenza.
 *
 * Non esegue niente e non finge di farlo: la proposta diventa `accepted`,
 * esce dalla lista, e nell'Audit Log resta chi è stato d'accordo e quando.
 */
async function acknowledgeProposal(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requirePermission(ctx, 'proposal.accept')
  const row = await caricaAperta(ctx, args.id, ['open', 'not_now'])

  if (!puoPrendereAtto(row)) {
    // Una proposta che PORTA un'azione si accetta eseguendola: due bottoni
    // che vogliono dire quasi la stessa cosa sulla stessa riga confondono.
    throw new ValidationError(
      'this proposal carries an action: accept it to run it',
      { key: 'errors.proposal.acknowledgeHasAction' },
    )
  }

  const aggiornata = await segnaDecisa(ctx.tenantId, row.id, {
    status: 'accepted', decidedBy: ctx.userId,
  })
  await audit(ctx, 'proposal.acknowledged', 'Proposal', row.id, { area: row.area, kind: row.kind })
  return mappaGql(aggiornata ?? row, ctx)
}

/** The tenant's OpenGrafo CI and the team that owns it, or the reason there is none. */
async function opengrafoOwnerOf(tenantId: string): Promise<{ ciId: string; teamId: string }> {
  const session = getSession(undefined, 'READ')
  try {
    const sistema = await openGrafoSystemCI(session, tenantId)
    if (!sistema) {
      throw new ValidationError('this organization has no OpenGrafo CI to open the problem on', { key: 'errors.proposal.noOpenGrafoCI' })
    }
    if (!sistema.ownerTeamId || sistema.ownerMembers === 0) {
      throw new ValidationError('the OpenGrafo CI has no Owner Group with members: the problem would reach no one', { key: 'errors.proposal.openGrafoCINobody' })
    }
    return { ciId: sistema.ciId, teamId: sistema.ownerTeamId }
  } finally {
    await session.close()
  }
}

/**
 * «SONO D'ACCORDO, E QUALCUNO CI LAVORI»: apre un Problem.
 *
 * Il Problem nasce nel tenant della proposta, con dentro il rationale del
 * modello dichiarato come tale e le misure. Da lì in poi lo segue il processo
 * che il cliente ha già: priorità dalla sua matrice, SLA dalle sue policy,
 * workflow dal suo disegnatore. Questa mutation non ne sa niente ed è
 * giusto — chiama `createProblem` come lo chiama la pagina dei problem.
 *
 * NON si disfa. `undoState` resta vuoto e `undoable` falso: un Problem aperto
 * non si «annulla», si chiude nel suo processo, e offrire un bottone che
 * cancella un ticket a cui qualcuno può già aver lavorato sarebbe peggio del
 * problema che risolve.
 */
async function openProblemFromProposal(
  _: unknown, args: { id: string; impact: string; urgency: string }, ctx: GraphQLContext,
) {
  requirePermission(ctx, 'proposal.accept')
  /*
   * E anche il permesso di SCRIVERE un problem: chi decide sulle proposte non è
   * automaticamente chi può aprire ticket, e questo gesto ne apre uno vero.
   */
  requirePermission(ctx, 'problem.write')
  const row = await caricaAperta(ctx, args.id, ['open', 'not_now'])

  if (!puoAprireUnProblem(row)) {
    throw new ValidationError(
      'a problem cannot be opened from this proposal',
      { key: 'errors.proposal.notProblemMaterial' },
    )
  }

  /*
   * Impatto e urgenza vengono da chi apre, e `createProblem` li valida contro
   * i vocabolari del cliente e ne ricava la priorità dalla sua matrice. Qui
   * non si sceglie niente al posto suo: nessun Dizionario dichiara un impatto
   * predefinito, e inventarne uno avrebbe messo in mano al prodotto una
   * decisione che è del cliente.
   */
  /*
   * A REMEDY THAT DID NOT HOLD IS A FAULT OF OPENGRAFO (26 Sep 2026, the
   * owner). Its Problem is opened on the tenant's OpenGrafo CI and given to
   * the team that owns it — without, it went into investigation owned by no
   * one, and «notify the owning team» failed. No CI, or a team with nobody in
   * it: said before anything is written, pointing at the CI.
   */
  const operativo = GENERI_OPERATIVI_DA_PROBLEM.has(row.kind) ? await opengrafoOwnerOf(ctx.tenantId) : null

  const problem = await createProblem({
    title:       titoloDelProblem(row.params, row.kind),
    description: descrizioneDelProblem(row),
    impact:      args.impact,
    urgency:     args.urgency,
    ...(operativo ? { affectedCIs: [operativo.ciId] } : {}),
  }, { tenantId: ctx.tenantId, userId: ctx.userId })

  if (operativo) {
    const session = getSession(undefined, 'WRITE')
    try {
      await setTicketTeam(session, 'Problem', problem.id as string, operativo.teamId, ctx.tenantId)
    } finally {
      await session.close()
    }
    // The SLA policy may depend on the team just assigned (as assignProblemToTeam does).
    await publishEvent(TICKET_TEAM_ASSIGNED_EVENT, ctx.tenantId, ctx.userId, { entity_type: 'problem', entity_id: problem.id as string, team_id: operativo.teamId })
  }

  /*
   * Il legame si scrive SUL PROBLEM, non solo sulla proposta: è da lì che il
   * fascicolo d'indagine risale all'analisi e alle firme di errore, e un
   * legame che vive solo dentro la frase della descrizione si rompe la prima
   * volta che qualcuno riscrive la frase.
   */
  await legaAllaProposta(ctx.tenantId, problem.id as string, row.id)

  /*
   * E l'indagine parte da sola (21 set 2026).
   *
   * Prima il Problem restava nel passo iniziale finché una persona non
   * cliccava «Inizia analisi» — un gesto che non aggiungeva niente: chi apre
   * un Problem da una proposta ha già letto la proposta e ha già deciso che
   * c'e' qualcosa da capire. Il passo iniziale diceva il falso.
   *
   * L'esito NON fa fallire questa mutazione: se il workflow del cliente non
   * porta in analisi dal passo iniziale, il Problem resta dov'e' e la ragione
   * sta nei log — perche' il Problem esiste già ed e' già legato, e
   * cancellarlo per un passo mancato sarebbe peggio.
   */
  const indagine = await avviaIndagine(
    ctx.tenantId, problem.id as string, problem.number as string, ctx.userId,
  )

  /*
   * E il fascicolo parte verso GitHub, IN CODA (21 set 2026).
   *
   * In coda perché GitHub sta dall'altra parte di internet: chi ha cliccato
   * deve riavere il suo Problem subito, non quando risponde una rete che non
   * controlliamo. Quello che la coda aggiunge — la issue e la richiesta
   * d'analisi — può arrivare un istante dopo; il Problem c'è già ed è già in
   * analisi.
   *
   * Mettere in coda può fallire (Redis giù): si scrive e si va avanti. Il
   * Problem resta valido e il suo fascicolo si legge dal prodotto, che è
   * esattamente com'era prima che questo pezzo esistesse.
   */
  // Only the platform's faults carry a dossier to GitHub: a customer's running never leaves the product (26 Sep 2026).
  if (fascicoloPossibile(ctx.tenantId, row)) {
    try {
      await enqueuePortaIlFascicolo({
        tenantId:      ctx.tenantId,
        problemId:     problem.id as string,
        problemNumber: problem.number as string,
        titolo:        titoloDelProblem(row.params, row.kind),
      })
    } catch (err) {
      logger.error(
        { err, module: 'proposals', tenantId: ctx.tenantId, problem: problem.number },
        'proposals: the dossier was not queued for GitHub, the problem stays in the product only',
      )
    }
  }

  const aggiornata = await segnaDecisa(ctx.tenantId, row.id, {
    status: 'accepted', decidedBy: ctx.userId,
    openedProblem: { id: problem.id as string, number: problem.number as string },
  })
  await audit(ctx, 'proposal.problem_opened', 'Proposal', row.id, {
    area: row.area, kind: row.kind, problemId: problem.id as string, problemNumber: problem.number as string,
    investigationStarted: indagine.fatto, step: indagine.passo, walked: indagine.percorsi.join(' → '),
  })
  logger.info(
    { module: 'proposals', tenantId: ctx.tenantId, proposal: row.id, problem: problem.number },
    'proposals: a problem was opened from a proposal',
  )
  return mappaGql(aggiornata ?? row, ctx)
}

/**
 * «Analizza adesso».
 *
 * Il giro notturno fa la stessa cosa per tutti i clienti; questo la fa per uno
 * solo, su richiesta. È l'unico cammino per cui il costo dipende da quante
 * volte qualcuno clicca, ed è per questo che ha una riga nel limitatore.
 */
async function runProposalAnalysis(_: unknown, __: unknown, ctx: GraphQLContext) {
  requirePermission(ctx, 'proposal.run')

  /*
   * Si analizza QUI e non solo in coda, perché chi ha cliccato deve vedere
   * l'esito adesso: un «ho accodato, ricarica fra un po'» è il genere di
   * risposta che fa smettere di usare un bottone.
   *
   * Il lucchetto è quello di `conIlLucchetto` (20 set 2026, rimedio c).
   * Prima questo commento diceva «per il click basta il lock, che è il
   * `jobId` per minuto» — e quel lock stava su `enqueueProposalScan`, che
   * non chiamava nessuno. Due click ravvicinati, o un click durante il giro
   * notturno, facevano partire tre chiamate al modello due volte.
   *
   * Il giro notturno ripasserà comunque: se questa analisi cade a metà, le
   * proposte che mancano nascono stanotte.
   */
  const esito = await conIlLucchetto(ctx.tenantId, () => analizzaCliente(ctx.tenantId))
  if (esito === null) {
    throw new ValidationError(
      'an analysis is already running for this organization',
      { key: 'errors.proposal.analysisAlreadyRunning' },
    )
  }
  const { create, saltate } = esito

  await audit(ctx, 'proposal.analysis_run', 'Proposal', ctx.tenantId, {
    created: create, skipped: saltate, analysts: ['configuration'], source: 'manual',
  })

  return { created: create, skipped: paramList(saltate) }
}

/**
 * IL FASCICOLO D'INDAGINE di un Problem nato dall'Autoanalisi.
 *
 * `null` quando non se ne fa uno, che è il caso normale: quasi tutti i
 * problem nascono da una persona e non dall'archivio dei log. La pagina usa
 * il `null` per non mostrare un bottone che non avrebbe niente da dare.
 */
async function problemDossierQuery(_: unknown, args: { problemId: string }, ctx: GraphQLContext) {
  requirePermission(ctx, 'problem.read')
  return fascicoloDelProblem(ctx.tenantId, args.problemId)
}

export const proposalResolvers = {
  Query: {
    proposals: proposalsQuery,
    proposal:  proposalQuery,
    problemDossier: problemDossierQuery,
  },
  Mutation: {
    acceptProposal,
    rejectProposal,
    postponeProposal,
    undoProposal,
    acknowledgeProposal,
    openProblemFromProposal,
    runProposalAnalysis,
  },
  Proposal: {
    decidedByName: (p: { decidedBy: string | null }, _: unknown, ctx: GraphQLContext) =>
      nomeDi(ctx.tenantId, p.decidedBy),
  },
}
