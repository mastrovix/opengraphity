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
import { analizzaCliente } from '../../jobs/proposalScanner.js'
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
    /** Serve alla pagina per decidere se offrire «disfa»: non si offre un bottone che fallirà. */
    undoable: row.status === 'accepted' && !row.undone && row.undoState != null
      && row.action != null && azioneDisfabile(row.action.type),
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
    })
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
    await segnaDecisa(ctx.tenantId, row.id, {
      status: 'open', decidedBy: ctx.userId, executionError: messaggio,
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
   * risposta che fa smettere di usare un bottone. La coda serve al giro
   * notturno; per il click basta il lock, che è il `jobId` per minuto.
   *
   * Il giro notturno ripasserà comunque: se questa analisi cade a metà, le
   * proposte che mancano nascono stanotte.
   */
  const { create, saltate } = await analizzaCliente(ctx.tenantId)

  await audit(ctx, 'proposal.analysis_run', 'Proposal', ctx.tenantId, {
    created: create, skipped: saltate, analysts: ['configuration'], source: 'manual',
  })

  return { created: create, skipped: paramList(saltate) }
}

export const proposalResolvers = {
  Query: {
    proposals: proposalsQuery,
    proposal:  proposalQuery,
  },
  Mutation: {
    acceptProposal,
    rejectProposal,
    postponeProposal,
    undoProposal,
    runProposalAnalysis,
  },
  Proposal: {
    decidedByName: (p: { decidedBy: string | null }, _: unknown, ctx: GraphQLContext) =>
      nomeDi(ctx.tenantId, p.decidedBy),
  },
}
