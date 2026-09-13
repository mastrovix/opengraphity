import { GraphQLError } from 'graphql'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { assertDomainValue } from '../../lib/domainMatrix.js'
import { TEAM_TYPE_VOCABULARY } from '../../lib/teamVocabularies.js'
import { assertTeamSourcing } from '../../lib/teamSourcing.js'
import { v4 as uuidv4 } from 'uuid'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { mapCI, ciTypeFromLabels, withSession } from './ci-utils.js'
import { ciLabelPredicateForTenant } from '../../lib/ciLabelsForTenant.js'
import type { GraphQLContext } from '../../context.js'
import { mapTeam } from '../../lib/mappers.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { audit } from '../../lib/audit.js'

type Props = Record<string, unknown>


// ── Query resolvers ──────────────────────────────────────────────────────────

// `type` c'era nel filtro della pagina ma NON qui: il filtro si applicava e
// non filtrava niente. E' un valore del vocabolario `team_type`.
const TEAM_ALLOWED_FIELDS = new Set(['name', 'type', 'sourcing', 'createdAt'])

async function teams(_: unknown, args: { filters?: string; sortField?: string; sortDirection?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const params: Record<string, unknown> = { tenantId: ctx.tenantId }
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, TEAM_ALLOWED_FIELDS, 't') : ''
    const sortMap: Record<string, string> = { name: 't.name', type: 't.type', createdAt: 't.created_at' }
    const orderBy = sortMap[args.sortField ?? ''] ?? 't.name'
    const orderDir = args.sortDirection === 'desc' ? 'DESC' : 'ASC'
    // Prefetch members / owned+supported CIs / manager with pattern
    // comprehensions: one query, no per-team N+1 and no cartesian blow-up
    // (each comprehension returns an independent list).
    const cypher = `
      MATCH (t:Team {tenant_id: $tenantId})
      ${advWhere ? `WHERE ${advWhere}` : ''}
      RETURN properties(t) as props,
        [ (t)<-[:MEMBER_OF]-(m:User) | properties(m) ] as members,
        [ (t)<-[:OWNED_BY]-(oci) WHERE oci.tenant_id = $tenantId | { props: properties(oci), label: head([l IN labels(oci) WHERE l <> 'ConfigurationItem']) } ] as ownedCIs,
        [ (t)<-[:SUPPORTED_BY]-(sci) WHERE sci.tenant_id = $tenantId | { props: properties(sci), label: head([l IN labels(sci) WHERE l <> 'ConfigurationItem']) } ] as supportedCIs,
        [ (t)-[:MANAGED_BY]->(mgr:User) | properties(mgr) ] as managers
      ORDER BY ${orderBy} ${orderDir}
    `
    const rows = await runQuery<{ props: Props; members: Props[]; ownedCIs: { props: Props; label: string }[]; supportedCIs: { props: Props; label: string }[]; managers: Props[] }>(session, cypher, params)
    const mapCIRow = (c: { props: Props; label: string }) => { c.props['type'] = ciTypeFromLabels(ctx.tenantId, [c.label]); return mapCI(c.props) }
    return rows.map((r) => ({
      ...mapTeam(r.props),
      _members:       r.members,
      _ownedCIs:      r.ownedCIs.map(mapCIRow),
      _supportedCIs:  r.supportedCIs.map(mapCIRow),
      _manager:       r.managers[0] ?? null,
    }))
  })
}

