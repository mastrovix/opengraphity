import { withSession } from './ci-utils.js'
import { getSession } from '@opengraphity/neo4j'
import { neo4jDateToISO } from '../../lib/mappers.js'
import { toPascalCase, pluralize } from '@opengraphity/schema-generator'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import { cache } from '../../lib/cache.js'
import { ALLOWED_BASE_FIELDS, ALL_CIS_ALLOWED_FIELDS, ciOrderBy, buildBaseWhere, buildAdvancedWhere } from './buildCIQuery.js'
import { buildFieldResolvers, mapTeamProps } from './ciFieldResolvers.js'
import { buildCreateMutation, buildUpdateMutation, buildDeleteMutation } from './ciMutations.js'

type Props = Record<string, unknown>

// ── mapCI ────────────────────────────────────────────────────────────────────

function mapCI(props: Props, ciType: CITypeWithDefinitions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id:           props['id'],
    name:         props['name'],
    type:         ciType.name,           // CIBase interface uses `type: String!`
    status:       props['status']       ?? null,
    environment:  props['environment']  ?? null,
    description:  props['description']  ?? null,
    createdAt:    neo4jDateToISO(props['created_at']) ?? '',
    updatedAt:    neo4jDateToISO(props['updated_at']),
    notes:        props['notes']        ?? null,
    ownerGroup:   null,  // field resolver
    supportGroup: null,  // field resolver
    dependencies: [],    // field resolver
    dependents:   [],    // field resolver
  }

  for (const field of ciType.fields) {
    if (field.isSystem) continue  // already mapped in base object above (with proper date conversion)
    const snakeKey = toSnakeCase(field.name)
    base[field.name] = props[snakeKey] ?? props[field.name] ?? null
  }

  return base
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

// ── Query generiche ───────────────────────────────────────────────────────────

function buildAllCIsResolver(types: CITypeWithDefinitions[]) {
  return async (
    _: unknown,
    args: { limit?: number; offset?: number; type?: string; status?: string; environment?: string; search?: string; filters?: string },
    ctx: GraphQLContext,
  ) => {
    const { limit = 50, offset = 0, type, status, environment, search, filters } = args
    const filteredTypes = type ? types.filter(t => t.name === type) : types
    if (!filteredTypes.length) return { items: [], total: 0 }

    const labelFilter = filteredTypes.map(t => `n:${t.neo4jLabel}`).join(' OR ')
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      status: status ?? null,
      environment: environment ?? null,
      search: search ?? null,
      limit,
      offset,
    }
    const advWhere = filters ? buildAdvancedWhere(filters, params, ALL_CIS_ALLOWED_FIELDS, 'n') : ''
    const baseFilter = `(${labelFilter}) AND n.tenant_id = $tenantId
           AND ($status IS NULL OR n.status = $status)
           AND ($environment IS NULL OR n.environment = $environment)
           AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
           ${advWhere ? `AND (${advWhere})` : ''}`

    const s1 = getSession(undefined, 'READ')
    const s2 = getSession(undefined, 'READ')
    try {
      const [itemsResult, countResult] = await Promise.all([
        s1.executeRead(tx => tx.run(
          `MATCH (n) WHERE ${baseFilter}
           RETURN properties(n) AS props, labels(n)[0] AS label
           ORDER BY n.name ASC SKIP toInteger($offset) LIMIT toInteger($limit)`,
          params,
        )),
        s2.executeRead(tx => tx.run(
          `MATCH (n) WHERE ${baseFilter}
           RETURN count(n) AS total`,
          params,
        )),
      ])
      await Promise.all([s1.close(), s2.close()])

      return {
        items: itemsResult.records.map(rec => {
          const props = rec.get('props') as Props
          const label = rec.get('label') as string
          const t = types.find(t => t.neo4jLabel === label)
          return t ? mapCI(props, t) : null
        }).filter(Boolean),
        total: (countResult.records[0]?.get('total') as { toNumber(): number })?.toNumber?.() ?? 0,
      }
    } catch (err) {
      await Promise.allSettled([s1.close(), s2.close()])
      throw err
    }
  }
}

