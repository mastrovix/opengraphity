/**
 * LE MISURE OLA/UC DI UNA CHANGE (secondo giro UI del 15 set 2026, decisioni del
 * proprietario: «ogni task a sé», «ogni passo ha la sua misurazione», «due
 * misure»).
 *
 * Una change non ha un team: ce l'hanno i suoi task. Un contratto su una change
 * si misura quindi su:
 *  - ogni task di ASSESSMENT: il tempo del team del task (con la sua storia di
 *    assegnazioni, `ticketTeamHistory.ts`) fino al completamento;
 *  - ogni passo del PIANO DI DEPLOY, due volte:
 *    · VALIDAZIONE: dall'inizio della sua finestra di validazione al test
 *      registrato, per il team che la registra (il team owner del CI);
 *    · RILASCIO: dall'inizio della sua finestra di rilascio al deployment
 *      eseguito, per il team che lo esegue (il team support del CI).
 *    Chi registra il test e chi segna il deployment lo decide il CI
 *    (`taskKinds.ts`), non il piano: per questo il team è quello del CI.
 * Prima dell'inizio della finestra il tempo non corre; fatto prima, conta zero.
 * La misura stessa è quella di tutti (`olaTeamMeasure`).
 */
import { runQuery, type Queryable } from '@opengraphity/neo4j'
import { parseDeploySteps } from './deployWindows.js'
import type { OLATicketFacts, TeamSegment } from './olaAttainment.js'

export type OLAUnitKind = 'assessment' | 'validation' | 'release'

export interface OLAChangeUnit extends OLATicketFacts {
  kind:          OLAUnitKind
  /** Unica nella change. */
  key:           string
  /** Il nodo su cui la passata segna l'avviso, e la chiave con cui lo segna (`alertKey`). */
  node:          { label: 'AssessmentTask' | 'DeployPlanTask'; id: string }
  alerted:       readonly string[]
  ticketId:      string
  ticketNumber:  string | null
  ticketTitle:   string | null
  ciName:        string | null
  responderRole: string | null
  stepTitle:     string | null
}

/** La chiave dell'avviso sul nodo: l'assessment ha un contratto per task, il piano uno per passo e per misura. */
export function olaUnitAlertKey(contractId: string, unit: Pick<OLAChangeUnit, 'kind' | 'key'>): string {
  return unit.kind === 'assessment' ? contractId : `${contractId}:${unit.key}`
}

/** Quali misure leggere: di una change (riquadro), concluse nel periodo (report), aperte di un team (passata). */
export type ChangeUnitScope =
  | { by: 'change'; changeId: string }
  | { by: 'concluded'; cutoff: string; teamId: string | null }
  | { by: 'open'; teamId: string }

const SEGMENTS = `[x IN collect(DISTINCT s) | {teamId: x.team_id, startedAt: x.started_at, endedAt: x.ended_at, inferred: coalesce(x.inferred, false)}]`
const OPEN_CHANGE = `c.completed_at IS NULL AND coalesce(c.deleted, false) = false`

export function assessmentUnitsCypher(scope: ChangeUnitScope['by']): string {
  const where = scope === 'change' ? 'c.id = $changeId'
    : scope === 'concluded' ? 't.completed_at IS NOT NULL AND t.completed_at >= $cutoff AND ($teamId IS NULL OR EXISTS { (t)-[:TEAM_SEGMENT]->(:TicketTeamSegment {team_id: $teamId}) })'
    : `t.completed_at IS NULL AND ${OPEN_CHANGE} AND EXISTS { (t)-[:ASSIGNED_TO_TEAM]->(:Team {id: $teamId}) }`
  return `
    MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask)
    WHERE ${where}
    OPTIONAL MATCH (c)-[:AFFECTS_CI]->(ci {id: t.ci_id})
    OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(ct:Team)
    OPTIONAL MATCH (t)-[:TEAM_SEGMENT]->(s:TicketTeamSegment)
    RETURN c.id AS ticketId, c.number AS ticketNumber, c.title AS ticketTitle,
           t.id AS id, t.created_at AS createdAt, t.completed_at AS concludedAt, t.responder_role AS responderRole,
           coalesce(t.ola_alerted, []) AS alerted, ct.id AS currentTeamId,
           head(collect(DISTINCT coalesce(ci.name, ci.id))) AS ciName, ${SEGMENTS} AS segments`
}

