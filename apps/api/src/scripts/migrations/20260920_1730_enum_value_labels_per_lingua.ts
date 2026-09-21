/**
 * Le etichette per valore diventano **una per lingua** (decisione del
 * proprietario, 13 set 2026).
 *
 * La prima versione (migrazioni `1700`/`1710`) teneva una etichetta sola per
 * valore: `{"high": "Alto"}`. Il difetto e' venuto fuori guardando il prodotto
 * con il browser in INGLESE — e ci si arriva da se', perche' la lingua si
 * rileva da `navigator`: il campo «Priorita'» mostrava «BASSA» in
 * un'interfaccia inglese.
 *
 * Ora: `{"high": {"it": "Alto", "en": "High"}}`.
 *
 * ## Cosa fa
 *
 *  - converte ogni mappa dalla forma vecchia alla nuova, mettendo l'etichetta
 *    che c'era sotto `it` (era cio' che quella versione scriveva);
 *  - aggiunge l'INGLESE per i vocabolari spediti, dalla lista congelata qui
 *    sotto. Per i valori che non conosce non inventa niente: la diagnostica li
 *    segnalera' all'admin, che e' l'unico a poterli nominare.
 *
 * Idempotente: una mappa gia' nella forma nuova non viene toccata, e
 * l'inglese si scrive solo dove manca.
 *
 * La lettura accetta ANCORA la forma vecchia e la interpreta come italiano
 * (`parseValueLabels`): un tenant che non ha ancora ricevuto questa migrazione
 * non deve perdere le etichette nel frattempo.
 */
import type { Migration } from '@opengraphity/neo4j'

/**
 * L'INGLESE DI QUESTO GIORNO, CONGELATO. Solo dove non e' il valore stesso con
 * le iniziali maiuscole: quello e' gia' il ripiego, e ripeterlo sarebbe rumore.
 */
const ENUM_VALUE_LABELS_EN: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  category: { network: 'Network', access: 'Access', security: 'Security', other: 'Other' },
  certificate_type: { public: 'Public', external: 'External' },
  change_type: { standard: 'Standard', normal: 'Normal', emergency: 'Emergency' },
  ci_chain: { Application: 'Application', Infrastructure: 'Infrastructure' },
  ci_status: {
    active: 'Active', inactive: 'Inactive', maintenance: 'Under maintenance',
    decommissioned: 'Decommissioned', expired: 'Expired', revoked: 'Revoked',
  },
  environment: {
    production: 'Production', staging: 'Staging', development: 'Development',
    testing: 'Testing', dr: 'Disaster recovery',
  },
  event_severity: { info: 'Info', warning: 'Warning', critical: 'Critical' },
  impact:    { low: 'Low', medium: 'Medium', high: 'High' },
  risk:      { low: 'Low', medium: 'Medium', high: 'High' },
  urgency:   { low: 'Low', medium: 'Medium', high: 'High' },
  risk_band: { low: 'Low', medium: 'Medium', high: 'High' },
  priority:  { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
  severity:  { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
  service_criticality: {
    mission_critical: 'Mission critical', business_critical: 'Business critical',
    business_operational: 'Business operational', office_productivity: 'Office productivity',
  },
  os:            { Windows: 'Windows', Linux: 'Linux' },
  instance_type: { PostgreSQL: 'PostgreSQL', Oracle: 'Oracle', 'SQL Server': 'SQL Server' },
}

export const enumValueLabelsPerLingua: Migration = {
  id:          '20260920_1730_enum_value_labels_per_lingua',
  description: 'Etichette per valore: una per lingua (it + en), con l\'inglese dei vocabolari spediti',

  async up(session) {
    const r = await session.run(
      `MATCH (e:EnumTypeDefinition) WHERE e.value_labels IS NOT NULL
       RETURN e.id AS id, e.tenant_id AS tenant, e.name AS nome, e.value_labels AS etichette`,
    )
    let convertiti = 0
    let inglese = 0
    for (const rec of r.records) {
      const grezzo = rec.get('etichette') as string
      const nome   = rec.get('nome')      as string
      let mappa: Record<string, unknown>
      try { mappa = JSON.parse(grezzo) as Record<string, unknown> } catch {
        console.warn(`[20260920_1730] ${rec.get('tenant') as string}/${nome}: value_labels non e JSON, salto`)
        continue
      }

      const nuova: Record<string, Record<string, string>> = {}
      let cambiato = false
      for (const [valore, v] of Object.entries(mappa)) {
        if (typeof v === 'string') { nuova[valore] = { it: v }; cambiato = true }
        else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          nuova[valore] = { ...(v as Record<string, string>) }
        }
      }
      // L'inglese, solo dove manca e solo per i valori che conosciamo.
      const en = ENUM_VALUE_LABELS_EN[nome]
      if (en) {
        for (const [valore, etichetta] of Object.entries(en)) {
          if (nuova[valore] && nuova[valore]['en'] === undefined) {
            nuova[valore]['en'] = etichetta
            cambiato = true
            inglese += 1
          }
        }
      }
      if (!cambiato) continue
      await session.run(
        `MATCH (e:EnumTypeDefinition {id: $id}) SET e.value_labels = $etichette, e.updated_at = $now`,
        { id: rec.get('id') as string, etichette: JSON.stringify(nuova), now: new Date().toISOString() },
      )
      convertiti += 1
    }
    console.log(`[20260920_1730] vocabolari aggiornati: ${convertiti}, etichette inglesi scritte: ${inglese}`)
  },
}