function buildCIByIdResolver(types: CITypeWithDefinitions[]) {
  return async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    withSession(async session => {
      const labelFilter = types.map(t => `n:${t.neo4jLabel}`).join(' OR ')
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (n) WHERE (${labelFilter}) AND n.id = $id AND n.tenant_id = $tenantId
           RETURN properties(n) AS props, labels(n)[0] AS label`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
      if (!r.records.length) return null
      const props = r.records[0].get('props') as Props
      const label = r.records[0].get('label') as string
      const t = types.find(t => t.neo4jLabel === label)
      return t ? mapCI(props, t) : null
    })
}

function buildBlastRadiusResolver(types: CITypeWithDefinitions[]) {
  return async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (root {id: $id, tenant_id: $tenantId})
           MATCH path = (root)<-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..5]-(impacted)
           WHERE impacted.tenant_id = $tenantId
           WITH impacted, min(length(path)) AS distance,
             [p IN collect(path) WHERE length(p) = min(length(path)) | p][0] AS shortestPath
           RETURN DISTINCT properties(impacted) AS props, labels(impacted)[0] AS label,
             distance, properties(nodes(shortestPath)[-2]) AS parentProps`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const props = rec.get('props') as Props
        const label = rec.get('label') as string
        const distance = (rec.get('distance') as { toNumber(): number }).toNumber()
        const parentProps = rec.get('parentProps') as Props | null
        const t = types.find(t => t.neo4jLabel === label)
        if (!t) return null
        return { ci: mapCI(props, t), distance, parentId: (parentProps?.['id'] as string | undefined) ?? args.id }
      }).filter(Boolean)
    })
}

// ── ITIL type resolver helpers ────────────────────────────────────────────────

function mapITILField(f: Props, enumRef?: { id: string; name: string; label: string; values: string[] }) {
  return {
    id:               f['id'],
    name:             f['name'],
    label:            f['label'],
    fieldType:        f['field_type'],
    required:         f['required']      ?? false,
    defaultValue:     f['default_value'] ?? null,
    enumValues:       enumRef ? enumRef.values : (f['enum_values'] ? JSON.parse(f['enum_values'] as string) as string[] : []),
    order:            f['order']          ?? 0,
    validationScript: f['validation_script'] ?? null,
    visibilityScript: f['visibility_script'] ?? null,
    defaultScript:    f['default_script']    ?? null,
    isSystem:         f['is_system']          ?? false,
    enumTypeId:       enumRef?.id ?? null,
    enumTypeName:     enumRef?.name ?? null,
  }
}

