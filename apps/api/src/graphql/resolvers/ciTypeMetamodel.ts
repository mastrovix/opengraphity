import { withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import { toPascalCase } from '@opengraphity/schema-generator'

type Props = Record<string, unknown>

export type CIFieldRow = { f: { properties: Props } | null; enumId: string | null; enumName: string | null; enumValues: string[] | string | null }

function parseEnumValues(raw: string[] | string | null | undefined): string[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') { try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : [] } catch { return [] } }
  return []
}

// ── mapCITypeNode ─────────────────────────────────────────────────────────────

function parseChainFamilies(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') { try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : ['Application', 'Infrastructure'] } catch { return ['Application', 'Infrastructure'] } }
  return ['Application', 'Infrastructure']
}

export function mapCITypeNode(t: Props, fields: CIFieldRow[], relations: Props[], systemRels: Props[]) {
  return {
    id:               t['id'],
    name:             t['name'],
    label:            t['label'],
    icon:             t['icon'],
    color:            t['color'],
    active:           t['active'] ?? true,
    validationScript: t['validation_script'] ?? null,
    chainFamilies:    parseChainFamilies(t['chain_families']),
    fields: fields
      .filter(fd => fd?.f?.properties)
      .map(fd => {
        const f = fd.f!.properties
        return {
          id:               f['id'],
          name:             f['name'],
          label:            f['label'],
          fieldType:        f['field_type'],
          required:         f['required'] ?? false,
          defaultValue:     f['default_value'] ?? null,
          enumValues:       parseEnumValues(fd.enumValues ?? fd.f!.properties['enum_values'] as string[] | string | null),
          enumTypeId:       fd.enumId     ?? null,
          enumTypeName:     fd.enumName   ?? null,
          order:            Number(f['order'] ?? 0),
          validationScript: f['validation_script'] ?? null,
          visibilityScript: f['visibility_script'] ?? null,
          defaultScript:    f['default_script']    ?? null,
          isSystem:         f['is_system']         ?? false,
        }
      })
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)),
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
        order:            Number(r['order'] ?? 0),
      }))
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)),
    systemRelations: systemRels
      .filter(sr => sr && Object.keys(sr).length)
      .map(sr => ({
        id:               sr['id'],
        name:             sr['name'],
        label:            sr['label'],
        relationshipType: sr['relationship_type'],
        targetEntity:     sr['target_entity'],
        required:         sr['required'] ?? false,
        order:            Number(sr['order'] ?? 0),
      })),
  }
}

// ── fetchCITypeById ───────────────────────────────────────────────────────────

