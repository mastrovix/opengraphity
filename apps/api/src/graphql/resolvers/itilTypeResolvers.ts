/**
 * Metamodello ITIL (`incident`, `change`, `problem`, `service_request`).
 *
 * I quattro tipi e i loro 36 campi sono SPEDITI col prodotto: un solo nodo
 * `tenant_id = 'system'` per tutti i clienti. Da qui le due regole di questo
 * file (personalizzazioni, ondata 1):
 *
 * - **A-2 / C-6, vocabolari**: ogni `USES_ENUM` si legge con
 *   `enumScopeClause` (il vocabolario di un altro cliente non esiste) e si
 *   scrive con `assertEnumLinkable` (un campo condiviso non si aggancia al
 *   vocabolario di un cliente). La personalizzazione passa per il NOME:
 *   `loadTenantEnumOverrides` + `applyEnumOverrides` fanno vincere il
 *   vocabolario del tenant, e solo per chi lo possiede. Fonte unica:
 *   `lib/enumScope.ts`.
 * - **A-4, campi**: le letture mostrano solo i campi del tenant e quelli
 *   spediti (`f.tenant_id IN [$tenantId, 'system']`), così l'id del campo di un
 *   altro cliente non arriva mai all'interfaccia; le scritture toccano solo i
 *   campi del tenant. Un campo spedito è in sola lettura **etichetta, ordine e
 *   script compresi** — prima le guardie `CASE WHEN f.is_system` coprivano solo
 *   `required`/`field_type`/`name`, e `visibility_script` scritto da un cliente
 *   girava nel contesto di tutti gli altri.
 */
import { withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import type { Session } from 'neo4j-driver'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import {
  SYSTEM_TENANT, enumScopeClause, loadTenantEnumOverrides, applyEnumOverrides,
  assertEnumLinkable, type EnumOverride, type EnumRow,
} from '../../lib/enumScope.js'

type Props = Record<string, unknown>

/** Campi visibili: i propri più quelli spediti. Mai quelli di un altro cliente. */
const FIELD_SCOPE = `f.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']`

// ── mapITILField ──────────────────────────────────────────────────────────────

function parseInlineEnumValues(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return []
  const arr: unknown = JSON.parse(raw)
  if (!Array.isArray(arr)) throw new Error(`enum_values non è un array JSON valido: ${raw.slice(0, 80)}`)
  return arr as string[]
}

export function mapITILField(f: Props, enumRef?: { id: string; name: string; values: string[] }) {
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

// ── Righe di campo + vocabolario ──────────────────────────────────────────────

/** Una riga «campo + vocabolario agganciato», nella forma che `enumScope` sa personalizzare. */
interface ITILFieldRow extends EnumRow {
  props: Props
}

function toValues(raw: string[] | string | null, name: string): string[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error(`Vocabolario "${name}": values non è un array`)
    return parsed as string[]
  }
  return []
}

/**
 * Applica la personalizzazione del tenant (il suo vocabolario con lo stesso
 * nome vince) e mappa le righe. La precedenza risultante è quella del
 * contratto: vocabolario del tenant > agganciato di sistema > `enum_values`
 * inline del campo (l'inline lo usa `mapITILField` quando non c'è aggancio).
 */
function mapFieldRows(rows: readonly ITILFieldRow[], overrides: Map<string, EnumOverride>) {
  return applyEnumOverrides(rows, overrides)
    .map((r) => {
      const enumRef = r.enumId
        ? { id: r.enumId, name: r.enumName ?? '', values: toValues(r.enumValues, r.enumName ?? r.enumId) }
        : undefined
      return mapITILField(r.props, enumRef)
    })
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
}

// ── fetchITILTypeById ─────────────────────────────────────────────────────────

export async function fetchITILTypeById(id: string, tenantId: string) {
  return withSession(async session => {
    const overrides = await loadTenantEnumOverrides(session, tenantId)
    const r = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition {id: $id})
        WHERE t.scope = 'itil' AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
          WHERE ${FIELD_SCOPE}
        OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
          ${enumScopeClause('enumDef')}
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN t,
          collect(DISTINCT {f: f, enumTypeId: enumDef.id, enumTypeName: enumDef.name, enumTypeValues: enumDef.values}) AS fieldData,
          collect(DISTINCT rel) AS relations,
          collect(DISTINCT sr)  AS systemRels
      `, { id, tenantId }),
    )
    if (!r.records.length) throw new GraphQLError('ITIL type non trovato')
    const rec = r.records[0]
    const t = rec.get('t').properties as Props

    type FieldData = { f: { properties: Props } | null; enumTypeId: string | null; enumTypeName: string | null; enumTypeValues: string[] | null }
    const fields = mapFieldRows(
      (rec.get('fieldData') as FieldData[])
        .filter(d => d.f)
        .map(d => ({ props: d.f!.properties, enumId: d.enumTypeId, enumName: d.enumTypeName, enumValues: d.enumTypeValues })),
      overrides,
    )

    return {
      id:               t['id'],
      name:             t['name'],
      label:            t['label'],
      icon:             t['icon']  ?? '',
      color:            t['color'] ?? '',
      active:           t['active'] ?? true,
      // A-6: i tipi ITIL sono spediti col prodotto; il campo lo dice, invece
      // di lasciarlo dedurre al web.
      scope:            t['scope']     ?? 'itil',
      tenantId:         t['tenant_id'] ?? SYSTEM_TENANT,
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
      const overrides = await loadTenantEnumOverrides(session, ctx.tenantId)
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition)
           WHERE t.scope = 'itil' AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}'] AND t.active = true
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
             WHERE ${FIELD_SCOPE}
           OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
             ${enumScopeClause('enumDef')}
           RETURN t,
             collect(DISTINCT {f: f, enumTypeId: enumDef.id, enumTypeName: enumDef.name, enumTypeValues: enumDef.values}) AS fieldData
           ORDER BY t.name`,
          { tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const t = rec.get('t').properties as Props

        type FieldData = { f: { properties: Props } | null; enumTypeId: string | null; enumTypeName: string | null; enumTypeValues: string[] | null }
        const fields = mapFieldRows(
          (rec.get('fieldData') as FieldData[])
            .filter(d => d.f)
            .map(d => ({ props: d.f!.properties, enumId: d.enumTypeId, enumName: d.enumTypeName, enumValues: d.enumTypeValues })),
          overrides,
        )

        return {
          id:               t['id'],
          name:             t['name'],
          label:            t['label'],
          icon:             t['icon']  ?? '',
          color:            t['color'] ?? '',
          active:           t['active'],
          scope:            t['scope']     ?? 'itil',
          tenantId:         t['tenant_id'] ?? SYSTEM_TENANT,
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
  return async (_: unknown, args: { typeId: string }, ctx: GraphQLContext) =>
    withSession(async session => {
      const overrides = await loadTenantEnumOverrides(session, ctx.tenantId)
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition {id: $typeId})
           WHERE t.scope = 'itil' AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
           MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
           WHERE ${FIELD_SCOPE}
           OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
             ${enumScopeClause('enumDef')}
           RETURN f, enumDef.id AS enumTypeId, enumDef.name AS enumTypeName,
                  enumDef.values AS enumTypeValues
           ORDER BY f.order`,
          { typeId: args.typeId, tenantId: ctx.tenantId },
        ),
      )
      return mapFieldRows(
        r.records.map(rec => ({
          props:      rec.get('f').properties as Props,
          enumId:     rec.get('enumTypeId')     as string | null,
          enumName:   rec.get('enumTypeName')   as string | null,
          enumValues: rec.get('enumTypeValues') as string[] | null,
        })),
        overrides,
      )
    })
}

// ── Guardie di scrittura (A-4) ────────────────────────────────────────────────

/**
 * Il campo si può SCRIVERE? Solo se è del tenant. Un campo spedito col prodotto
 * è in sola lettura per intero (etichetta, ordine, script compresi): il nodo è
 * uno per tutti i clienti. Un campo di un altro cliente non esiste (le letture
 * lo nascondono, la scrittura dice «non trovato»: non si conferma che c'è).
 */
async function assertFieldWritable(
  session: Session, typeId: string, fieldId: string, tenantId: string,
): Promise<{ name: string; tenantId: string }> {
  const r = await session.executeRead(tx =>
    tx.run(`
      MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId})
      WHERE t.scope = 'itil' AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
        AND ${FIELD_SCOPE}
      RETURN f.name AS name, f.tenant_id AS fieldTenantId, f.is_system AS isSystem
    `, { typeId, fieldId, tenantId }),
  )
  const rec = r.records[0]
  if (!rec) throw new GraphQLError('Campo non trovato', { extensions: { code: 'NOT_FOUND' } })

  const name          = rec.get('name')          as string
  const fieldTenantId = rec.get('fieldTenantId') as string | null
  const isSystem      = rec.get('isSystem')      as boolean | null

  if (fieldTenantId === SYSTEM_TENANT || isSystem === true) {
    throw new GraphQLError(
      `Il campo "${name}" è spedito col prodotto: è lo stesso per tutti i clienti e non si modifica, ` +
      `nemmeno l'etichetta, l'ordine o gli script. Aggiungi un campo tuo sul tipo.`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    )
  }
  if (fieldTenantId !== tenantId) {
    throw new GraphQLError('Campo non trovato', { extensions: { code: 'NOT_FOUND' } })
  }
  return { name, tenantId: fieldTenantId }
}

/**
 * Il vocabolario si può agganciare a questo campo? Delega a
 * `assertEnumLinkable` (lib/enumScope.ts). Il campo è descritto dal suo
 * PROPRIETARIO (`tenant_id`): lo `scope` non serve, perché su questi tipi tutti
 * i campi hanno `scope = 'itil'` — spediti e personalizzati — mentre il
 * `tenant_id` distingue («system» = spedito, verificato dal vivo su 36 campi).
 */
async function assertEnumTypeLinkable(
  session: Session, enumTypeId: string | null, field: { name: string; tenantId: string | null }, tenantId: string,
): Promise<void> {
  if (!enumTypeId) return
  const r = await session.executeRead(tx =>
    tx.run(`
      MATCH (e:EnumTypeDefinition {id: $enumTypeId})
      RETURN e.id AS id, e.name AS name, e.tenant_id AS tenantId
    `, { enumTypeId }),
  )
  const rec = r.records[0]
  if (!rec) {
    throw new GraphQLError(`Vocabolario ${enumTypeId} non trovato`, { extensions: { code: 'NOT_FOUND' } })
  }
  assertEnumLinkable(
    { id: rec.get('id') as string, name: rec.get('name') as string, tenantId: rec.get('tenantId') as string },
    { name: field.name, tenantId: field.tenantId },
    tenantId,
  )
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
        // A-4: prima il `MATCH (t {id, tenant_id: $tenantId})` non trovava i
        // tipi `system` — cioè tutti e quattro — e la mutation restituiva il
        // tipo come se avesse scritto: no-op silenzioso. Adesso si ferma e lo
        // dice.
        const check = await session.executeRead(tx =>
          tx.run(
            `MATCH (t:CITypeDefinition {id: $id})
             WHERE t.scope = 'itil' AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
             RETURN t.name AS name, t.tenant_id AS typeTenantId`,
            { id: args.id, tenantId: ctx.tenantId },
          ),
        )
        const rec = check.records[0]
        if (!rec) throw new GraphQLError('ITIL type non trovato', { extensions: { code: 'NOT_FOUND' } })
        if ((rec.get('typeTenantId') as string) === SYSTEM_TENANT) {
          throw new GraphQLError(
            `Il tipo "${rec.get('name') as string}" è spedito col prodotto: è lo stesso per tutti i clienti ` +
            `e non si modifica (etichetta, icona, colore e script di validazione compresi).`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          )
        }

        await session.executeWrite(tx =>
          tx.run(
            `MATCH (t:CITypeDefinition {id: $id, tenant_id: $tenantId}) WHERE t.scope = 'itil' SET t += $updates`,
            { id: args.id, updates, tenantId: ctx.tenantId },
          ),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchITILTypeById(args.id, ctx.tenantId)
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
        // Il campo nuovo è del TENANT (`tenant_id`, `is_system: false`) anche
        // su un tipo condiviso: quindi può essere agganciato al vocabolario del
        // tenant. Quello di un altro cliente no, e `assertEnumLinkable` lo dice.
        await assertEnumTypeLinkable(session, enumTypeId, { name: String(input['name']), tenantId: ctx.tenantId }, ctx.tenantId)

        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})
            WHERE t.scope = 'itil' AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
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
              WHERE $enumTypeId IS NOT NULL AND e.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
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
      return fetchITILTypeById(typeId, ctx.tenantId)
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
        // A-4: solo i campi del tenant. Un campo spedito è in sola lettura per
        // intero, non solo su name/field_type/required.
        const field = await assertFieldWritable(session, typeId, fieldId, ctx.tenantId)
        await assertEnumTypeLinkable(session, enumTypeId, field, ctx.tenantId)

        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId, tenant_id: $tenantId})
            WHERE t.scope = 'itil' AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
            SET f.label             = $label,
                f.enum_values       = CASE WHEN f.field_type = 'enum' THEN $enumValues ELSE f.enum_values END,
                f.required          = $required,
                f.field_type        = $fieldType,
                f.name              = $name,
                f.order             = $order,
                f.validation_script = $validationScript,
                f.visibility_script = $visibilityScript,
                f.default_script    = $defaultScript
            WITH f
            // Remove any existing USES_ENUM relation first (clean slate for enum reference)
            // Qui non si LEGGE il vocabolario: si stacca il legame vecchio del
            // campo, qualunque sia (anche uno sbagliato, da ripulire).
            // tenant-ok: f è già vincolato a tenant_id = $tenantId dal MATCH sopra.
            OPTIONAL MATCH (f)-[oldRel:USES_ENUM]->(:EnumTypeDefinition)
            DELETE oldRel
            WITH f
            CALL {
              WITH f
              MATCH (e:EnumTypeDefinition {id: $enumTypeId})
              WHERE $enumTypeId IS NOT NULL AND e.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
              MERGE (f)-[:USES_ENUM]->(e)
              RETURN count(e) AS linked
            }
            RETURN f
          `, {
            typeId,
            fieldId,
            tenantId: ctx.tenantId,
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
      return fetchITILTypeById(typeId, ctx.tenantId)
    },

    deleteITILField: async (
      _: unknown,
      args: { typeId: string; fieldId: string },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      await withSession(async session => {
        // A-4: `f.is_system` non basta — i campi custom di un altro cliente
        // hanno `is_system = false` ed erano quindi cancellabili da qui.
        await assertFieldWritable(session, args.typeId, args.fieldId, ctx.tenantId)

        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId, tenant_id: $tenantId})
            WHERE t.scope = 'itil' AND t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
            DETACH DELETE f
          `, { typeId: args.typeId, fieldId: args.fieldId, tenantId: ctx.tenantId }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchITILTypeById(args.typeId, ctx.tenantId)
    },
  }
}
