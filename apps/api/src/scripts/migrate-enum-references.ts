/**
 * Migration script — links existing CIFieldDefinition nodes that have
 * inline enum_values to the matching EnumTypeDefinition via USES_ENUM.
 *
 * Matching strategy:
 *   1. Exact name match + exact value set (prefers same-named enum)
 *   2. Unique exact value match (name-agnostic)
 *   3. Name-hinted subset (enum.name === fieldName, field ⊆ enum)
 *   4. Smallest superset fallback
 *   If no match found, creates a new custom EnumTypeDefinition for this field
 *   using the field name converted to snake_case as the enum name.
 *
 * In all cases: MERGE (f)-[:USES_ENUM]->(e), SET f.enum_values = null
 *
 * Tenant scoping (multi-tenant DB) — la regola, che PRIMA di questa ondata
 * viveva solo in questo commento (A-2 / C-6: nel grafo i legami c'erano
 * comunque), adesso è CODICE: ogni legame passa da `assertEnumLinkable`
 * (lib/enumScope.ts), la stessa guardia dei resolver.
 *   - By default ONLY fields of CITypeDefinition owned by --tenant are touched.
 *     Shared types (scope IN ['base','itil'] or tenant_id = 'system') are
 *     EXCLUDED: linking them to a tenant enum would leak that enum to every
 *     other tenant and wipe their inline enum_values.
 *   - With --include-shared the shared fields are migrated too, but they are
 *     matched ONLY against SHIPPED enums (`tenant_id = 'system'` — non il flag
 *     `is_system`, che è scritto anche sulle copie per tenant) e ogni enum
 *     creato per loro è {tenant_id: 'system', is_system: true}.
 *   - Every write on a field is constrained by the tenant of its parent type.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/migrate-enum-references.ts --tenant=<slug> [--include-shared]
 *
 * Idempotent: safe to run multiple times.
 */

import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { resolveTenantArg, hasFlag } from './lib/scriptArgs.js'
import { SYSTEM_TENANT, assertEnumLinkable } from '../lib/enumScope.js'

const SHARED_SCOPES = ['base', 'itil']

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnumDef {
  id:       string
  name:     string
  label:    string
  values:   string[]
  isSystem: boolean
  /** Proprietario: `system` = spedito col prodotto. È questo che conta, non `isSystem`. */
  tenantId: string
}

interface FieldRecord {
  fieldId:      string
  fieldName:    string
  typeName:     string
  typeScope:    string
  /** tenant_id of the parent CITypeDefinition — every write is constrained by it */
  typeTenantId: string
  /** shared type (base/itil/system): enum must be a system enum */
  shared:       boolean
  /** tenant_id del CAMPO: è quello che `assertEnumLinkable` guarda */
  fieldTenantId: string | null
  enumValues:   string[]
}

