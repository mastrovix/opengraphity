/**
 * La lettura del metamodello ITIL (`incident`, `change`, `problem`,
 * `service_request`) condivisa fra le query GraphQL (`itilTypeResolvers`) e il
 * catalogo delle entità dei report (`navigableGraph`). Le regole di visibilità
 * (campi e vocabolari del tenant più quelli spediti) sono descritte in testa a
 * `graphql/resolvers/itilTypeResolvers.ts`.
 */
import type { Session } from 'neo4j-driver'
import {
  SYSTEM_TENANT, enumScopeClause, loadTenantEnumOverrides, applyEnumOverrides,
  type EnumOverride, type EnumRow,
} from './enumScope.js'

type Props = Record<string, unknown>

/** Campi visibili: i propri più quelli spediti. Mai quelli di un altro cliente. */
export const FIELD_SCOPE = `f.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']`

// ── mapITILField ──────────────────────────────────────────────────────────────

/** C-28: un JSON corrotto dice cos'è e da dove viene, non un SyntaxError nudo. */
function parseJsonArray(raw: string, what: string): unknown[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e) {
    throw new Error(`${what} is not valid JSON (${e instanceof Error ? e.message : String(e)}): ${raw.slice(0, 80)}`, { cause: e })
  }
  if (!Array.isArray(parsed)) throw new Error(`${what} is not a JSON array: ${raw.slice(0, 80)}`)
  return parsed
}

function parseInlineEnumValues(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return []
  return parseJsonArray(raw, 'enum_values') as string[]
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
    // Ondata 4: il portale offre all'utente finale solo i campi marcati.
    visibleToEndUser: f['visible_to_end_user'] === true,
    // Secondo giro UI del 15 set 2026: in quali fasi si vede e si modifica (lib/customFieldSteps.ts).
    stepVisibilityRaw:  (f['step_visibility']  ?? null) as string | null,
    stepEditabilityRaw: (f['step_editability'] ?? null) as string | null,
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
    return parseJsonArray(raw, `Dictionary "${name}": values`) as string[]
  }
  return []
}

/**
 * Applica la personalizzazione del tenant (il suo vocabolario con lo stesso
 * nome vince) e mappa le righe. La precedenza risultante è quella del
 * contratto: vocabolario del tenant > agganciato di sistema > `enum_values`
 * inline del campo (l'inline lo usa `mapITILField` quando non c'è aggancio).
 */
export function mapFieldRows(rows: readonly ITILFieldRow[], overrides: Map<string, EnumOverride>) {
  return applyEnumOverrides(rows, overrides)
    .map((r) => {
      const enumRef = r.enumId
        ? { id: r.enumId, name: r.enumName ?? '', values: toValues(r.enumValues, r.enumName ?? r.enumId) }
        : undefined
      return mapITILField(r.props, enumRef)
    })
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
}

/**
 * I tipi ITIL attivi con i campi visibili al tenant e i vocabolari
 * personalizzati applicati. Lo leggono la query `itilTypes` e il catalogo
 * delle entità dei report (`lib/navigableGraph.ts`): una lettura sola, così un
 * campo aggiunto dal cliente arriva in entrambi.
 */
export async function loadITILTypes(session: Session, tenantId: string) {
  const overrides = await loadTenantEnumOverrides(session, tenantId)
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
      { tenantId },
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
      name:             t['name'] as string,
      label:            t['label'] as string,
      neo4jLabel:       (t['neo4j_label'] as string | null) ?? null,
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
}