async function fetchITILTypeById(id: string) {
  return withSession(async session => {
    const r = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition {id: $id})
        WHERE t.scope = 'itil'
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
        OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN t,
          collect(DISTINCT {f: f, enumTypeId: enumDef.id, enumTypeName: enumDef.name, enumTypeLabel: enumDef.label, enumTypeValues: enumDef.values}) AS fieldData,
          collect(DISTINCT rel) AS relations,
          collect(DISTINCT sr)  AS systemRels
      `, { id }),
    )
    if (!r.records.length) throw new GraphQLError('ITIL type non trovato')
    const rec = r.records[0]
    const t = rec.get('t').properties as Props

    type FieldData = { f: { properties: Props } | null; enumTypeId: string | null; enumTypeName: string | null; enumTypeLabel: string | null; enumTypeValues: string[] | null }
    const fieldData = rec.get('fieldData') as FieldData[]
    const fields = fieldData
      .filter(d => d.f)
      .map(d => {
        const enumRef = d.enumTypeId ? {
          id:     d.enumTypeId,
          name:   d.enumTypeName ?? '',
          label:  d.enumTypeLabel ?? '',
          values: d.enumTypeValues ?? [],
        } : undefined
        return mapITILField(d.f!.properties, enumRef)
      })
      .sort((a, b) => (a.order as number) - (b.order as number))

    return {
      id:               t['id'],
      name:             t['name'],
      label:            t['label'],
      icon:             t['icon']  ?? '',
      color:            t['color'] ?? '',
      active:           t['active'] ?? true,
      validationScript: t['validation_script'] ?? null,
      fields,
      relations: (rec.get('relations') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(r => ({
          id:               r!.properties['id'],
          name:             r!.properties['name'],
          label:            r!.properties['label'],
          relationshipType: r!.properties['relationship_type'],
          targetType:       r!.properties['target_type'],
          cardinality:      r!.properties['cardinality'],
          direction:        r!.properties['direction'],
          order:            r!.properties['order'] ?? 0,
        })),
      systemRelations: (rec.get('systemRels') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(sr => ({
          id:               sr!.properties['id'],
          name:             sr!.properties['name'],
          label:            sr!.properties['label'],
          relationshipType: sr!.properties['relationship_type'],
          targetEntity:     sr!.properties['target_entity'],
          required:         sr!.properties['required'] ?? false,
          order:            sr!.properties['order'] ?? 0,
        })),
    }
  })
}

function buildITILTypesResolver() {
  return async (_: unknown, __: unknown, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition)
           WHERE t.scope = 'itil' AND t.active = true
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
           OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
           RETURN t, collect(DISTINCT {f: f, enumTypeId: enumDef.id, enumTypeName: enumDef.name, enumTypeLabel: enumDef.label, enumTypeValues: enumDef.values}) AS fieldData
           ORDER BY t.name`,
          { tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const t = rec.get('t').properties as Props

        type FieldData = { f: { properties: Props } | null; enumTypeId: string | null; enumTypeName: string | null; enumTypeLabel: string | null; enumTypeValues: string[] | null }
        const fieldData = rec.get('fieldData') as FieldData[]
        const fields = fieldData
          .filter(d => d.f)
          .map(d => {
            const enumRef = d.enumTypeId ? {
              id:     d.enumTypeId,
              name:   d.enumTypeName ?? '',
              label:  d.enumTypeLabel ?? '',
              values: d.enumTypeValues ?? [],
            } : undefined
            return mapITILField(d.f!.properties, enumRef)
          })
          .sort((a, b) => (a.order as number) - (b.order as number))

        return {
          id:               t['id'],
          name:             t['name'],
          label:            t['label'],
          icon:             t['icon']  ?? '',
          color:            t['color'] ?? '',
          active:           t['active'],
          validationScript: t['validation_script'] ?? null,
          fields,
          relations:        [],
          systemRelations:  [],
        }
      })
    })
}