/** camelCase / PascalCase → snake_case */
function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/** Derive scope for the new enum from the parent CI type scope */
function scopeFromType(typeScope: string): string {
  if (typeScope === 'itil') return 'itil'
  if (typeScope === 'base')  return 'cmdb'
  return 'cmdb'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the best-matching EnumDef for a field's values, or null.
 *
 * Resolution order:
 *   1. Exact name match: enum.name === fieldName  AND  values match exactly
 *   2. Exact value match: same value set (name-agnostic)
 *   3. Name-hinted subset: enum.name === fieldName AND field values ⊆ enum values
 *   4. Smallest superset (name-agnostic subset match)
 *
 * Steps 1 and 3 prevent semantic mismatches when two enums share the same
 * values (e.g. "priority" and "severity" both have low/medium/high/critical).
 */
function findMatch(fieldValues: string[], fieldName: string, enums: EnumDef[]): EnumDef | null {
  const fieldSet = new Set(fieldValues)

  // 1. Exact name match + exact value set
  for (const e of enums) {
    if (e.name !== fieldName) continue
    const enumSet = new Set(e.values)
    if (fieldSet.size === enumSet.size && [...fieldSet].every((v) => enumSet.has(v))) return e
  }

  // 2. Exact value set (name-agnostic) — for fields without a same-named enum
  const exactMatches: EnumDef[] = []
  for (const e of enums) {
    const enumSet = new Set(e.values)
    if (fieldSet.size === enumSet.size && [...fieldSet].every((v) => enumSet.has(v))) {
      exactMatches.push(e)
    }
  }
  if (exactMatches.length === 1) return exactMatches[0]!
  if (exactMatches.length > 1) {
    // Multiple exact matches — prefer same name, otherwise first alphabetically
    return exactMatches.find((e) => e.name === fieldName) ?? exactMatches.sort((a, b) => a.name.localeCompare(b.name))[0]!
  }

  // 3. Name-hinted subset: enum.name === fieldName AND field values ⊆ enum values
  for (const e of enums) {
    if (e.name !== fieldName) continue
    const enumSet = new Set(e.values)
    if ([...fieldSet].every((v) => enumSet.has(v))) return e
  }

  // 4. Smallest superset (name-agnostic)
  const supersets = enums.filter((e) => {
    const enumSet = new Set(e.values)
    return [...fieldSet].every((v) => enumSet.has(v))
  })
  if (supersets.length > 0) {
    return supersets.sort((a, b) => a.values.length - b.values.length)[0]!
  }

  return null
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Cypher predicate: is the CITypeDefinition `t` shared across tenants?
 * (base/itil metamodel, or owned by the system tenant)
 */
const SHARED_TYPE_PREDICATE = `(t.scope IN $sharedScopes OR t.tenant_id = $systemTenant)`

async function main() {
  const argv = process.argv.slice(2)
  const tenantId = resolveTenantArg(argv)
  const includeShared = hasFlag('--include-shared', argv)

  console.info(`\n▶ Migrating enum fields for tenant: ${tenantId}${includeShared ? ' (+ shared base/itil types → system enums)' : ' (shared base/itil types excluded)'}\n`)

  const session = getSession(undefined, 'WRITE')

  try {
    // 1. Load all EnumTypeDefinitions available for this tenant
    const enumResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition)
        WHERE e.tenant_id IN [$tenantId, $systemTenant]
        RETURN e.id        AS id,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.tenant_id AS tenantId,
               coalesce(e.is_system, false) AS isSystem
        ORDER BY e.name
      `, { tenantId, systemTenant: SYSTEM_TENANT }),
    )

    const enumDefs: EnumDef[] = enumResult.records.map((r) => ({
      id:       r.get('id')       as string,
      name:     r.get('name')     as string,
      label:    r.get('label')    as string,
      values:   r.get('values')   as string[],
      isSystem: r.get('isSystem') as boolean,
      tenantId: r.get('tenantId') as string,
    }))

    console.info(`  Found ${enumDefs.length} EnumTypeDefinition(s):`)
    for (const e of enumDefs) {
      console.info(`    • ${e.name}${e.isSystem ? ' (system)' : ''} [${e.values.join(', ')}]`)
    }
    console.info('')

    // 2. Load CIFieldDefinitions with field_type=enum, with enum_values, but
    //    WITHOUT an existing USES_ENUM relation. Tenant-owned types always;
    //    shared types only with --include-shared.
    const fieldResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)
        WHERE f.field_type = 'enum'
          AND f.enum_values IS NOT NULL
          AND f.enum_values <> '[]'
          AND f.enum_values <> ''
          AND NOT (f)-[:USES_ENUM]->(:EnumTypeDefinition)
          AND (
            (t.tenant_id = $tenantId AND NOT ${SHARED_TYPE_PREDICATE})
            OR ($includeShared AND ${SHARED_TYPE_PREDICATE})
          )
        RETURN f.id          AS fieldId,
               f.name        AS fieldName,
               f.tenant_id   AS fieldTenantId,
               f.enum_values AS enumValuesJson,
               t.name        AS typeName,
               t.scope       AS typeScope,
               t.tenant_id   AS typeTenantId,
               ${SHARED_TYPE_PREDICATE} AS shared
        ORDER BY t.name, f.name
      `, { tenantId, includeShared, sharedScopes: SHARED_SCOPES, systemTenant: SYSTEM_TENANT }),
    )

    const fields: FieldRecord[] = fieldResult.records
      .map((r) => {
        const raw = r.get('enumValuesJson') as string
        let enumValues: string[] = []
        try { enumValues = JSON.parse(raw) as string[] } catch { /* skip */ }
        return {
          fieldId:      r.get('fieldId')      as string,
          fieldName:    r.get('fieldName')    as string,
          typeName:     r.get('typeName')     as string,
          typeScope:    r.get('typeScope')    as string,
          typeTenantId: r.get('typeTenantId') as string,
          shared:       r.get('shared')       as boolean,
          fieldTenantId: r.get('fieldTenantId') as string | null,
          enumValues,
        }
      })
      .filter((f) => f.enumValues.length > 0)

    console.info(`  Found ${fields.length} field(s) with inline enum_values to evaluate.\n`)

    // 3. Match and migrate
    let migrated = 0
    let created  = 0
    let _alreadyDone = 0

    for (const field of fields) {
      // A shared field may only reference a system enum (never a tenant enum).
      // Un campo condiviso può essere agganciato SOLO a un vocabolario
      // SPEDITO. Il filtro era su `e.isSystem`, cioè sul flag di protezione che
      // il vecchio seed scriveva anche sulle copie per tenant: passavano i
      // vocabolari di un cliente.
      const candidates = field.shared ? enumDefs.filter((e) => e.tenantId === SYSTEM_TENANT) : enumDefs
      let match = findMatch(field.enumValues, field.fieldName, candidates)

      if (!match) {
        // Auto-create a custom EnumTypeDefinition for this unmatched field.
        // Shared field → system enum; tenant field → tenant enum.
        const enumName  = toSnakeCase(field.fieldName)
        const enumLabel = field.fieldName
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (c) => c.toUpperCase())
          .trim()
        const scope      = scopeFromType(field.typeScope)
        const enumTenant = field.shared ? SYSTEM_TENANT : tenantId
        const isSystem   = field.shared
        const newId      = uuidv4()
        const now        = new Date().toISOString()

        const createResult = await session.executeWrite((tx) =>
          tx.run(`
            MERGE (e:EnumTypeDefinition {name: $name, tenant_id: $enumTenant})
            ON CREATE SET
              e.id         = $id,
              e.label      = $label,
              e.values     = $values,
              e.is_system  = $isSystem,
              e.scope      = $scope,
              e.created_at = $now,
              e.updated_at = $now
            ON MATCH SET
              e.values     = $values,
              e.updated_at = $now
            RETURN e.id AS id, e.name AS name, e.label AS label, coalesce(e.is_system, false) AS isSystem
          `, {
            name: enumName, enumTenant, id: newId, isSystem,
            label: enumLabel, values: field.enumValues, scope, now,
          }),
        )

        const createdRec = createResult.records[0]
        if (!createdRec) throw new Error(`Enum "${enumName}" (tenant ${enumTenant}): MERGE returned no record`)
        match = {
          id:       createdRec.get('id')       as string,
          name:     createdRec.get('name')     as string,
          label:    createdRec.get('label')    as string,
          values:   field.enumValues,
          isSystem: createdRec.get('isSystem') as boolean,
          tenantId: enumTenant,
        }

        // Also add to local enumDefs so subsequent fields can reuse it
        enumDefs.push(match)
        console.info(`  NEW   ${field.typeName}.${field.fieldName} → created ${isSystem ? 'system ' : ''}enum "${match.name}" [${field.enumValues.join(', ')}]`)
        created++
      }

      // La guardia dell'intestazione, come codice: un vocabolario di un altro
      // cliente non si aggancia a niente, e il vocabolario del tenant non si
      // aggancia a un campo condiviso (i suoi valori finirebbero negli altri
      // clienti). Errore rumoroso: lo script si ferma, non salta la riga.
      assertEnumLinkable(
        { id: match.id, name: match.name, tenantId: match.tenantId },
        { name: field.fieldName, scope: field.shared ? field.typeScope : 'tenant', tenantId: field.fieldTenantId },
        tenantId,
      )

      // Create USES_ENUM relation (MERGE = idempotent) and remove inline
      // enum_values. The field is matched THROUGH its parent type, constrained
      // by the type's tenant: a field of another tenant is never touched.
      const writeResult = await session.executeWrite((tx) =>
        tx.run(`
          MATCH (t:CITypeDefinition {tenant_id: $typeTenantId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId})
          MATCH (e:EnumTypeDefinition {id: $enumId})
          MERGE (f)-[:USES_ENUM]->(e)
          WITH f
          SET f.enum_values = null
          RETURN f.id AS id
        `, { fieldId: field.fieldId, typeTenantId: field.typeTenantId, enumId: match.id }),
      )

      if (writeResult.records.length) {
        if (created === 0 || enumDefs[enumDefs.length - 1]?.id !== match.id) {
          console.info(`  OK    ${field.typeName}.${field.fieldName} → ${match.name} (${match.label})`)
        }
        migrated++
      } else {
        console.info(`  WARN  ${field.typeName}.${field.fieldName} — write returned no records`)
        _alreadyDone++
      }
    }

    // 4. Count already-migrated fields within the same scope as step 2
    const alreadyResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)-[:USES_ENUM]->(:EnumTypeDefinition)
        WHERE f.field_type = 'enum'
          AND (
            (t.tenant_id = $tenantId AND NOT ${SHARED_TYPE_PREDICATE})
            OR ($includeShared AND ${SHARED_TYPE_PREDICATE})
          )
        RETURN count(DISTINCT f) AS total
      `, { tenantId, includeShared, sharedScopes: SHARED_SCOPES, systemTenant: SYSTEM_TENANT }),
    )
    const totalLinked = (alreadyResult.records[0]?.get('total') as { toNumber(): number })?.toNumber?.() ?? 0

    console.info(`
╔═══════════════════════════════════════════╗
║  Migration complete for tenant: ${tenantId.padEnd(8)} ║
╠═══════════════════════════════════════════╣
║  Fields migrated (matched)  : ${String(migrated).padEnd(14)} ║
║  Enums auto-created         : ${String(created).padEnd(14)} ║
║  Total fields with USES_ENUM: ${String(totalLinked).padEnd(12)} ║
╚═══════════════════════════════════════════╝
`)
  } finally {
    await session.close()
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
