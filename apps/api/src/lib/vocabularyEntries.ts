/**
 * Un vocabolario come lo legge QUESTO cliente, con etichette e colori: la copia
 * del tenant vince su quella spedita (lib/enumScope.ts), come in lettura dal
 * Dizionario. Serve a chi deve restituire valori con la loro etichetta fuori
 * dallo schema degli enum (le categorie KB del portale, per esempio).
 */
import { getSession } from '@opengraphity/neo4j'
import { parseValueLabels, type EnumValueLabels } from './enumValueLabels.js'
import { parseValueColors, type EnumValueColors } from './enumValueColors.js'
import { SYSTEM_TENANT } from './enumScope.js'

export interface VocabularyEntries {
  values: readonly string[]
  labels: EnumValueLabels
  colors: EnumValueColors
}

export async function loadVocabularyEntries(tenantId: string, name: string): Promise<VocabularyEntries> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (e:EnumTypeDefinition {name: $name})
      WHERE e.tenant_id IN [$tenantId, $systemTenant]
      RETURN e.tenant_id AS owner, e.values AS values, e.value_labels AS labels, e.value_colors AS colors
    `, { name, tenantId, systemTenant: SYSTEM_TENANT }))
    const rows = res.records
    const row = rows.find((r) => r.get('owner') === tenantId) ?? rows.find((r) => r.get('owner') === SYSTEM_TENANT)
    if (!row) throw new Error(`Vocabulary "${name}" does not exist for tenant ${tenantId} nor as shipped`)
    const values = row.get('values') as unknown
    if (!Array.isArray(values)) throw new Error(`Vocabulary "${name}" of ${String(row.get('owner'))}: values is not a list`)
    return {
      values: values as string[],
      labels: parseValueLabels(row.get('labels')).labels,
      colors: parseValueColors(row.get('colors')).colors,
    }
  } finally {
    await session.close()
  }
}
