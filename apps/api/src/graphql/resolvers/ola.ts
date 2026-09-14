import { v4 as uuidv4 } from 'uuid'
import { assertComplianceObjective, calendarChoice, calendarNameOf } from '../../lib/serviceTargets.js'
import { runQuery, runQueryOne, toNumber, type Queryable } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { requireRole } from '../../lib/requireRole.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import type { TeamSourcing } from '../../lib/teamSourcing.js'

type Props = Record<string, unknown>

function toNum(v: unknown): number | null {
  return v == null ? null : toNumber(v)
}

const VALID_TYPES = ['ola', 'uc']
const VALID_ENTITY_TYPES = ['incident', 'problem', 'change', 'service_request', 'any']

// Resolved-timestamp field per entity type — used by the attainment calc.
const RESOLVED_FIELD: Record<string, { label: string; resolvedField: string }> = {
  incident:        { label: 'Incident',        resolvedField: 'resolved_at' },
  problem:         { label: 'Problem',         resolvedField: 'resolved_at' },
  service_request: { label: 'ServiceRequest',  resolvedField: 'completed_at' },
  change:          { label: 'Change',          resolvedField: 'completed_at' },
}

function mapOLA(p: Props, teamName: string | null) {
  return {
    id:              p['id']              as string,
    type:            p['type']            as string,
    name:            p['name']            as string,
    description:     (p['description']     ?? null) as string | null,
    entityType:      p['entity_type']     as string,
    responseMinutes: toNumber(p['response_minutes']),
    resolveMinutes:  toNumber(p['resolve_minutes']),
    businessHours:   (p['business_hours']  ?? false) as boolean,
    calendarId:      (p['calendar_id']     ?? null) as string | null,
    complianceTarget:  p['compliance_target']  == null ? null : Number(p['compliance_target']),
    complianceWarning: p['compliance_warning'] == null ? null : Number(p['compliance_warning']),
    partyType:       (p['party_type']      ?? null) as string | null,
    partyName:       (p['party_name']      ?? null) as string | null,
    teamId:          (p['team_id']         ?? null) as string | null,
    teamName,
    enabled:         (p['enabled']         ?? true) as boolean,
    createdAt:       p['created_at']       as string,
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function olaContracts(_: unknown, args: { type?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; teamName: string | null }>(session, `
      MATCH (o:OLAContract {tenant_id: $tenantId})
      ${args.type ? 'WHERE o.type = $type' : ''}
      OPTIONAL MATCH (t:Team {id: o.team_id, tenant_id: $tenantId})
      RETURN properties(o) AS props, t.name AS teamName
      ORDER BY o.type, o.name
    `, { tenantId: ctx.tenantId, type: args.type ?? null })
    return rows.map((r) => mapOLA(r.props, r.teamName))
  })
}

// ── SLA Report ────────────────────────────────────────────────────────────────

interface SLAPriorityRow { priority: string; total: number; met: number; breached: number }

