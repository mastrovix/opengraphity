/**
 * «Produttivita d'ufficio» → «Office productivity» (secondo giro UI del 15 set
 * 2026, note minori).
 *
 * La 1700 ha seminato `service_criticality` nei termini del settore, in inglese
 * anche in italiano per scelta del proprietario («Mission critical», «Business
 * critical», «Business operational»), e il quarto valore in italiano e senza
 * accento. Nel form del CI si leggevano tre valori inglesi e uno italiano
 * sbagliato. Qui il quarto segue la stessa scelta degli altri tre.
 *
 * Si tocca solo l'etichetta italiana ancora UGUALE a quella seminata: sul nodo
 * di sistema e sulle copie dei clienti che l'hanno ereditata con «Personalizza».
 * Un'etichetta che un cliente ha cambiato resta sua. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

const SEMINATA = "Produttivita d'ufficio"
const CORRETTA = 'Office productivity'

export const officeProductivityLabel: Migration = {
  id:          '20260930_1000_office_productivity_label',
  description: "service_criticality: l'etichetta italiana di office_productivity segue i termini del settore come le altre",

  async up(session) {
    const r = await session.run(
      `MATCH (e:EnumTypeDefinition {name: 'service_criticality'}) WHERE e.value_labels IS NOT NULL
       RETURN e.id AS id, e.tenant_id AS tenantId, e.value_labels AS labels`,
    )
    let corretti = 0
    for (const rec of r.records) {
      const labels = JSON.parse(String(rec.get('labels'))) as Record<string, Record<string, string>>
      if (labels.office_productivity?.it !== SEMINATA) continue
      labels.office_productivity = { ...labels.office_productivity, it: CORRETTA }
      await session.run(
        `MATCH (e:EnumTypeDefinition {id: $id}) SET e.value_labels = $labels, e.updated_at = $now`,
        { id: rec.get('id'), labels: JSON.stringify(labels), now: new Date().toISOString() },
      )
      corretti += 1
    }
    console.log(`[${officeProductivityLabel.id}] vocabolari corretti: ${corretti}`)
  },
}