export function deployPlanUnitsCypher(scope: ChangeUnitScope['by']): string {
  const where = scope === 'change' ? 'c.id = $changeId'
    : scope === 'concluded' ? '(v.tested_at >= $cutoff OR d.deployed_at >= $cutoff)'
    : `${OPEN_CHANGE} AND (v.tested_at IS NULL OR d.deployed_at IS NULL)`
  return `
    MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask)
    WHERE dp.steps IS NOT NULL AND dp.steps <> '[]'
    OPTIONAL MATCH (c)-[:HAS_VALIDATION]->(v:ValidationTest {ci_id: dp.ci_id})
    OPTIONAL MATCH (c)-[:HAS_DEPLOYMENT]->(d:DeploymentTask {ci_id: dp.ci_id})
    WITH c, dp, v, d WHERE ${where}
    OPTIONAL MATCH (c)-[:AFFECTS_CI]->(ci {id: dp.ci_id})
    OPTIONAL MATCH (ci)-[:OWNED_BY]->(owner:Team)
    OPTIONAL MATCH (ci)-[:SUPPORTED_BY]->(support:Team)
    RETURN c.id AS ticketId, c.number AS ticketNumber, c.title AS ticketTitle,
           dp.id AS id, dp.created_at AS createdAt, dp.steps AS steps, coalesce(dp.ola_alerted, []) AS alerted,
           v.tested_at AS testedAt, d.deployed_at AS deployedAt,
           coalesce(ci.name, ci.id) AS ciName, owner.id AS ownerTeamId, support.id AS supportTeamId`
}

interface AssessmentRow { ticketId: string; ticketNumber: string | null; ticketTitle: string | null; id: string; createdAt: string; concludedAt: string | null; responderRole: string | null; alerted: string[]; currentTeamId: string | null; ciName: string | null; segments: TeamSegment[] }
interface DeployPlanRow { ticketId: string; ticketNumber: string | null; ticketTitle: string | null; id: string; createdAt: string; steps: string; alerted: string[]; testedAt: string | null; deployedAt: string | null; ciName: string | null; ownerTeamId: string | null; supportTeamId: string | null }

/** Le misure dalle righe: pure, per i test. */
export function changeUnitsFromRows(assessments: readonly AssessmentRow[], plans: readonly DeployPlanRow[]): OLAChangeUnit[] {
  const units: OLAChangeUnit[] = assessments.map((a) => ({
    kind: 'assessment', key: `assessment:${a.id}`, node: { label: 'AssessmentTask', id: a.id }, alerted: a.alerted,
    ticketId: a.ticketId, ticketNumber: a.ticketNumber, ticketTitle: a.ticketTitle,
    ciName: a.ciName, responderRole: a.responderRole, stepTitle: null,
    createdAt: a.createdAt, concludedAt: a.concludedAt, currentTeamId: a.currentTeamId, segments: a.segments,
  }))
  for (const p of plans) {
    const steps = parseDeploySteps(p.steps)
    steps.forEach((step, i) => {
      const both = [
        { kind: 'validation' as const, startsAt: step.validationWindow.start, concludedAt: p.testedAt, teamId: p.ownerTeamId },
        { kind: 'release' as const, startsAt: step.releaseWindow.start, concludedAt: p.deployedAt, teamId: p.supportTeamId },
      ]
      for (const m of both) {
        // Una finestra non ancora pianificata non misura niente.
        if (!m.startsAt) continue
        units.push({
          kind: m.kind, key: `${m.kind}:${p.id}:${i}`, node: { label: 'DeployPlanTask', id: p.id }, alerted: p.alerted,
          ticketId: p.ticketId, ticketNumber: p.ticketNumber, ticketTitle: p.ticketTitle,
          ciName: p.ciName, responderRole: null, stepTitle: step.title || null,
          createdAt: p.createdAt, concludedAt: m.concludedAt, startsAt: m.startsAt, currentTeamId: m.teamId,
          // Il team è quello del CI (chi può registrare il test o segnare il deployment): il suo tratto va dalla nascita del piano.
          segments: m.teamId ? [{ teamId: m.teamId, startedAt: p.createdAt, endedAt: null, inferred: false }] : [],
        })
      }
    })
  }
  return units
}

export async function loadChangeUnits(session: Queryable, tenantId: string, scope: ChangeUnitScope): Promise<OLAChangeUnit[]> {
  const params: Record<string, unknown> = { tenantId }
  if (scope.by === 'change') params['changeId'] = scope.changeId
  if (scope.by === 'concluded') { params['cutoff'] = scope.cutoff; params['teamId'] = scope.teamId }
  if (scope.by === 'open') params['teamId'] = scope.teamId
  const [assessments, plans] = [
    await runQuery<AssessmentRow>(session, assessmentUnitsCypher(scope.by), params),
    await runQuery<DeployPlanRow>(session, deployPlanUnitsCypher(scope.by), params),
  ]
  let units = changeUnitsFromRows(assessments, plans)
  if (scope.by === 'concluded') units = units.filter((u) => u.concludedAt !== null && u.concludedAt >= scope.cutoff)
  if (scope.by === 'open') units = units.filter((u) => u.concludedAt === null && u.currentTeamId === scope.teamId)
  return units
}