export async function slaReport(_: unknown, args: { windowDays?: number }, ctx: GraphQLContext) {
  const windowDays = Math.min(365, Math.max(1, args.windowDays ?? 30))
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60_000).toISOString()

  return withSession(async (session) => {
    // ── SLA compliance over SLAStatus nodes started within the window ──────────
    // Semantics (packages/sla markResolveMet): resolve_met = resolved within the
    // deadline; breached = deadline elapsed unresolved, never cleared by a late
    // resolution. So met and breached are mutually exclusive and a ticket
    // resolved after the breach counts as breached, not met (D-02). A closed
    // SLA (resolved_at set) is never "paused"/"open on track".
    const complianceRows = await runQuery<Props>(session, `
      MATCH (e {tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      WHERE (e:Incident OR e:Problem OR e:ServiceRequest) AND s.started_at >= $cutoff
      WITH s,
        CASE WHEN s.resolve_met = true THEN 1 ELSE 0 END AS met,
        CASE WHEN s.breached = true AND coalesce(s.resolve_met, false) = false THEN 1 ELSE 0 END AS breached,
        CASE WHEN s.paused_at IS NOT NULL AND s.resolved_at IS NULL AND coalesce(s.resolve_met, false) = false
             AND coalesce(s.breached, false) = false THEN 1 ELSE 0 END AS paused
      RETURN
        count(s)                        AS total,
        sum(met)                        AS met,
        sum(breached)                   AS breached,
        sum(paused)                     AS paused
    `, { tenantId: ctx.tenantId, cutoff })

    const c = complianceRows[0] ?? {}
    const total    = toNumber(c['total'])
    const met      = toNumber(c['met'])
    const breached = toNumber(c['breached'])
    const paused   = toNumber(c['paused'])
    // met/breached/paused are disjoint by construction, so the remainder is
    // exactly the open, unpaused, not-yet-breached SLAs.
    const openOnTrack = Math.max(0, total - met - breached - paused)
    const concluded   = met + breached
    const breachRate  = concluded > 0 ? (breached / concluded) * 100 : 0

    // ── By priority (SLA tier severity) ───────────────────────────────────────
    const byPriorityRows = await runQuery<Props>(session, `
      MATCH (e {tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      WHERE (e:Incident OR e:Problem OR e:ServiceRequest) AND s.started_at >= $cutoff
      WITH coalesce(s.tier_severity, 'unknown') AS priority,
        CASE WHEN s.resolve_met = true THEN 1 ELSE 0 END AS met,
        CASE WHEN s.breached = true AND coalesce(s.resolve_met, false) = false THEN 1 ELSE 0 END AS breached
      RETURN priority, count(*) AS total, sum(met) AS met, sum(breached) AS breached
      ORDER BY total DESC
    `, { tenantId: ctx.tenantId, cutoff })

    const byPriority: SLAPriorityRow[] = byPriorityRows.map((r) => ({
      priority: r['priority'] as string,
      total:    toNumber(r['total']),
      met:      toNumber(r['met']),
      breached: toNumber(r['breached']),
    }))

    // ── By policy ─────────────────────────────────────────────────────────────
    // Ogni SLA registra da quale policy è nato (`policy_id`, `policy_name`), o
    // quale regola l'ha impostato (`set_by_rule`). Il nome si legge dalla policy
    // viva, così una rinomina si vede; se la policy non c'è più resta quello
    // registrato alla creazione. Gli SLA creati prima di questi campi non hanno
    // origine: finiscono in una riga loro, non vengono attribuiti a indovinare.
    const byPolicyRows = await runQuery<Props>(session, `
      MATCH (e {tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      WHERE (e:Incident OR e:Problem OR e:ServiceRequest) AND s.started_at >= $cutoff
      OPTIONAL MATCH (p:SLAPolicyNode {id: s.policy_id, tenant_id: $tenantId})
      WITH s.policy_id AS policyId,
        coalesce(p.name, s.policy_name) AS policyName,
        s.set_by_rule AS setByRule,
        p.entity_type AS entityType,
        p.response_minutes AS responseMinutes,
        p.resolve_minutes AS resolveMinutes,
        p.compliance_target AS complianceTarget, p.compliance_warning AS complianceWarning,
        CASE WHEN s.resolve_met = true THEN 1 ELSE 0 END AS met,
        CASE WHEN s.breached = true AND coalesce(s.resolve_met, false) = false THEN 1 ELSE 0 END AS breached,
        CASE WHEN s.paused_at IS NOT NULL AND s.resolved_at IS NULL AND coalesce(s.resolve_met, false) = false
             AND coalesce(s.breached, false) = false THEN 1 ELSE 0 END AS paused
      RETURN policyId, policyName, setByRule, entityType, responseMinutes, resolveMinutes, complianceTarget, complianceWarning,
        count(*) AS total, sum(met) AS met, sum(breached) AS breached, sum(paused) AS paused
      ORDER BY total DESC
    `, { tenantId: ctx.tenantId, cutoff })

    const byPolicy = byPolicyRows.map((r) => ({
      policyId:        (r['policyId']   ?? null) as string | null,
      policyName:      (r['policyName'] ?? null) as string | null,
      setByRule:       (r['setByRule']  ?? null) as string | null,
      entityType:      (r['entityType'] ?? null) as string | null,
      responseMinutes: r['responseMinutes'] == null ? null : toNumber(r['responseMinutes']),
      resolveMinutes:  r['resolveMinutes']  == null ? null : toNumber(r['resolveMinutes']),
      complianceTarget:  r['complianceTarget']  == null ? null : Number(r['complianceTarget']),
      complianceWarning: r['complianceWarning'] == null ? null : Number(r['complianceWarning']),
      total:    toNumber(r['total']),
      met:      toNumber(r['met']),
      breached: toNumber(r['breached']),
      paused:   toNumber(r['paused']),
    }))

    // ── Average resolution time (incidents resolved within the window) ─────────
    const avgRows = await runQuery<Props>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      WHERE i.resolved_at IS NOT NULL AND i.resolved_at >= $cutoff AND i.created_at IS NOT NULL
      WITH duration.inSeconds(datetime(i.created_at), datetime(i.resolved_at)).seconds AS secs
      RETURN avg(secs / 60.0) AS avgMinutes
    `, { tenantId: ctx.tenantId, cutoff })
    const avgResolutionMinutes = toNum(avgRows[0]?.['avgMinutes'])

    // ── OLA/UC attainment per contract ────────────────────────────────────────
    const contracts = await runQuery<Props>(session, `
      MATCH (o:OLAContract {tenant_id: $tenantId})
      WHERE coalesce(o.enabled, true) = true
      RETURN properties(o) AS props
      ORDER BY o.type, o.name
    `, { tenantId: ctx.tenantId })

    const ola = []
    for (const row of contracts) {
      const o = row['props'] as Props
      const entityType = (o['entity_type'] as string) || 'incident'
      const mapping = RESOLVED_FIELD[entityType === 'any' ? 'incident' : entityType]
      const resolveMinutes = toNumber(o['resolve_minutes'])

      let evaluated = 0, cMet = 0, cBreached = 0
      if (mapping) {
        const attRows = await runQuery<Props>(session, `
          MATCH (e:${mapping.label} {tenant_id: $tenantId})
          WHERE e.${mapping.resolvedField} IS NOT NULL AND e.${mapping.resolvedField} >= $cutoff AND e.created_at IS NOT NULL
          WITH duration.inSeconds(datetime(e.created_at), datetime(e.${mapping.resolvedField})).seconds AS secs
          WITH (secs / 60.0) AS mins
          RETURN count(*) AS evaluated,
                 sum(CASE WHEN mins <= $resolveMinutes THEN 1 ELSE 0 END) AS met,
                 sum(CASE WHEN mins >  $resolveMinutes THEN 1 ELSE 0 END) AS breached
        `, { tenantId: ctx.tenantId, cutoff, resolveMinutes })
        evaluated = toNumber(attRows[0]?.['evaluated'])
        cMet      = toNumber(attRows[0]?.['met'])
        cBreached = toNumber(attRows[0]?.['breached'])
      }

      ola.push({
        id:             o['id']            as string,
        type:           o['type']          as string,
        name:           o['name']          as string,
        entityType,
        partyType:      (o['party_type']    ?? null) as string | null,
        partyName:      (o['party_name']    ?? null) as string | null,
        resolveMinutes,
        evaluated,
        met:            cMet,
        breached:       cBreached,
        attainmentPct:  evaluated > 0 ? (cMet / evaluated) * 100 : null,
        complianceTarget:  o['compliance_target']  == null ? null : Number(o['compliance_target']),
        complianceWarning: o['compliance_warning'] == null ? null : Number(o['compliance_warning']),
      })
    }

    return {
      generatedAt: new Date().toISOString(),
      windowDays,
      sla: { total, met, breached, paused, openOnTrack, breachRate, avgResolutionMinutes, byPriority, byPolicy },
      ola,
    }
  })
}

// ── Mutations ─────────────────────────────────────────────────────────────────

interface OLAInput {
  type?: string; name?: string; description?: string; entityType?: string
  responseMinutes?: number; resolveMinutes?: number; calendarId?: string | null
  complianceTarget?: number; complianceWarning?: number
  partyType?: string; teamId?: string; enabled?: boolean
}

/**
 * CHI È IL RESPONSABILE: sempre un TEAM, e il suo Sourcing deve tornare.
 *
 * Com'era: per un OLA il responsabile era un team scelto (`team_id`), per un
 * fornitore esterno un NOME scritto a mano (`party_name`). Da quando ogni team
 * dice se è interno o esterno (`Team.sourcing`), anche il fornitore è un team —
 * un team con Sourcing = External — e il nome scritto a mano non serve più:
 * permetteva un fornitore con un refuso, due fornitori dove ce n'è uno, e un
 * nome che non si aggiornava mai.
 *
 *   partyType `team`     → un team con sourcing = `internal`
 *   partyType `supplier` → un team con sourcing = `external`
 *
 * Il contratto cita il team per `team_id`, e il nome lo risolve la lettura
 * (`teamName`). Un team il cui Sourcing non torna è un rifiuto che dice quale
 * serviva e quale ha: la tendina filtra già, ma la tendina è una comodità e il
 * rifiuto è la garanzia (l'API è una strada documentata, usata da script e
 * integrazioni). Un team che non dice ancora da dove viene (sourcing null) è
 * rifiutato allo stesso modo: non si indovina.
 */
const SOURCING_PER_RESPONSABILE: Readonly<Record<string, TeamSourcing>> = {
  team:     'internal',
  supplier: 'external',
}

async function assertResponsabile(
  session: Queryable, tenantId: string, partyType: string | null | undefined,
  teamId: string | null | undefined,
): Promise<void> {
  if (partyType == null) return
  const atteso = SOURCING_PER_RESPONSABILE[partyType]
  if (!atteso) {
    throw new ValidationError(`partyType must be one of: ${Object.keys(SOURCING_PER_RESPONSABILE).join(', ')}`,
      { key: 'errors.ola.partyTypeOneOf', params: { allowed: Object.keys(SOURCING_PER_RESPONSABILE).join(', ') } })
  }
  if (!teamId?.trim()) {
    throw new ValidationError(
      `teamId is required: the responsible party is a team with sourcing = ${atteso}`,
      { key: atteso === 'internal' ? 'errors.ola.teamRequired' : 'errors.ola.supplierTeamRequired' },
    )
  }
  const row = await runQueryOne<{ name: string; sourcing: string | null }>(session, `
    MATCH (t:Team {id: $teamId, tenant_id: $tenantId}) RETURN t.name AS name, t.sourcing AS sourcing
  `, { teamId, tenantId })
  if (!row) throw new ValidationError(`Team ${teamId} does not exist in this tenant`, { key: 'errors.ola.teamUnknown', params: { team: teamId } })
  if (row.sourcing !== atteso) {
    throw new ValidationError(
      `Team "${row.name}" has sourcing ${row.sourcing ?? 'not set'}, but this responsible party needs a team with sourcing = ${atteso}`,
      {
        key: 'errors.ola.teamWrongSourcing',
        params: {
          team: row.name,
          expectedKey: `pages.teams.sourcing.${atteso}`,
          actualKey: row.sourcing === 'internal' || row.sourcing === 'external'
            ? `pages.teams.sourcing.${row.sourcing}` : 'pages.teams.sourcing.notSet',
        },
      },
    )
  }
}

export async function createOLAContract(_: unknown, args: { input: OLAInput }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const { input } = args
  if (!VALID_TYPES.includes(input.type ?? '')) throw new ValidationError(`type must be one of: ${VALID_TYPES.join(', ')}`, { key: 'errors.ola.typeOneOf', params: { allowed: VALID_TYPES.join(', ') } })
  if (!VALID_ENTITY_TYPES.includes(input.entityType ?? '')) throw new ValidationError(`entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}`, { key: 'errors.ola.entityTypeOneOf', params: { allowed: VALID_ENTITY_TYPES.join(', ') } })
  const name = input.name?.trim()
  if (!name) throw new ValidationError('name is required', { key: 'errors.ola.nameRequired' })
  if (!input.responseMinutes || input.responseMinutes <= 0) throw new ValidationError('responseMinutes must be > 0', { key: 'errors.ola.responseMinutes' })
  if (!input.resolveMinutes || input.resolveMinutes <= 0) throw new ValidationError('resolveMinutes must be > 0', { key: 'errors.ola.resolveMinutes' })

  const objective = assertComplianceObjective(input.complianceTarget, input.complianceWarning)
  const calendar = await calendarChoice(ctx.tenantId, input.calendarId)
  const id = uuidv4(); const now = new Date().toISOString()
  return withSession(async (session) => {
    await assertResponsabile(session, ctx.tenantId, input.partyType ?? 'team', input.teamId)
    const rows = await runQuery<{ props: Props; teamName: string | null }>(session, `
      CREATE (o:OLAContract {
        id: $id, tenant_id: $tenantId, type: $type, name: $name, description: $description,
        entity_type: $entityType, response_minutes: $responseMinutes, resolve_minutes: $resolveMinutes,
        business_hours: $businessHours, calendar_id: $calendarId, party_type: $partyType, party_name: $partyName,
        compliance_target: $complianceTarget, compliance_warning: $complianceWarning,
        team_id: $teamId, enabled: true, created_at: $now
      })
      WITH o
      OPTIONAL MATCH (t:Team {id: o.team_id, tenant_id: $tenantId})
      RETURN properties(o) AS props, t.name AS teamName
    `, {
      id, tenantId: ctx.tenantId, type: input.type, name,
      description: input.description ?? null, entityType: input.entityType,
      responseMinutes: input.responseMinutes, resolveMinutes: input.resolveMinutes,
      businessHours: calendar.business_hours, calendarId: calendar.calendar_id, partyType: input.partyType ?? null,
      complianceTarget: objective.target, complianceWarning: objective.warning,
      // Il responsabile è sempre un team, citato per id: nessun nome copiato
      // sul contratto (lo risolve `teamName` alla lettura).
      partyName: null,
      teamId: input.teamId ?? null, now,
    })
    void audit(ctx, 'ola_contract.created', 'OLAContract', id)
    return mapOLA(rows[0]!.props, rows[0]!.teamName)
  }, true)
}

export async function updateOLAContract(_: unknown, args: { id: string; input: OLAInput }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const { input } = args
  if (input.type !== undefined) throw new ValidationError('type cannot be changed', { key: 'errors.ola.typeImmutable' })
  if (input.entityType !== undefined && !VALID_ENTITY_TYPES.includes(input.entityType)) {
    throw new ValidationError(`entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}`, { key: 'errors.ola.entityTypeOneOf', params: { allowed: VALID_ENTITY_TYPES.join(', ') } })
  }
  const sets: Record<string, unknown> = {}
  if (input.name !== undefined)            sets['name']             = input.name
  if (input.description !== undefined)     sets['description']      = input.description
  if (input.entityType !== undefined)      sets['entity_type']      = input.entityType
  if (input.responseMinutes !== undefined) sets['response_minutes'] = input.responseMinutes
  if (input.resolveMinutes !== undefined)  sets['resolve_minutes']  = input.resolveMinutes
  if (input.calendarId !== undefined) Object.assign(sets, await calendarChoice(ctx.tenantId, input.calendarId))
  if (input.complianceTarget !== undefined || input.complianceWarning !== undefined) {
    const current = await withSession((session) => runQueryOne<{ target: unknown; warning: unknown }>(session,
      'MATCH (o:OLAContract {id: $id, tenant_id: $tenantId}) RETURN o.compliance_target AS target, o.compliance_warning AS warning',
      { id: args.id, tenantId: ctx.tenantId }))
    const objective = assertComplianceObjective(input.complianceTarget ?? current?.target, input.complianceWarning ?? current?.warning)
    sets['compliance_target'] = objective.target
    sets['compliance_warning'] = objective.warning
  }
  if (input.partyType !== undefined)       sets['party_type']       = input.partyType
  if (input.teamId !== undefined)          sets['team_id']          = input.teamId
  if (input.enabled !== undefined)         sets['enabled']          = input.enabled
  if (Object.keys(sets).length === 0) throw new ValidationError('updateOLAContract: no field to update', { key: 'errors.nothingToUpdate' })

  return withSession(async (session) => {
    /*
      Il responsabile si valida sullo stato FINALE, non su quello che arriva:
      una modifica può cambiare solo il tipo (team → fornitore) e lasciare
      fuori l'altra metà, e allora la metà che conta è quella già salvata.
    */
    if (input.partyType !== undefined || input.teamId !== undefined) {
      const attuale = await runQueryOne<{ partyType: string | null; teamId: string | null }>(session, `
        MATCH (o:OLAContract {id: $id, tenant_id: $tenantId})
        RETURN o.party_type AS partyType, o.team_id AS teamId
      `, { id: args.id, tenantId: ctx.tenantId })
      if (!attuale) throw new NotFoundError('OLAContract', args.id)
      const partyType = input.partyType ?? attuale.partyType
      // Cambiare il TIPO di responsabile senza cambiare il team non basta: il
      // team di prima ha il Sourcing sbagliato, e il controllo lo dice.
      const teamId    = input.teamId    ?? attuale.teamId
      await assertResponsabile(session, ctx.tenantId, partyType, teamId)
      sets['team_id'] = teamId
      sets['party_name'] = null
    }
    const rows = await runQuery<{ props: Props; teamName: string | null }>(session, `
      MATCH (o:OLAContract {id: $id, tenant_id: $tenantId})
      SET o += $sets
      WITH o
      OPTIONAL MATCH (t:Team {id: o.team_id, tenant_id: $tenantId})
      RETURN properties(o) AS props, t.name AS teamName
    `, { id: args.id, tenantId: ctx.tenantId, sets })
    if (!rows[0]) throw new NotFoundError('OLAContract', args.id)
    void audit(ctx, 'ola_contract.updated', 'OLAContract', args.id)
    return mapOLA(rows[0].props, rows[0].teamName)
  }, true)
}

/** Il nome del calendario del contratto (ondata 2), letto dal calendario vivo. */
async function olaContractCalendarName(parent: { calendarId: string | null }, _: unknown, ctx: GraphQLContext) {
  return calendarNameOf(ctx.tenantId, parent.calendarId)
}

export const olaResolvers = {
  Query:    { olaContracts, slaReport },
  Mutation: { createOLAContract, updateOLAContract },
  OLAContract: { calendarName: olaContractCalendarName },
}