async function team(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})
      RETURN properties(t) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapTeam(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createTeam(
  _: unknown,
  args: { input: { name: string; description?: string; type?: string | null; sourcing: string } },
  ctx: GraphQLContext,
) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()
  // Ogni team dice se e interno o esterno: senza, e un rifiuto, non un default.
  const sourcing = assertTeamSourcing(input.sourcing)
  // Il tipo e OBBLIGATORIO in creazione (scelta del proprietario) ed e un
  // valore del vocabolario `team_type`, non una parola qualunque: un team con
  // `type: "ownr"` non sarebbe nel filtro ne nella pastiglia. Assente o vuoto
  // e un rifiuto — `assertDomainValue` non accetta un valore mancante, e dice
  // quali sono ammessi.
  const type = await assertDomainValue(ctx.tenantId, TEAM_TYPE_VOCABULARY, input.type)

  return withSession(async (session) => {
    const cypher = `
      CREATE (t:Team {
        id:          $id,
        tenant_id:   $tenantId,
        name:        $name,
        description: $description,
        type:        $type,
        sourcing:    $sourcing,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(t) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id, tenantId: ctx.tenantId, name: input.name, description: input.description ?? null, type, sourcing, now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Failed to create Team', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
    void audit(ctx, 'team.created', 'Team', id)
    return mapTeam(row.props)
  }, true)
}

/**
 * Cambia nome, descrizione o TIPO di un team che esiste.
 *
 * Serviva perche il tipo si poteva solo *guardare*: la colonna c'era, il
 * filtro c'era, e non esisteva nessuna scrittura — i team seminati avevano un
 * tipo, quelli creati dall'interfaccia no, per sempre.
 *
 * Un campo assente non si tocca (`undefined` != `null`): cosi la stessa
 * mutation serve sia «rinomina» sia «dai un tipo» senza azzerare il resto.
 * Per TOGLIERE il tipo si manda la stringa vuota, che e una scelta esplicita.
 */
async function updateTeam(
  _: unknown,
  args: { id: string; input: { name?: string | null; description?: string | null; type?: string | null; sourcing?: string | null } },
  ctx: GraphQLContext,
) {
  const { input } = args
  const sets: string[] = ['t.updated_at = $now']
  const params: Record<string, unknown> = { id: args.id, tenantId: ctx.tenantId, now: new Date().toISOString() }

  if (input.name != null) {
    const name = input.name.trim()
    if (name === '') {
      throw new ValidationError('The team name cannot be empty', { key: 'errors.team.nameEmpty' })
    }
    sets.push('t.name = $name'); params['name'] = name
  }
  if (input.description !== undefined) {
    sets.push('t.description = $description')
    params['description'] = input.description === null || input.description.trim() === '' ? null : input.description.trim()
  }
  // Interno/esterno si CAMBIA ma non si toglie: un team deve dirlo sempre, e
  // `null` o la stringa vuota qui sono un rifiuto, non «non tocco».
  if (input.sourcing !== undefined) {
    sets.push('t.sourcing = $sourcing')
    params['sourcing'] = assertTeamSourcing(input.sourcing)
  }
  // Come Sourcing: si CAMBIA ma non si toglie. Un tipo obbligatorio in
  // creazione che poi si potesse svuotare non sarebbe obbligatorio.
  if (input.type !== undefined) {
    sets.push('t.type = $type')
    params['type'] = await assertDomainValue(ctx.tenantId, TEAM_TYPE_VOCABULARY, input.type)
  }

  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})
      SET ${sets.join(', ')}
      RETURN properties(t) AS props
    `, params)
    if (!row) throw new NotFoundError('Team', args.id)
    void audit(ctx, 'team.updated', 'Team', args.id)
    return mapTeam(row.props)
  }, true)
}

/**
 * Assegna (teamId) o rimuove (teamId null) la relazione single-valued
 * CI→Team di tipo `relType` (OWNED_BY / SUPPORTED_BY).
 */