function buildITILTypeFieldsResolver() {
  return async (_: unknown, args: { typeId: string }, _ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition {id: $typeId})
           WHERE t.scope = 'itil'
           MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
           RETURN f ORDER BY f.order`,
          { typeId: args.typeId },
        ),
      )
      return r.records
        .map(rec => mapITILField(rec.get('f').properties as Props))
    })
}

function buildITILMutations() {
  return {
    createITILField: async (
      _: unknown,
      args: { typeId: string; input: Record<string, unknown> },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { typeId, input } = args
      const fieldId     = crypto.randomUUID()
      const enumTypeId  = (input['enumTypeId'] as string | null | undefined) ?? null
      // When linking to an existing enum, don't store inline enum_values
      const enumValues  = enumTypeId
        ? null
        : Array.isArray(input['enumValues']) ? JSON.stringify(input['enumValues']) : null

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})
            WHERE t.scope = 'itil'
            CREATE (f:CIFieldDefinition {
              id:          $fieldId,
              name:        $name,
              label:       $label,
              field_type:  $fieldType,
              required:    $required,
              enum_values: $enumValues,
              order:       $order,
              scope:       'itil',
              tenant_id:   $tenantId,
              is_system:   false,
              created_at:  $now
            })
            CREATE (t)-[:HAS_FIELD]->(f)
            WITH f
            CALL {
              WITH f
              MATCH (e:EnumTypeDefinition {id: $enumTypeId})
              WHERE $enumTypeId IS NOT NULL
              MERGE (f)-[:USES_ENUM]->(e)
              RETURN count(e) AS linked
            }
            RETURN f
          `, {
            typeId,
            fieldId,
            name:       input['name'],
            label:      input['label'],
            fieldType:  input['fieldType'],
            required:   input['required']  ?? false,
            enumValues,
            enumTypeId,
            order:      input['order']     ?? 99,
            tenantId:   ctx.tenantId,
            now:        new Date().toISOString(),
          }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchITILTypeById(typeId)
    },

    updateITILField: async (
      _: unknown,
      args: { typeId: string; fieldId: string; input: Record<string, unknown> },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { typeId, fieldId, input } = args
      const enumTypeId  = (input['enumTypeId'] as string | null | undefined) ?? null
      // When linking to an existing enum, clear inline enum_values
      const enumValues  = enumTypeId
        ? null
        : Array.isArray(input['enumValues']) ? JSON.stringify(input['enumValues']) : null

      await withSession(async session => {
        // For is_system fields: only allow label + enum_values update
        // For custom fields: allow full update
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId})
            WHERE t.scope = 'itil'
            SET f.label       = $label,
                f.enum_values = CASE WHEN f.field_type = 'enum' THEN $enumValues ELSE f.enum_values END,
                f.required    = CASE WHEN f.is_system = true THEN f.required ELSE $required END,
                f.field_type  = CASE WHEN f.is_system = true THEN f.field_type ELSE $fieldType END,
                f.name        = CASE WHEN f.is_system = true THEN f.name ELSE $name END,
                f.order       = $order
            WITH f
            // Remove any existing USES_ENUM relation first (clean slate for enum reference)
            OPTIONAL MATCH (f)-[oldRel:USES_ENUM]->(:EnumTypeDefinition)
            DELETE oldRel
            WITH f
            CALL {
              WITH f
              MATCH (e:EnumTypeDefinition {id: $enumTypeId})
              WHERE $enumTypeId IS NOT NULL
              MERGE (f)-[:USES_ENUM]->(e)
              RETURN count(e) AS linked
            }
            RETURN f
          `, {
            typeId,
            fieldId,
            label:     input['label'],
            required:  input['required'] ?? false,
            fieldType: input['fieldType'],
            name:      input['name'],
            enumValues,
            enumTypeId,
            order:     input['order'] ?? 0,
          }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchITILTypeById(typeId)
    },

    deleteITILField: async (
      _: unknown,
      args: { typeId: string; fieldId: string },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      await withSession(async session => {
        const check = await session.executeRead(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId})
            WHERE t.scope = 'itil'
            RETURN f.is_system AS isSystem
          `, { typeId: args.typeId, fieldId: args.fieldId }),
        )
        const isSystem = check.records[0]?.get('isSystem') as boolean | null
        if (isSystem === null) throw new GraphQLError('Campo non trovato')
        if (isSystem === true) throw new GraphQLError('I campi di sistema non possono essere eliminati')

        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId})
            WHERE t.scope = 'itil'
            DETACH DELETE f
          `, { typeId: args.typeId, fieldId: args.fieldId }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchITILTypeById(args.typeId)
    },
  }
}

function buildCITypesResolver() {
  return async (_: unknown, __: unknown, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition)
           WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))
             AND t.active = true
             AND t.name <> '__base__'
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
             WHERE f.scope = 'base' OR (f.scope = 'tenant' AND f.tenant_id = $tenantId)
           OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
           OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
           OPTIONAL MATCH (base:CITypeDefinition {name: '__base__'})-[:HAS_FIELD]->(bf:CIFieldDefinition)
           RETURN t,
             collect(DISTINCT f)  AS typeFields,
             collect(DISTINCT bf) AS baseFields,
             collect(DISTINCT rel) AS relations,
             collect(DISTINCT sr) AS systemRels
           ORDER BY t.name`,
          { tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const t = rec.get('t').properties as Props

        const mapF = (f: Props) => ({
          id:               f['id'],
          name:             f['name'],
          label:            f['label'],
          fieldType:        f['field_type'],
          required:         f['required']      ?? false,
          defaultValue:     f['default_value'] ?? null,
          enumValues:       f['enum_values'] ? JSON.parse(f['enum_values'] as string) as string[] : [],
          order:            f['order']          ?? 0,
          validationScript: f['validation_script'] ?? null,
          visibilityScript: f['visibility_script'] ?? null,
          defaultScript:    f['default_script']    ?? null,
          isSystem:         f['is_system']          ?? false,
        })

        const typeFields = (rec.get('typeFields') as Array<{ properties: Props }>)
          .filter(f => f?.properties).map(f => mapF(f.properties))
        const baseFields = (rec.get('baseFields') as Array<{ properties: Props }>)
          .filter(f => f?.properties).map(f => mapF(f.properties))

        const seen = new Set<string>()
        const fields = [...baseFields, ...typeFields]
          .sort((a, b) => (a.order as number) - (b.order as number))
          .filter(f => { if (seen.has(f.name as string)) return false; seen.add(f.name as string); return true })

        return {
          id:    t['id'],
          name:  t['name'],
          label: t['label'],
          icon:  t['icon'],
          color: t['color'],
          active: t['active'],
          validationScript: t['validation_script'] ?? null,
          fields,
          relations: (rec.get('relations') as Array<{ properties: Props }>)
            .filter(r => r?.properties)
            .map(r => r.properties)
            .map(r => ({
              id: r['id'], name: r['name'], label: r['label'],
              relationshipType: r['relationship_type'], targetType: r['target_type'],
              cardinality: r['cardinality'], direction: r['direction'], order: r['order'] ?? 0,
            })),
          systemRelations: (rec.get('systemRels') as Array<{ properties: Props }>)
            .filter(sr => sr?.properties)
            .map(sr => sr.properties)
            .map(sr => ({
              id: sr['id'], name: sr['name'], label: sr['label'],
              relationshipType: sr['relationship_type'], targetEntity: sr['target_entity'],
              required: sr['required'] ?? false, order: sr['order'] ?? 0,
            })),
        }
      })
    })
}

