/**
 * Migration script — links existing CIFieldDefinition nodes that have
 * inline enum_values to the matching EnumTypeDefinition via USES_ENUM.
 *
 * Matching strategy:
 *   - Exact match:  field values == enum values (ignoring order)
 *   - Subset match: field values ⊆ enum values
 *   In both cases the USES_ENUM relation is created (MERGE) and
 *   enum_values is removed from the field node.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/migrate-enum-references.ts --slug <tenant>
 *
 * Idempotent: safe to run multiple times.
 */

import { parseArgs } from 'node:util'
import { getSession } from '@opengraphity/neo4j'

// ── Args ──────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: { 'slug': { type: 'string' } },
})
const tenantId = args['slug']
if (!tenantId) {
  console.error('Usage: tsx migrate-enum-references.ts --slug <tenant>')
  process.exit(1)
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnumDef {
  id:     string
  name:   string
  label:  string
  values: string[]
}

interface FieldRecord {
  fieldId:      string
  fieldName:    string
  typeName:     string
  enumValues:   string[]
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

async function main() {
  console.info(`\n▶ Migrating enum fields for tenant: ${tenantId}\n`)

  const session = getSession(undefined, 'WRITE')

  try {
    // 1. Load all EnumTypeDefinitions available for this tenant
    const enumResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition)
        WHERE e.tenant_id = $tenantId OR e.is_system = true
        RETURN e.id     AS id,
               e.name   AS name,
               e.label  AS label,
               e.values AS values
        ORDER BY e.name
      `, { tenantId }),
    )

    const enumDefs: EnumDef[] = enumResult.records.map((r) => ({
      id:     r.get('id')     as string,
      name:   r.get('name')   as string,
      label:  r.get('label')  as string,
      values: r.get('values') as string[],
    }))

    console.info(`  Found ${enumDefs.length} EnumTypeDefinition(s):`)
    for (const e of enumDefs) {
      console.info(`    • ${e.name} [${e.values.join(', ')}]`)
    }
    console.info('')

    // 2. Load all CIFieldDefinitions with field_type=enum, with enum_values,
    //    but WITHOUT an existing USES_ENUM relation
    const fieldResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)
        WHERE f.field_type = 'enum'
          AND f.enum_values IS NOT NULL
          AND f.enum_values <> '[]'
          AND f.enum_values <> ''
          AND NOT (f)-[:USES_ENUM]->(:EnumTypeDefinition)
          AND (t.tenant_id = $tenantId OR t.scope IN ['base', 'itil'])
        RETURN f.id          AS fieldId,
               f.name        AS fieldName,
               f.enum_values AS enumValuesJson,
               t.name        AS typeName
        ORDER BY t.name, f.name
      `, { tenantId }),
    )

    const fields: FieldRecord[] = fieldResult.records
      .map((r) => {
        const raw = r.get('enumValuesJson') as string
        let enumValues: string[] = []
        try { enumValues = JSON.parse(raw) as string[] } catch { /* skip */ }
        return {
          fieldId:    r.get('fieldId')   as string,
          fieldName:  r.get('fieldName') as string,
          typeName:   r.get('typeName')  as string,
          enumValues,
        }
      })
      .filter((f) => f.enumValues.length > 0)

    console.info(`  Found ${fields.length} field(s) with inline enum_values to evaluate.\n`)

    // 3. Match and migrate
    let migrated = 0
    let skipped  = 0
    let alreadyDone = 0

    for (const field of fields) {
      const match = findMatch(field.enumValues, field.fieldName, enumDefs)

      if (!match) {
        console.info(`  SKIP  ${field.typeName}.${field.fieldName} [${field.enumValues.join(', ')}] — no matching enum found`)
        skipped++
        continue
      }

      // Create USES_ENUM relation (MERGE = idempotent) and remove inline enum_values
      const writeResult = await session.executeWrite((tx) =>
        tx.run(`
          MATCH (f:CIFieldDefinition {id: $fieldId})
          MATCH (e:EnumTypeDefinition {id: $enumId})
          MERGE (f)-[:USES_ENUM]->(e)
          WITH f
          SET f.enum_values = null
          RETURN f.id AS id
        `, { fieldId: field.fieldId, enumId: match.id }),
      )

      if (writeResult.records.length) {
        console.info(`  OK    ${field.typeName}.${field.fieldName} → ${match.name} (${match.label})`)
        migrated++
      } else {
        console.info(`  WARN  ${field.typeName}.${field.fieldName} — write returned no records`)
        alreadyDone++
      }
    }

    // 4. Count already-migrated fields (have USES_ENUM but enum_values still present or removed)
    const alreadyResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (f:CIFieldDefinition)-[:USES_ENUM]->(:EnumTypeDefinition)
        WHERE f.field_type = 'enum'
        RETURN count(f) AS total
      `, {}),
    )
    const totalLinked = (alreadyResult.records[0]?.get('total') as { toNumber(): number })?.toNumber?.() ?? 0

    console.info(`
╔═══════════════════════════════════════════╗
║  Migration complete for tenant: ${tenantId!.padEnd(8)} ║
╠═══════════════════════════════════════════╣
║  Fields migrated this run : ${String(migrated).padEnd(14)} ║
║  Fields skipped (no match): ${String(skipped).padEnd(14)} ║
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