async function setCITeamRelation(
  relType: 'OWNED_BY' | 'SUPPORTED_BY',
  args: { ciId: string; teamId: string | null },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // Etichette dal metamodello del tenant: con la lista fissa, assegnare un
    // team a un CI di un tipo del cliente non trovava il nodo e rispondeva
    // «ConfigurationItem or Team» (A-9).
    const ciPredicate = await ciLabelPredicateForTenant('ci', ctx.tenantId)
    // The relation is single-valued: drop any existing edge before setting the
    // new one, otherwise re-assigning would leave the CI with multiple owners
    // (breaks change creation, which assumes exactly one owner team).
    const cypher = args.teamId == null
      ? `
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE ${ciPredicate}
      OPTIONAL MATCH (ci)-[old:${relType}]->(:Team)
      DELETE old
      RETURN properties(ci) as props, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label
    `
      : `
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE ${ciPredicate}
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      WITH ci, t
      OPTIONAL MATCH (ci)-[old:${relType}]->(:Team)
      DELETE old
      MERGE (ci)-[:${relType}]->(t)
      RETURN properties(ci) as props, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, {
      ciId: args.ciId, teamId: args.teamId ?? null, tenantId: ctx.tenantId,
    })
    const row = rows[0]
    if (!row) throw new NotFoundError('ConfigurationItem or Team')
    row.props['type'] = ciTypeFromLabels(ctx.tenantId, [row.label])
    return mapCI(row.props)
  }, true)
}

/** teamId null → rimuove l'owner group. */
async function assignCIOwner(
  _: unknown,
  args: { ciId: string; teamId?: string | null },
  ctx: GraphQLContext,
) {
  return setCITeamRelation('OWNED_BY', { ciId: args.ciId, teamId: args.teamId ?? null }, ctx)
}

/** teamId null → rimuove il support group. */
async function assignCISupportGroup(
  _: unknown,
  args: { ciId: string; teamId?: string | null },
  ctx: GraphQLContext,
) {
  return setCITeamRelation('SUPPORTED_BY', { ciId: args.ciId, teamId: args.teamId ?? null }, ctx)
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function teamMembers(parent: { id: string; _members?: Props[] }, _: unknown, ctx: GraphQLContext) {
  if (parent._members) return parent._members
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})<-[:MEMBER_OF]-(u:User)
      RETURN properties(u) as props
      ORDER BY u.name
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => r.props)
  })
}

async function teamOwnedCIs(parent: { id: string; _ownedCIs?: unknown[] }, _: unknown, ctx: GraphQLContext) {
  if (parent._ownedCIs) return parent._ownedCIs
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})<-[:OWNED_BY]-(n)
      WHERE n.tenant_id = $tenantId
      RETURN properties(n) as props, head([l IN labels(n) WHERE l <> 'ConfigurationItem']) AS label
      ORDER BY n.name
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => {
      r.props['type'] = ciTypeFromLabels(ctx.tenantId, [r.label])
      return mapCI(r.props)
    })
  })
}

async function teamSupportedCIs(parent: { id: string; _supportedCIs?: unknown[] }, _: unknown, ctx: GraphQLContext) {
  if (parent._supportedCIs) return parent._supportedCIs
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})<-[:SUPPORTED_BY]-(n)
      WHERE n.tenant_id = $tenantId
      RETURN properties(n) as props, head([l IN labels(n) WHERE l <> 'ConfigurationItem']) AS label
      ORDER BY n.name
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => {
      r.props['type'] = ciTypeFromLabels(ctx.tenantId, [r.label])
      return mapCI(r.props)
    })
  })
}

async function teamManager(parent: { id: string; _manager?: Props | null }, _: unknown, ctx: GraphQLContext) {
  if (parent._manager !== undefined) return parent._manager
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})-[:MANAGED_BY]->(u:User)
      RETURN properties(u) AS props
    `, { id: parent.id, tenantId: ctx.tenantId })
    return row ? row.props : null
  })
}

async function setTeamManager(_: unknown, args: { teamId: string; userId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await session.executeWrite(tx => tx.run(`
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})-[r:MANAGED_BY]->()
      DELETE r
    `, { teamId: args.teamId, tenantId: ctx.tenantId }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (t)-[:MANAGED_BY]->(u)
      RETURN properties(t) AS props
    `, { teamId: args.teamId, userId: args.userId, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('Team or User')
    void audit(ctx, 'team.manager_set', 'Team', args.teamId)
    return mapTeam(row.props)
  }, true)
}

async function removeTeamManager(_: unknown, args: { teamId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await session.executeWrite(tx => tx.run(`
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})-[r:MANAGED_BY]->()
      DELETE r
    `, { teamId: args.teamId, tenantId: ctx.tenantId }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      RETURN properties(t) AS props
    `, { teamId: args.teamId, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('Team')
    void audit(ctx, 'team.manager_removed', 'Team', args.teamId)
    return mapTeam(row.props)
  }, true)
}

async function setChangeManagerTeam(_: unknown, args: { teamId: string; value: boolean }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    // Uno solo per tenant: azzera gli altri quando si designa.
    if (args.value) {
      await session.executeWrite(tx => tx.run(`
        MATCH (t:Team {tenant_id: $tenantId}) WHERE t.id <> $teamId AND t.is_change_manager = true
        SET t.is_change_manager = false
      `, { teamId: args.teamId, tenantId: ctx.tenantId }))
    }
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      SET t.is_change_manager = $value
      RETURN properties(t) AS props
    `, { teamId: args.teamId, tenantId: ctx.tenantId, value: args.value })
    if (!row) throw new NotFoundError('Team', args.teamId)
    // Le change già ferme in "approval" senza requisito CM lo ricevono ora.
    if (args.value) {
      const { backfillChangeManagerApprovals } = await import('./change/approvalCreation.js')
      await backfillChangeManagerApprovals(session, ctx.tenantId, args.teamId)
    }
    void audit(ctx, 'team.change_manager_set', 'Team', args.teamId)
    return mapTeam(row.props)
  }, true)
}

// ── Export ───────────────────────────────────────────────────────────────────

export const teamResolvers = {
  Query:    { teams, team },
  Mutation: { createTeam, updateTeam, assignCIOwner, assignCISupportGroup, setTeamManager, removeTeamManager, setChangeManagerTeam },
  Team: {
    manager:      teamManager,
    members:      teamMembers,
    ownedCIs:     teamOwnedCIs,
    supportedCIs: teamSupportedCIs,
  },
}
