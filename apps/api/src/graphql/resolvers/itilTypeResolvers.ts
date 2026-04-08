import { withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'

type Props = Record<string, unknown>

// ── mapITILField ──────────────────────────────────────────────────────────────

function parseInlineEnumValues(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return []
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : [] } catch { return [] }
}

export function mapITILField(f: Props, enumRef?: { id: string; name: string; label: string; values: string[] }) {
  return {
    id:               f['id'],
    name:             f['name'],
    label:            f['label'],
    fieldType:        f['field_type'],
    required:         f['required']      ?? false,
    defaultValue:     f['default_value'] ?? null,
    enumValues:       enumRef?.values ?? parseInlineEnumValues(f['enum_values']),
    order:            Number(f['order']   ?? 0),
    validationScript: f['validation_script'] ?? null,
    visibilityScript: f['visibility_script'] ?? null,
    defaultScript:    f['default_script']    ?? null,
    isSystem:         f['is_system']          ?? false,
    enumTypeId:       enumRef?.id ?? null,
    enumTypeName:     enumRef?.name ?? null,
  }
}

// ── fetchITILTypeById ─────────────────────────────────────────────────────────

export async function fetchITILTypeById(id: string) {
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
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))

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

// ── buildITILTypesResolver ────────────────────────────────────────────────────

export function buildITILTypesResolver() {
  return async (_: unknown, __: unknown, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition)
           WHERE t.scope = 'itil' AND t.active = true
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
           OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
           RETURN t,
             collect(DISTINCT {f: f, enumTypeId: enumDef.id, enumTypeName: enumDef.name, enumTypeLabel: enumDef.label, enumTypeValues: enumDef.values}) AS fieldData
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
          .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))

        return {
          id:               t['id'],
          name:             t['name'],
          label:            t['label'],
          icon:             t['icon']  ?? '',
          color:            t['color'] ?? '',
          active:           t['active'],
          validationScript: t['validation_script'] ?? null,
          fields,
          relations:       [],
          systemRelations: [],
        }
      })
    })
}

// ── buildITILTypeFieldsResolver ───────────────────────────────────────────────

export function buildITILTypeFieldsResolver() {
  return async (_: unknown, args: { typeId: string }, _ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition {id: $typeId})
           WHERE t.scope = 'itil'
           MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
           OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
           RETURN f, enumDef.id AS enumTypeId, enumDef.name AS enumTypeName,
                  enumDef.label AS enumTypeLabel, enumDef.values AS enumTypeValues
           ORDER BY f.order`,
          { typeId: args.typeId },
        ),
      )
      return r.records.map(rec => {
        const enumId = rec.get('enumTypeId') as string | null
        const enumRef = enumId ? {
          id:     enumId,
          name:   rec.get('enumTypeName') as string ?? '',
          label:  rec.get('enumTypeLabel') as string ?? '',
          values: rec.get('enumTypeValues') as string[] ?? [],
        } : undefined
        return mapITILField(rec.get('f').properties as Props, enumRef)
      })
    })
}

// ── buildITILMutations ────────────────────────────────────────────────────────

export function buildITILMutations(requireAdmin: (ctx: GraphQLContext) => void) {
  return {
    updateITILType: async (
      _: unknown,
      args: { id: string; input: { label?: string; icon?: string; color?: string; validationScript?: string | null } },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const updates: Props = {}
      const { label, icon, color, validationScript } = args.input
      if (label            !== undefined) updates['label']             = label
      if (icon             !== undefined) updates['icon']              = icon
      if (color            !== undefined) updates['color']             = color
      if (validationScript !== undefined) updates['validation_script'] = validationScript ?? null

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(
            `MATCH (t:CITypeDefinition {id: $id}) WHERE t.scope = 'itil' SET t += $updates`,
            { id: args.id, updates },
          ),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchITILTypeById(args.id)
    },

    createITILField: async (
      _: unknown,
      args: { typeId: string; input: Record<string, unknown> },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { typeId, input } = args
      const fieldId     = crypto.randomUUID()
      const enumTypeId  = (input['enumTypeId'] as string | null | undefined) ?? null

      if (input['fieldType'] === 'enum' && !enumTypeId) {
        throw new GraphQLError('enumTypeId obbligatorio per campi di tipo enum', {
          extensions: { code: 'BAD_USER_INPUT' },
        })
      }

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
              id:                $fieldId,
              name:              $name,
              label:             $label,
              field_type:        $fieldType,
              required:          $required,
              enum_values:       $enumValues,
              order:             $order,
              scope:             'itil',
              tenant_id:         $tenantId,
              is_system:         false,
              validation_script: $validationScript,
              visibility_script: $visibilityScript,
              default_script:    $defaultScript,
              created_at:        $now
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
            enumValues,
            enumTypeId,
            order:            input['order']             ?? 99,
            validationScript: (input['validationScript'] as string | null | undefined) ?? null,
            visibilityScript: (input['visibilityScript'] as string | null | undefined) ?? null,
            defaultScript:    (input['defaultScript']    as string | null | undefined) ?? null,
            tenantId:         ctx.tenantId,
            now:              new Date().toISOString(),
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

      if (input['fieldType'] === 'enum' && !enumTypeId) {
        throw new GraphQLError('enumTypeId obbligatorio per campi di tipo enum', {
          extensions: { code: 'BAD_USER_INPUT' },
        })
      }

      // When linking to an existing enum, clear inline enum_values
      const enumValues  = enumTypeId
        ? null
        : Array.isArray(input['enumValues']) ? JSON.stringify(input['enumValues']) : null

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId})
            WHERE t.scope = 'itil'
            SET f.label             = $label,
                f.enum_values       = CASE WHEN f.field_type = 'enum' THEN $enumValues ELSE f.enum_values END,
                f.required          = CASE WHEN f.is_system = true THEN f.required ELSE $required END,
                f.field_type        = CASE WHEN f.is_system = true THEN f.field_type ELSE $fieldType END,
                f.name              = CASE WHEN f.is_system = true THEN f.name ELSE $name END,
                f.order             = $order,
                f.validation_script = $validationScript,
                f.visibility_script = $visibilityScript,
                f.default_script    = $defaultScript
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
            label:            input['label'],
            required:         input['required']          ?? false,
            fieldType:        input['fieldType'],
            name:             input['name'],
            enumValues,
            enumTypeId,
            order:            input['order']             ?? 0,
            validationScript: (input['validationScript'] as string | null | undefined) ?? null,
            visibilityScript: (input['visibilityScript'] as string | null | undefined) ?? null,
            defaultScript:    (input['defaultScript']    as string | null | undefined) ?? null,
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
