/**
 * Revisione del 14 set 2026 · F9 ed F5.
 *
 *  1. Il seme dei vocabolari spediti: nasce `kb_category` (etichette e colori)
 *     e i vocabolari spediti ricevono i colori che il web aveva nelle sue
 *     tabelle (priorità, severità, stato del CI, severità degli allarmi).
 *  2. Le COPIE dei clienti di quei vocabolari ricevono gli stessi colori, solo
 *     per i valori che hanno ancora e solo se non ne hanno già: un colore scelto
 *     dal cliente non si tocca.
 *  3. Le categorie KB già usate da un cliente e assenti dal vocabolario spedito
 *     non si perdono: il cliente riceve la sua copia di `kb_category` con quei
 *     valori in coda, e lo si dice.
 *
 * Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'
import { seedSystemEnumTypes, SYSTEM_ENUMS } from '../../lib/seedEnumTypes.js'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'

const tag = '[20260924_1020_value_colors_kb_category]'

export const valueColorsKbCategory: Migration = {
  id: '20260924_1020_value_colors_kb_category',
  description: 'Colori per valore nel Dizionario (F9) e vocabolario kb_category (F5)',
  async up(session) {
    await seedSystemEnumTypes(session)
    console.log(`${tag} vocabolari spediti riseminati (colori + kb_category)`)

    for (const e of SYSTEM_ENUMS.filter((x) => x.valueColors)) {
      const r = await session.run(`
        MATCH (c:EnumTypeDefinition {name: $name})
        WHERE c.tenant_id <> $systemTenant AND c.value_colors IS NULL
        WITH c, [v IN c.values WHERE v IN keys($colors)] AS colored
        WHERE size(colored) > 0
        SET c.value_colors = apoc.convert.toJson(apoc.map.fromPairs([v IN colored | [v, $colors[v]]])), c.updated_at = $now
        RETURN c.tenant_id AS tenant, size(colored) AS n
      `, { name: e.name, systemTenant: SYSTEM_TENANT, colors: e.valueColors, now: new Date().toISOString() })
      for (const row of r.records) console.log(`${tag} ${String(row.get('tenant'))}: ${e.name} riceve ${String(row.get('n'))} colori`)
    }

    const shipped = SYSTEM_ENUMS.find((x) => x.name === 'kb_category')!
    const extras = await session.run(`
      MATCH (a:KBArticle) WHERE a.category IS NOT NULL AND a.category <> ''
      OPTIONAL MATCH (own:EnumTypeDefinition {name: 'kb_category', tenant_id: a.tenant_id})
      WITH a.tenant_id AS tenant, own, collect(DISTINCT a.category) AS used
      WITH tenant, own, [c IN used WHERE NOT c IN coalesce(own.values, $shippedValues)] AS missing
      WHERE size(missing) > 0
      RETURN tenant, own IS NOT NULL AS hasCopy, missing
    `, { shippedValues: shipped.values })
    for (const row of extras.records) {
      const tenant = String(row.get('tenant'))
      const missing = row.get('missing') as string[]
      const now = new Date().toISOString()
      if (row.get('hasCopy') === true) {
        await session.run(`
          MATCH (e:EnumTypeDefinition {name: 'kb_category', tenant_id: $tenant})
          SET e.values = e.values + $missing, e.updated_at = $now
        `, { tenant, missing, now })
      } else {
        await session.run(`
          MATCH (s:EnumTypeDefinition {name: 'kb_category', tenant_id: $systemTenant})
          CREATE (e:EnumTypeDefinition {
            id: $id, tenant_id: $tenant, name: s.name, label: s.label, values: s.values + $missing,
            is_system: false, scope: s.scope, default_value: s.default_value,
            value_labels: s.value_labels, value_colors: s.value_colors, created_at: $now, updated_at: $now
          })
        `, { systemTenant: SYSTEM_TENANT, tenant, missing, id: uuidv4(), now })
      }
      console.log(`${tag} ${tenant}: categorie KB in uso aggiunte al suo vocabolario kb_category: ${missing.join(', ')}`)
    }
  },
}
