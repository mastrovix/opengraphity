import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'

interface EnumTypeDef {
  id:        string
  tenantId:  string
  name:      string
  label:     string
  values:    string[]
  isSystem:  boolean
  /** `tenant_id = 'system'`: spedito col prodotto, uguale per tutti i clienti. */
  isShipped: boolean
  scope:     string
  createdAt: string
  updatedAt: string
}

function mapEnum(r: { get: (k: string) => unknown }): EnumTypeDef {
  const vals     = r.get('values')
  const tenantId = r.get('tenantId') as string
  return {
    id:        r.get('id')        as string,
    tenantId,
    name:      r.get('name')      as string,
    label:     r.get('label')     as string,
    values:    Array.isArray(vals) ? vals as string[] : JSON.parse(vals as string) as string[],
    isSystem:  r.get('isSystem')  as boolean,
    // `is_system` è un flag di protezione scritto anche sulle copie per tenant
    // (A-3): il proprietario si legge dal tenant, non da quel flag.
    isShipped: tenantId === SYSTEM_TENANT,
    scope:     r.get('scope')     as string,
    createdAt: r.get('createdAt') as string,
    updatedAt: r.get('updatedAt') as string,
  }
}

export async function enumTypes(
  _: unknown,
  args: { scope?: string },
  ctx: GraphQLContext,
): Promise<EnumTypeDef[]> {
  const session = getSession(undefined, 'READ')
  try {
    // Isolamento (A-3/D-5): `is_system` è un flag di PROTEZIONE scritto sugli
    // enum seminati in OGNI tenant, non un flag di visibilità. Il predicato
    // storico (`OR e.is_system = true`) mostrava quindi a ogni tenant i
    // vocabolari di tutti gli altri. Visibile = il proprio tenant, oppure il
    // tenant condiviso `system`.
    const conditions = ['(e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = \'system\'))']
    const params: Record<string, unknown> = { tenantId: ctx.tenantId }
    if (args.scope) {
      conditions.push('(e.scope = $scope OR e.scope = "shared")')
      params['scope'] = args.scope
    }
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition)
        WHERE ${conditions.join(' AND ')}
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
        ORDER BY e.scope, e.name
      `, params),
    )
    return result.records.map(mapEnum)
  } finally {
    await session.close()
  }
}

export async function enumType(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<EnumTypeDef | null> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
      `, { id: args.id, tenantId: ctx.tenantId }),
    )
    return result.records.length ? mapEnum(result.records[0]) : null
  } finally {
    await session.close()
  }
}

