/**
 * LE ETICHETTE DEI CAMPI SPEDITI, in inglese (giro nel browser del 14 set 2026).
 *
 * I campi e le relazioni dei tipi spediti (`scope` base e itil, nodi di
 * sistema) portavano l'etichetta in italiano da quando il seed è stato
 * scritto: con il prodotto in inglese le business rule offrivano «Titolo
 * (text)» e «Stato (enum)», i widget «Severità (enum)». La lingua del prodotto
 * è l'inglese per default e l'italiano una scelta del cliente: il nodo porta
 * l'inglese, e il web mostra l'italiano (chiavi `metamodel.shipped.*`) solo
 * finché l'etichetta è ancora quella spedita — un'etichetta rinominata dal
 * cliente è sua e si mostra com'è.
 *
 * Conservativa: riscrive solo dove l'etichetta è ESATTAMENTE l'italiano
 * spedito (lista congelata qui sotto). Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

/** nome del campo → etichetta italiana spedita e il suo inglese. Congelata al 22 set 2026. */
const CAMPI: Readonly<Record<string, { it: string; en: string }>> = {
  title:           { it: 'Titolo',          en: 'Title' },
  description:     { it: 'Descrizione',     en: 'Description' },
  status:          { it: 'Stato',           en: 'Status' },
  severity:        { it: 'Severità',        en: 'Severity' },
  category:        { it: 'Categoria',       en: 'Category' },
  created_at:      { it: 'Creato il',       en: 'Created at' },
  updated_at:      { it: 'Aggiornato il',   en: 'Updated at' },
  resolved_at:     { it: 'Risolto il',      en: 'Resolved at' },
  impact:          { it: 'Impatto',         en: 'Impact' },
  urgency:         { it: 'Urgenza',         en: 'Urgency' },
  priority:        { it: 'Priorità',        en: 'Priority' },
  type:            { it: 'Tipo',            en: 'Type' },
  risk:            { it: 'Rischio',         en: 'Risk' },
  scheduled_start: { it: 'Inizio previsto', en: 'Scheduled start' },
  scheduled_end:   { it: 'Fine prevista',   en: 'Scheduled end' },
  name:            { it: 'Nome',            en: 'Name' },
  environment:     { it: 'Ambiente',        en: 'Environment' },
  notes:           { it: 'Note',            en: 'Notes' },
  createdAt:       { it: 'Creato il',       en: 'Created at' },
  updatedAt:       { it: 'Aggiornato il',   en: 'Updated at' },
  certificateType: { it: 'Tipo',            en: 'Type' },
  expiresAt:       { it: 'Scadenza',        en: 'Expires at' },
  port:            { it: 'Porta',           en: 'Port' },
  serialNumber:    { it: 'Numero Seriale',  en: 'Serial number' },
  version:         { it: 'Versione',        en: 'Version' },
}

const RELAZIONI: Readonly<Record<string, { it: string; en: string }>> = {
  dependencies: { it: 'Dipendenze', en: 'Dependencies' },
  dependents:   { it: 'Dipendenti', en: 'Dependents' },
}

export const shippedMetamodelLabels: Migration = {
  id:          '20260922_1020_shipped_metamodel_labels',
  description: 'Etichette dei campi e delle relazioni dei tipi spediti: dall\'italiano all\'inglese (il web traduce)',

  async up(session) {
    const campi = Object.entries(CAMPI).map(([name, l]) => ({ name, it: l.it, en: l.en }))
    const relazioni = Object.entries(RELAZIONI).map(([name, l]) => ({ name, it: l.it, en: l.en }))
    const now = new Date().toISOString()
    const f = await session.run(
      `UNWIND $campi AS c
       MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition {name: c.name})
       WHERE t.scope IN ['base', 'itil'] AND f.label = c.it
       SET f.label = c.en, f.updated_at = $now
       RETURN count(f) AS n`,
      { campi, now },
    )
    const r = await session.run(
      `UNWIND $relazioni AS c
       MATCH (t:CITypeDefinition)-[:HAS_RELATION]->(r:CIRelationDefinition {name: c.name})
       WHERE t.scope IN ['base', 'itil'] AND r.label = c.it
       SET r.label = c.en, r.updated_at = $now
       RETURN count(r) AS n`,
      { relazioni, now },
    )
    console.log(`[20260922_1020] etichette in inglese: ${Number(f.records[0]?.get('n') ?? 0)} campi, ${Number(r.records[0]?.get('n') ?? 0)} relazioni`)
  },
}