export async function fetchCITypeById(id: string, tenantId: string) {
  return withSession(async session => {
    const r = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition {id: $id})
        WHERE t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId)
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
        OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN t,
          collect(DISTINCT {f: f, enumId: enumDef.id, enumName: enumDef.name, enumValues: enumDef.values}) AS fields,
          collect(DISTINCT rel) AS relations,
          collect(DISTINCT sr) AS systemRels
      `, { id, tenantId }),
    )
    if (!r.records.length) throw new GraphQLError('CIType non trovato')
    const rec = r.records[0]
    return mapCITypeNode(
      rec.get('t').properties as Props,
      (rec.get('fields') as CIFieldRow[]).filter(fd => fd?.f?.properties),
      (rec.get('relations') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(r => r!.properties),
      (rec.get('systemRels') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(sr => sr!.properties),
    )
  })
}

// ── requireAdmin ──────────────────────────────────────────────────────────────

export function requireAdmin(ctx: GraphQLContext) {
  if (ctx.role !== 'admin') {
    throw new GraphQLError('Accesso negato: richiesto ruolo admin', {
      extensions: { code: 'FORBIDDEN' },
    })
  }
}

// ── buildCITypesResolver ──────────────────────────────────────────────────────

export function buildCITypesResolver() {
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
           OPTIONAL MATCH (f)-[:USES_ENUM]->(fEnum:EnumTypeDefinition)
           OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
           OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
           OPTIONAL MATCH (base:CITypeDefinition {name: '__base__'})-[:HAS_FIELD]->(bf:CIFieldDefinition)
           OPTIONAL MATCH (bf)-[:USES_ENUM]->(bfEnum:EnumTypeDefinition)
           RETURN t,
             collect(DISTINCT {f: f, enumId: fEnum.id, enumName: fEnum.name, enumValues: fEnum.values})  AS typeFields,
             collect(DISTINCT {f: bf, enumId: bfEnum.id, enumName: bfEnum.name, enumValues: bfEnum.values}) AS baseFields,
             collect(DISTINCT rel) AS relations,
             collect(DISTINCT sr) AS systemRels
           ORDER BY t.name`,
          { tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const t = rec.get('t').properties as Props

        type FRow = { f: { properties: Props } | null; enumId: string | null; enumName: string | null; enumValues: string[] | string | null }
        const mapF = (fd: FRow) => {
          const f = fd.f!.properties
          return {
            id:               f['id'],
            name:             f['name'],
            label:            f['label'],
            fieldType:        f['field_type'],
            required:         f['required']      ?? false,
            defaultValue:     f['default_value'] ?? null,
            enumValues:       parseEnumValues(fd.enumValues ?? f['enum_values'] as string[] | string | null),
            enumTypeId:       fd.enumId          ?? null,
            enumTypeName:     fd.enumName        ?? null,
            order:            f['order']          ?? 0,
            validationScript: f['validation_script'] ?? null,
            visibilityScript: f['visibility_script'] ?? null,
            defaultScript:    f['default_script']    ?? null,
            isSystem:         f['is_system']          ?? false,
          }
        }

        const typeFields = (rec.get('typeFields') as FRow[])
          .filter(fd => fd?.f?.properties).map(fd => mapF(fd))
        const baseFields = (rec.get('baseFields') as FRow[])
          .filter(fd => fd?.f?.properties).map(fd => mapF(fd))

        const seen = new Set<string>()
        const fields = [...baseFields, ...typeFields]
          .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
          .filter(f => { if (seen.has(f.name as string)) return false; seen.add(f.name as string); return true })

        return {
          id:    t['id'],
          name:  t['name'],
          label: t['label'],
          icon:  t['icon'],
          color: t['color'],
          active: t['active'],
          validationScript: t['validation_script'] ?? null,
          chainFamilies: parseChainFamilies(t['chain_families']),
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

// ── buildBaseCITypeResolver ───────────────────────────────────────────────────

export function buildBaseCITypeResolver() {
  return async (_: unknown, __: unknown, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition {name: '__base__'})
           WHERE t.tenant_id = $tenantId OR t.tenant_id = 'system'
           WITH t ORDER BY t.tenant_id DESC
           LIMIT 1
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
           OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
           RETURN t, collect(DISTINCT {f: f, enumId: enumDef.id, enumName: enumDef.name, enumValues: enumDef.values}) AS fields`,
          { tenantId: ctx.tenantId },
        ),
      )
      if (!r.records.length) throw new GraphQLError('__base__ non trovato')
      const rec = r.records[0]
      return mapCITypeNode(
        rec.get('t').properties as Props,
        (rec.get('fields') as CIFieldRow[]).filter(fd => fd?.f?.properties),
        [],
        [],
      )
    })
}

// ── buildMetamodelMutations ───────────────────────────────────────────────────

export function buildMetamodelMutations() {
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
      const fieldId    = crypto.randomUUID()
      const enumTypeId = (input['enumTypeId'] as string | null | undefined) ?? null

      if (input['fieldType'] === 'enum' && !enumTypeId) {
        throw new GraphQLError('enumTypeId obbligatorio per campi di tipo enum', {
          extensions: { code: 'BAD_USER_INPUT' },
        })
      }

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
              order:             $order,
              scope:             CASE WHEN t.name = '__base__' THEN 'base' ELSE 'tenant' END,
              tenant_id:         $tenantId,
              is_system:         t.name = '__base__',
              validation_script: $validationScript,
              visibility_script: $visibilityScript,
              default_script:    $defaultScript
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
            name:             input['name'],
            label:            input['label'],
            fieldType:        input['fieldType'],
            required:         input['required']          ?? false,
            defaultValue:     input['defaultValue']      ?? null,
            enumTypeId,
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