export async function createEnumType(
  _: unknown,
  args: { input: { name: string; label: string; values: string[]; scope: string } },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  if (ctx.role !== 'admin') throw new ForbiddenError()
  const { input } = args
  if (!input.name.match(/^[a-z][a-z0-9_]*$/)) {
    throw new ValidationError('name must be snake_case (lowercase letters, numbers, underscores)')
  }
  if (input.values.length === 0) {
    throw new ValidationError('values must contain at least one entry')
  }
  const VALID_SCOPES = ['itil', 'cmdb', 'shared'] as const
  if (!VALID_SCOPES.includes(input.scope as typeof VALID_SCOPES[number])) {
    throw new ValidationError(`scope must be one of: ${VALID_SCOPES.join(', ')}`)
  }

  const id  = uuidv4()
  const now = new Date().toISOString()

  const session = getSession(undefined, 'WRITE')
  try {
    // Check uniqueness per tenant
    const existing = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {name: $name, tenant_id: $tenantId})
        RETURN e.id AS id LIMIT 1
      `, { name: input.name, tenantId: ctx.tenantId }),
    )
    if (existing.records.length) {
      throw new ValidationError(`An enum type named "${input.name}" already exists for this tenant`)
    }

    await session.executeWrite((tx) =>
      tx.run(`
        CREATE (e:EnumTypeDefinition {
          id:         $id,
          tenant_id:  $tenantId,
          name:       $name,
          label:      $label,
          values:     $values,
          is_system:  false,
          scope:      $scope,
          created_at: $now,
          updated_at: $now
        })
      `, { id, tenantId: ctx.tenantId, name: input.name, label: input.label, values: input.values, scope: input.scope, now }),
    )

    void audit(ctx, 'enum_type.created', 'EnumTypeDefinition', id, { name: input.name })

    return {
      id, tenantId: ctx.tenantId, name: input.name, label: input.label,
      values: input.values, isSystem: false, isShipped: false, scope: input.scope,
      createdAt: now, updatedAt: now,
    }
  } finally {
    await session.close()
  }
}

/**
 * «Personalizza» un vocabolario spedito col prodotto: copia su scrittura.
 *
 * Un vocabolario `tenant_id = 'system'` è UN nodo per tutti i clienti, quindi
 * non si modifica in posto (`updateEnumType` scrive solo su
 * `{id, tenant_id: $tenantId}` e fallirebbe). La personalizzazione è una copia
 * con lo STESSO nome sul tenant: `loadTenantEnumOverrides` la fa vincere in
 * lettura per chi la possiede, e solo per lui (lib/enumScope.ts).
 *
 * Se il tenant ha già un vocabolario con quel nome la copia non si fa: sarebbe
 * un doppione e la sua sarebbe comunque già quella che vince. L'errore lo dice.
 */
export async function customizeEnumType(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  if (ctx.role !== 'admin') throw new ForbiddenError()
  if (ctx.tenantId === SYSTEM_TENANT) {
    throw new ValidationError('Il tenant di sistema non personalizza i vocabolari spediti: li modifica il prodotto.')
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const src = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id IN [$tenantId, $systemTenant]
        RETURN e.tenant_id AS tenantId, e.name AS name, e.label AS label,
               e.values AS values, e.scope AS scope
      `, { id: args.id, tenantId: ctx.tenantId, systemTenant: SYSTEM_TENANT }),
    )
    if (!src.records.length) throw new NotFoundError('EnumTypeDefinition', args.id)

    const row       = src.records[0]!
    const ownerId   = row.get('tenantId') as string
    const name      = row.get('name')     as string
    const rawValues = row.get('values')
    const values    = Array.isArray(rawValues) ? rawValues as string[] : JSON.parse(rawValues as string) as string[]

    if (ownerId !== SYSTEM_TENANT) {
      throw new ValidationError(
        `Il vocabolario "${name}" è già tuo: modificalo direttamente, non c'è niente da personalizzare.`,
      )
    }

    const existing = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {name: $name, tenant_id: $tenantId})
        RETURN e.id AS id LIMIT 1
      `, { name, tenantId: ctx.tenantId }),
    )
    if (existing.records.length) {
      throw new ValidationError(
        `Hai già un vocabolario "${name}" (${existing.records[0]!.get('id') as string}): è quello che vince in lettura per te. ` +
        `Modifica quello invece di crearne un altro.`,
      )
    }

    const id  = uuidv4()
    const now = new Date().toISOString()
    const created = await session.executeWrite((tx) =>
      tx.run(`
        CREATE (e:EnumTypeDefinition {
          id:         $id,
          tenant_id:  $tenantId,
          name:       $name,
          label:      $label,
          values:     $values,
          is_system:  false,
          scope:      $scope,
          created_at: $now,
          updated_at: $now
        })
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
      `, {
        id, tenantId: ctx.tenantId, name,
        label: row.get('label') as string, values,
        scope: row.get('scope') as string, now,
      }),
    )
    if (!created.records.length) throw new Error(`customizeEnumType("${name}"): la CREATE non ha restituito il nodo`)

    void audit(ctx, 'enum_type.customized', 'EnumTypeDefinition', id, { name, shippedId: args.id })
    return mapEnum(created.records[0]!)
  } finally {
    await session.close()
  }
}

export async function updateEnumType(
  _: unknown,
  args: { id: string; input: { label?: string; values?: string[]; scope?: string } },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  if (ctx.role !== 'admin') throw new ForbiddenError()
  const { id, input } = args

  const session = getSession(undefined, 'WRITE')
  try {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
        RETURN e.is_system AS isSystem, e.tenant_id AS tenantId, e.name AS name
      `, { id, tenantId: ctx.tenantId }),
    )
    if (!check.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    const isSystem = check.records[0]!.get('isSystem') as boolean

    // A1-1: un vocabolario spedito è UN nodo per tutti i clienti. La scrittura
    // (`{id, tenant_id: $tenantId}`) non lo trovava e finiva in un NotFound
    // opaco: adesso dice qual è la strada — `customizeEnumType` ne crea la
    // copia del tenant, che vince in lettura solo per chi la possiede.
    if ((check.records[0]!.get('tenantId') as string) === SYSTEM_TENANT) {
      throw new ValidationError(
        `Il vocabolario "${check.records[0]!.get('name') as string}" è spedito col prodotto: è lo stesso per tutti i clienti ` +
        `e non si modifica in posto. Usa "Personalizza" (customizeEnumType) per averne una copia tua e modificare quella.`,
      )
    }

    if (isSystem && input.scope) {
      throw new ValidationError('Cannot change scope of system enum types')
    }

    const now = new Date().toISOString()
    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        SET e.label      = coalesce($label, e.label),
            e.values     = coalesce($values, e.values),
            e.scope      = CASE WHEN $scope IS NOT NULL AND NOT e.is_system THEN $scope ELSE e.scope END,
            e.updated_at = $now
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
      `, {
        id,
        tenantId: ctx.tenantId,
        label:  input.label  ?? null,
        values: input.values ?? null,
        scope:  input.scope  ?? null,
        now,
      }),
    )

    if (!result.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    void audit(ctx, 'enum_type.updated', 'EnumTypeDefinition', id, { label: input.label })
    return mapEnum(result.records[0])
  } finally {
    await session.close()
  }
}

export async function deleteEnumType(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<boolean> {
  if (ctx.role !== 'admin') throw new ForbiddenError()

  const session = getSession(undefined, 'WRITE')
  try {
    // Check exists + not system
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        // Qui si CONTA chi usa il vocabolario del tenant prima di cancellarlo,
        // e vanno contati anche i campi condivisi che ci fossero agganciati (è
        // il caso che l'ondata 1 chiude): filtrare i campi per tenant farebbe
        // cancellare un vocabolario ancora in uso.
        // tenant-ok: il vocabolario e è già vincolato a $tenantId dal MATCH sopra.
        OPTIONAL MATCH (f:CIFieldDefinition)-[:USES_ENUM]->(e)
        RETURN e.is_system AS isSystem, count(f) AS usageCount
      `, { id: args.id, tenantId: ctx.tenantId }),
    )
    if (!check.records.length) throw new NotFoundError('EnumTypeDefinition', args.id)
    const isSystem   = check.records[0]!.get('isSystem') as boolean
    const usageCount = (check.records[0]!.get('usageCount') as { toNumber(): number }).toNumber()

    if (isSystem) {
      throw new ValidationError('System enum types cannot be deleted')
    }
    if (usageCount > 0) {
      throw new ValidationError(`Enum in use by ${usageCount} field${usageCount > 1 ? 's' : ''}`)
    }

    await session.executeWrite((tx) =>
      tx.run(`MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId}) DETACH DELETE e`,
        { id: args.id, tenantId: ctx.tenantId }),
    )

    void audit(ctx, 'enum_type.deleted', 'EnumTypeDefinition', args.id)
    return true
  } finally {
    await session.close()
  }
}

export const enumTypeResolvers = {
  Query:    { enumTypes, enumType },
  Mutation: { createEnumType, updateEnumType, deleteEnumType, customizeEnumType },
}