// ── Metamodel helpers ─────────────────────────────────────────────────────────

function mapCITypeNode(t: Props, fields: Props[], relations: Props[], systemRels: Props[]) {
  return {
    id:               t['id'],
    name:             t['name'],
    label:            t['label'],
    icon:             t['icon'],
    color:            t['color'],
    active:           t['active'] ?? true,
    validationScript: t['validation_script'] ?? null,
    fields: fields
      .filter(f => f && Object.keys(f).length)
      .map(f => ({
        id:               f['id'],
        name:             f['name'],
        label:            f['label'],
        fieldType:        f['field_type'],
        required:         f['required'] ?? false,
        defaultValue:     f['default_value'] ?? null,
        enumValues:       f['enum_values'] ? JSON.parse(f['enum_values'] as string) as string[] : [],
        order:            f['order'] ?? 0,
        validationScript: f['validation_script'] ?? null,
        visibilityScript: f['visibility_script'] ?? null,
        defaultScript:    f['default_script']    ?? null,
        isSystem:         f['is_system']         ?? false,
      }))
      .sort((a, b) => (a.order as number) - (b.order as number)),
    relations: relations
      .filter(r => r && Object.keys(r).length)
      .map(r => ({
        id:               r['id'],
        name:             r['name'],
        label:            r['label'],
        relationshipType: r['relationship_type'],
        targetType:       r['target_type'],
        cardinality:      r['cardinality'],
        direction:        r['direction'],
        order:            r['order'] ?? 0,
      }))
      .sort((a, b) => (a.order as number) - (b.order as number)),
    systemRelations: systemRels
      .filter(sr => sr && Object.keys(sr).length)
      .map(sr => ({
        id:               sr['id'],
        name:             sr['name'],
        label:            sr['label'],
        relationshipType: sr['relationship_type'],
        targetEntity:     sr['target_entity'],
        required:         sr['required'] ?? false,
        order:            sr['order'] ?? 0,
      })),
  }
}

