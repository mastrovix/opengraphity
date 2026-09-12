/**
 * Requisiti di approvazione della Change (normal/emergency).
 *
 * Isolato (nessun import da helpers/autoTransitions) per evitare cicli: è
 * chiamato da afterEnterStep e da executeChangeTransition. Vedi approvalGate.ts
 * per approva/rigetta.
 *
 * Regole:
 *   - standard  → pre-approvata: nessun record, nessun gate.
 *   - normal/emergency → 1 requisito "change_manager" (team designato con
 *     is_change_manager) + 1 requisito "owner_group" per ciascun owner group
 *     DISTINTO dei CI affected.
 *   - Senza un team Change Manager designato NON si entra in approvazione:
 *     fail-loud (CONFLICT), mai un gate silenziosamente parziale.
 *   - All'ingresso in un passo di scopo `approval` i requisiti vengono RICREATI da zero
 *     (riconciliazione): così un rientro dopo un rigetto — anche via transizione
 *     manuale approval → assessment → approval — riparte con tutti i requisiti
 *     'pending' invece di restare bloccato su record stantii.
 */
import { GraphQLError } from 'graphql'
import { runQuery, runQueryOne } from '../ci-utils.js'
import { logger } from '../../../lib/logger.js'

type Session = Parameters<typeof runQuery>[0]

export interface ApprovalGateState {
  changeType: string
  total: number
  pending: number
  hasChangeManager: boolean
}

/** Stato del gate: quanti requisiti, quanti pendenti, se esiste quello del CM. */
export async function getApprovalGateState(session: Session, changeId: string, tenantId: string): Promise<ApprovalGateState> {
  const row = await runQueryOne<{ changeType: string | null; total: unknown; pending: unknown; cm: unknown }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:HAS_APPROVAL]->(a:ChangeApproval)
    RETURN c.change_type AS changeType,
           count(a) AS total,
           count(CASE WHEN a.status <> 'approved' THEN 1 END) AS pending,
           count(CASE WHEN a.kind = 'change_manager' THEN 1 END) AS cm
  `, { changeId, tenantId })
  if (!row) throw new GraphQLError(`Change ${changeId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
  return {
    changeType:       row.changeType ?? 'normal',
    total:            Number(row.total),
    pending:          Number(row.pending),
    hasChangeManager: Number(row.cm) > 0,
  }
}

/**
 * Lancia CONFLICT se la change NON può lasciare lo step "approval" verso
 * l'approvazione: requisiti assenti, manca il Change Manager, o ce ne sono
 * ancora di pendenti. Le standard passano sempre.
 */
export async function assertAllApprovalsSatisfied(session: Session, changeId: string, tenantId: string): Promise<void> {
  const s = await getApprovalGateState(session, changeId, tenantId)
  if (s.changeType === 'standard') return
  if (s.total === 0) {
    throw new GraphQLError('Requisiti di approvazione non ancora creati: la change non può essere approvata', { extensions: { code: 'CONFLICT' } })
  }
  if (!s.hasChangeManager) {
    throw new GraphQLError('Manca il requisito del Change Manager: designa un team Change Manager (Team e Utenti) prima di approvare', { extensions: { code: 'CONFLICT' } })
  }
  if (s.pending > 0) {
    throw new GraphQLError(`Approvazione incompleta: ${s.pending} requisit${s.pending === 1 ? 'o' : 'i'} ancora in attesa`, { extensions: { code: 'CONFLICT' } })
  }
}

/** True quando tutti i requisiti sono soddisfatti (per l'auto-advance). */
export async function areAllApprovalsSatisfied(session: Session, changeId: string, tenantId: string): Promise<boolean> {
  const s = await getApprovalGateState(session, changeId, tenantId)
  if (s.changeType === 'standard') return true
  return s.total > 0 && s.hasChangeManager && s.pending === 0
}

/**
 * (Ri)crea i requisiti di approvazione all'ingresso in "approval".
 * Riconciliante: cancella i record esistenti e li ricrea tutti 'pending'.
 * Fail-loud se non c'è un team Change Manager designato.
 */
export async function createChangeApprovals(session: Session, changeId: string, tenantId: string): Promise<void> {
  const change = await runQueryOne<{ changeType: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    RETURN c.change_type AS changeType
  `, { changeId, tenantId })
  if (!change) throw new GraphQLError(`Change ${changeId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
  if (change.changeType === 'standard') return

  const cmTeam = await runQueryOne<{ id: string }>(session, `
    MATCH (cm:Team {tenant_id: $tenantId, is_change_manager: true})
    RETURN cm.id AS id LIMIT 1
  `, { tenantId })
  if (!cmTeam) {
    logger.error({ changeId, tenantId }, '[approvalGate] nessun team Change Manager designato (is_change_manager)')
    throw new GraphQLError('Nessun team Change Manager designato: configura un team con "Change Manager" (Team e Utenti) prima di mandare la change in approvazione', { extensions: { code: 'CONFLICT' } })
  }

  const now = new Date().toISOString()
  // Un'unica statement: azzera i record esistenti e ricrea CM + owner group.
  await runQuery(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:HAS_APPROVAL]->(old:ChangeApproval)
    DETACH DELETE old
    WITH DISTINCT c
    CREATE (c)-[:HAS_APPROVAL]->(:ChangeApproval {
      id: randomUUID(), tenant_id: $tenantId, kind: 'change_manager',
      team_id: $cmTeamId, status: 'pending', created_at: $now
    })
    WITH c
    OPTIONAL MATCH (c)-[:AFFECTS_CI]->(ci)-[:OWNED_BY]->(og:Team {tenant_id: $tenantId})
    WITH c, collect(DISTINCT og) AS groups
    UNWIND (CASE WHEN size(groups) = 0 THEN [null] ELSE groups END) AS og
    WITH c, og WHERE og IS NOT NULL
    CREATE (c)-[:HAS_APPROVAL]->(:ChangeApproval {
      id: randomUUID(), tenant_id: $tenantId, kind: 'owner_group',
      team_id: og.id, status: 'pending', created_at: $now
    })
  `, { changeId, tenantId, cmTeamId: cmTeam.id, now })
}

/**
 * Quando viene designato un team Change Manager, le change già ferme in un
 * passo di scopo `approval` (ondata 4 · A4-2: lo scopo, non il nome) senza requisito CM (perché prima non esisteva, quindi il gate
 * era rimasto parziale o vuoto) vengono riconciliate per intero: tutti i
 * requisiti (CM + owner group) ricreati 'pending'. Eventuali approvazioni
 * date sotto un gate senza CM non valgono e ripartono.
 */
export async function backfillChangeManagerApprovals(session: Session, tenantId: string, cmTeamId: string): Promise<number> {
  const rows = await runQuery<{ id: string }>(session, `
    MATCH (c:Change {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:CURRENT_STEP]->(s:WorkflowStep)
    WHERE s.purpose = 'approval'
      AND coalesce(c.deleted, false) = false
      AND coalesce(c.change_type, 'normal') <> 'standard'
      AND NOT EXISTS { (c)-[:HAS_APPROVAL]->(:ChangeApproval {kind: 'change_manager'}) }
    RETURN c.id AS id
  `, { tenantId })
  for (const r of rows) await createChangeApprovals(session, r.id, tenantId)
  if (rows.length > 0) logger.info({ tenantId, cmTeamId, n: rows.length }, '[approvalGate] requisiti ricreati per change già in approvazione senza Change Manager')
  return rows.length
}