async function fetchCITypeById(id: string, tenantId: string) {
  return withSession(async session => {
    const r = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition {id: $id})
        WHERE t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId)
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN t,
          collect(DISTINCT f) AS fields,
          collect(DISTINCT rel) AS relations,
          collect(DISTINCT sr) AS systemRels
      `, { id, tenantId }),
    )
    if (!r.records.length) throw new GraphQLError('CIType non trovato')
    const rec = r.records[0]
    return mapCITypeNode(
      rec.get('t').properties as Props,
      (rec.get('fields') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(f => f!.properties),
      (rec.get('relations') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(r => r!.properties),
      (rec.get('systemRels') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(sr => sr!.properties),
    )
  })
}

function requireAdmin(ctx: GraphQLContext) {
  if (ctx.role !== 'admin') {
    throw new GraphQLError('Accesso negato: richiesto ruolo admin', {
      extensions: { code: 'FORBIDDEN' },
    })
  }
}

function buildMetamodelMutations() {
  return {
    createCIType: async (
      _: unknown,
      args: { input: { name: string; label: string; icon?: string; color?: string } },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { name, label, icon = 'box', color = '#0284c7' } = args.input
      const id = crypto.randomUUID()
      const neo4jLabel = toPascalCase(name)

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MERGE (t:CITypeDefinition {name: $name, tenant_id: $tenantId})
            ON CREATE SET
              t.id               = $id,
              t.scope            = 'tenant',
              t.label            = $label,
              t.icon             = $icon,
              t.color            = $color,
              t.active           = true,
              t.neo4j_label      = $neo4jLabel,
              t.tenant_id        = $tenantId
            ON MATCH SET
              t.label            = $label,
              t.icon             = $icon,
              t.color            = $color
          `, { name, tenantId: ctx.tenantId, id, label, icon, color, neo4jLabel }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(id, ctx.tenantId)
    },

    updateCIType: async (
      _: unknown,
      args: { id: string; input: { label?: string; icon?: string; color?: string; active?: boolean; validationScript?: string } },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const updates: Props = {}
      const { label, icon, color, active, validationScript } = args.input
      if (label             !== undefined) updates['label']             = label
      if (icon              !== undefined) updates['icon']              = icon
      if (color             !== undefined) updates['color']             = color
      if (active            !== undefined) updates['active']            = active
      if (validationScript  !== undefined) updates['validation_script'] = validationScript

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(
            `MATCH (t:CITypeDefinition {id: $id}) SET t += $updates`,
            { id: args.id, updates },
          ),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(args.id, ctx.tenantId)
    },

    deleteCIType: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      requireAdmin(ctx)
      await withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run(`MATCH (t:CITypeDefinition {id: $id}) RETURN t.scope AS scope`, { id: args.id }),
        )
        if (r.records.length && r.records[0].get('scope') === 'base') {
          throw new GraphQLError('I tipi base non possono essere eliminati')
        }
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $id})
            OPTIONAL MATCH (t)-[:HAS_FIELD]->(f)
            OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel)
            OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr)
            DETACH DELETE t, f, rel, sr
          `, { id: args.id }),
        )
      }, true)
      invalidateSchema(ctx.tenantId)
      return true
    },

    addCIField: async (
      _: unknown,
      args: { typeId: string; input: Record<string, unknown> },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { typeId, input } = args
      const fieldId = crypto.randomUUID()
      const enumValues = Array.isArray(input['enumValues'])
        ? JSON.stringify(input['enumValues'])
        : null

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})
            CREATE (f:CIFieldDefinition {
              id:                $fieldId,
              name:              $name,
              label:             $label,
              field_type:        $fieldType,
              required:          $required,
              default_value:     $defaultValue,
              enum_values:       $enumValues,
              order:             $order,
              scope:             CASE WHEN t.name = '__base__' THEN 'base' ELSE 'tenant' END,
              tenant_id:         $tenantId,
              is_system:         t.name = '__base__',
              validation_script: $validationScript,
              visibility_script: $visibilityScript,
              default_script:    $defaultScript
            })
            CREATE (t)-[:HAS_FIELD]->(f)
          `, {
            typeId,
            fieldId,
            name:             input['name'],
            label:            input['label'],
            fieldType:        input['fieldType'],
            required:         input['required']          ?? false,
            defaultValue:     input['defaultValue']      ?? null,
            enumValues,
            order:            input['order']             ?? 0,
            tenantId:         ctx.tenantId,
            validationScript: input['validationScript']  ?? null,
            visibilityScript: input['visibilityScript']  ?? null,
            defaultScript:    input['defaultScript']     ?? null,
          }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(typeId, ctx.tenantId)
    },

    removeCIField: async (
      _: unknown,
      args: { typeId: string; fieldId: string },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId})
            DETACH DELETE f
          `, { typeId: args.typeId, fieldId: args.fieldId }),
        )
      }, true)
      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(args.typeId, ctx.tenantId)
    },

    addCIRelation: async (
      _: unknown,
      args: { typeId: string; input: Record<string, unknown> },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { typeId, input } = args
      const relId = crypto.randomUUID()

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})
            CREATE (r:CIRelationDefinition {
              id:                $relId,
              name:              $name,
              label:             $label,
              relationship_type: $relationshipType,
              target_type:       $targetType,
              cardinality:       $cardinality,
              direction:         $direction,
              order:             $order
            })
            CREATE (t)-[:HAS_RELATION]->(r)
          `, {
            typeId, relId,
            name:             input['name'],
            label:            input['label'],
            relationshipType: input['relationshipType'],
            targetType:       input['targetType'],
            cardinality:      input['cardinality'],
            direction:        input['direction'],
            order:            input['order'] ?? 0,
          }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(typeId, ctx.tenantId)
    },

    removeCIRelation: async (
      _: unknown,
      args: { typeId: string; relationId: string },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_RELATION]->(r:CIRelationDefinition {id: $relationId})
            DETACH DELETE r
          `, { typeId: args.typeId, relationId: args.relationId }),
        )
      }, true)
      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(args.typeId, ctx.tenantId)
    },
  }
}

function buildBaseCITypeResolver() {
  return async (_: unknown, __: unknown, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition {name: '__base__'})
           WHERE t.tenant_id = $tenantId OR t.tenant_id = 'system'
           WITH t ORDER BY t.tenant_id DESC
           LIMIT 1
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
           RETURN t, collect(DISTINCT f) AS fields`,
          { tenantId: ctx.tenantId },
        ),
      )
      if (!r.records.length) throw new GraphQLError('__base__ non trovato')
      const rec = r.records[0]
      return mapCITypeNode(
        rec.get('t').properties as Props,
        (rec.get('fields') as Array<{ properties: Props } | null>)
          .filter(Boolean).map(f => f!.properties),
        [],
        [],
      )
    })
}

// ── Factory principale ────────────────────────────────────────────────────────

export function buildDynamicCIResolvers(types: CITypeWithDefinitions[]): Record<string, unknown> {
  const Query: Record<string, unknown> = {}
  const Mutation: Record<string, unknown> = {}
  const typeResolvers: Record<string, unknown> = {}

  for (const ciType of types) {
    const typeName = toPascalCase(ciType.name)
    const pluralName = pluralize(typeName)
    const queryListKey  = pluralName.charAt(0).toLowerCase() + pluralName.slice(1)
    const neo4jLabel    = ciType.neo4jLabel

    // ── Query: lista ───────────────────────────────────────────────────────
    Query[queryListKey] = async (
      _: unknown,
      args: { limit?: number; offset?: number; status?: string; environment?: string; search?: string; filters?: string; sortField?: string; sortDirection?: string },
      ctx: GraphQLContext,
    ) => {
      const { limit = 50, offset = 0, status, environment, search, filters, sortField, sortDirection } = args
      const params: Record<string, unknown> = {
        tenantId: ctx.tenantId,
        status: status ?? null,
        environment: environment ?? null,
        search: search ?? null,
        limit,
        offset,
      }
      const orderBy = ciOrderBy(sortField, sortDirection)
      const allowedFields = new Set([
        ...ALLOWED_BASE_FIELDS,
        ...ciType.fields.filter(f => !f.isSystem).map(f => f.name),
      ])
      const WHERE = buildBaseWhere(filters, params, allowedFields)

      const cacheKey = `ci:${ctx.tenantId}:${neo4jLabel}:${JSON.stringify(params)}:${orderBy}`
      const cachedResult = cache.get<{ items: unknown[]; total: number }>(cacheKey)
      if (cachedResult) return cachedResult

      const s1 = getSession(undefined, 'READ')
      const s2 = getSession(undefined, 'READ')
      try {
        const [items, count] = await Promise.all([
          s1.executeRead(tx => tx.run(
            `MATCH (n:${neo4jLabel} {tenant_id: $tenantId}) WHERE ${WHERE}
             OPTIONAL MATCH (n)-[:OWNED_BY]->(og:Team)
             OPTIONAL MATCH (n)-[:SUPPORTED_BY]->(sg:Team)
             RETURN properties(n) AS props,
               CASE WHEN og IS NOT NULL THEN properties(og) END AS ogProps,
               CASE WHEN sg IS NOT NULL THEN properties(sg) END AS sgProps
             ORDER BY ${orderBy} SKIP toInteger($offset) LIMIT toInteger($limit)`,
            params,
          )),
          s2.executeRead(tx => tx.run(
            `MATCH (n:${neo4jLabel} {tenant_id: $tenantId}) WHERE ${WHERE}
             RETURN count(n) AS total`,
            params,
          )),
        ])
        await Promise.all([s1.close(), s2.close()])
        const result = {
          items: items.records.map(r => {
            const ci = mapCI(r.get('props') as Props, ciType) as Record<string, unknown>
            const ogProps = r.get('ogProps') as Props | null
            const sgProps = r.get('sgProps') as Props | null
            ci['_ownerGroup']   = ogProps ? mapTeamProps(ogProps) : null
            ci['_supportGroup'] = sgProps ? mapTeamProps(sgProps) : null
            ci['_prefetched']   = true
            return ci
          }),
          total: (count.records[0]?.get('total') as { toNumber(): number })?.toNumber?.() ?? 0,
        }
        cache.set(cacheKey, result, 30)
        return result
      } catch (err) {
        await Promise.allSettled([s1.close(), s2.close()])
        throw err
      }
    }

    // ── Query: singolo ─────────────────────────────────────────────────────
    Query[ciType.name] = async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
      withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run(
            `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS props`,
            { id: args.id, tenantId: ctx.tenantId },
          ),
        )
        return r.records.length ? mapCI(r.records[0].get('props') as Props, ciType) : null
      })

    // ── Mutations: create / update / delete ───────────────────────────────
    Mutation[`create${typeName}`] = buildCreateMutation(ciType, neo4jLabel, mapCI)
    Mutation[`update${typeName}`] = buildUpdateMutation(ciType, neo4jLabel, mapCI)
    Mutation[`delete${typeName}`] = buildDeleteMutation(neo4jLabel)

    // ── Field resolvers ────────────────────────────────────────────────────
    const fieldResolvers = buildFieldResolvers(ciType, types)
    const typeNameLower  = ciType.name.toLowerCase()
    typeResolvers[typeName] = {
      ...fieldResolvers,
      type: (parent: Record<string, unknown>) => parent['type'] ?? parent['ciType'] ?? typeNameLower,
    }
  }

  // Generic queries
  Query['allCIs']        = buildAllCIsResolver(types)
  Query['ciById']        = buildCIByIdResolver(types)
  Query['blastRadius']   = buildBlastRadiusResolver(types)
  Query['ciTypes']       = buildCITypesResolver()
  Query['baseCIType']    = buildBaseCITypeResolver()
  Query['itilTypes']     = buildITILTypesResolver()
  Query['itilTypeFields'] = buildITILTypeFieldsResolver()

  // Metamodel mutations
  const metamodelMutations = buildMetamodelMutations()
  Object.assign(Mutation, metamodelMutations)

  // ITIL Designer mutations
  const itilMutations = buildITILMutations()
  Object.assign(Mutation, itilMutations)

  return {
    Query,
    Mutation,
    CIBase: {
      __resolveType(obj: { type?: string; __typename?: string; ciType?: string; neo4j_label?: string }) {
        if (obj.__typename) return obj.__typename
        if (obj.ciType) return obj.ciType.charAt(0).toUpperCase() + obj.ciType.slice(1)
        if (obj.neo4j_label) return obj.neo4j_label
        const t = types.find(t => t.name === obj.type)
        return t ? toPascalCase(t.name) : 'Application'
      },
    },
    ...typeResolvers,
  }
}
