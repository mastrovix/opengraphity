/**
 * Verifica «Cosa resta cablato», ondata 2 (scelta del proprietario): la
 * categoria di una voce del catalogo diventa un valore del vocabolario
 * `category` del Dizionario — prima era testo scritto a mano («Accessi»,
 * «Hardware») — e la richiesta la eredita, così le policy SLA per categoria
 * valgono anche per le richieste.
 *
 * Conversione: il testo di oggi si confronta, senza distinguere maiuscole, con
 * i valori del vocabolario del cliente e con le loro etichette in ogni lingua
 * («Accessi» → `access`). Se corrisponde, la voce prende quel valore. Se no, il
 * testo resta in `legacy_category`, la categoria resta vuota, lo si dice qui e
 * la diagnostica lo segnala finché l'amministratore non ne sceglie una.
 *
 * Idempotente: tocca solo le voci con una categoria che non è già un valore.
 */
import type { Migration } from '@opengraphity/neo4j'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'

const tag = '[20260925_1120_catalog_item_category_vocabulary]'

export const catalogItemCategoryVocabulary: Migration = {
  id: '20260925_1120_catalog_item_category_vocabulary',
  description: 'ServiceCatalogItem.category: dal testo libero a un valore del vocabolario category',
  async up(session) {
    const rows = await session.run(`
      MATCH (ci:ServiceCatalogItem) WHERE ci.category IS NOT NULL AND ci.category <> ''
      OPTIONAL MATCH (own:EnumTypeDefinition {name: 'category', tenant_id: ci.tenant_id})
      OPTIONAL MATCH (shipped:EnumTypeDefinition {name: 'category', tenant_id: $systemTenant})
      WITH ci, coalesce(own, shipped) AS vocab
      WHERE vocab IS NULL OR NOT ci.category IN vocab.values
      RETURN ci.id AS id, ci.tenant_id AS tenant, ci.name AS name, ci.category AS text,
             coalesce(vocab.values, []) AS values, vocab.value_labels AS labels
    `, { systemTenant: SYSTEM_TENANT })

    for (const r of rows.records) {
      const text = String(r.get('text'))
      const values = r.get('values') as string[]
      let labels: Record<string, Record<string, string>> = {}
      const rawLabels = r.get('labels') as unknown
      if (typeof rawLabels === 'string' && rawLabels !== '') {
        try { labels = JSON.parse(rawLabels) as Record<string, Record<string, string>> } catch { labels = {} }
      }
      const wanted = text.trim().toLowerCase()
      const match = values.find((v) => v.toLowerCase() === wanted
        || Object.values(labels[v] ?? {}).some((l) => typeof l === 'string' && l.trim().toLowerCase() === wanted))

      if (match) {
        await session.run('MATCH (ci:ServiceCatalogItem {id: $id}) SET ci.category = $value', { id: r.get('id'), value: match })
        console.log(`${tag} ${String(r.get('tenant'))}: «${String(r.get('name'))}» ${text} → ${match}`)
      } else {
        await session.run('MATCH (ci:ServiceCatalogItem {id: $id}) SET ci.legacy_category = ci.category, ci.category = null', { id: r.get('id') })
        console.log(`${tag} ${String(r.get('tenant'))}: «${String(r.get('name'))}» «${text}» non corrisponde a nessuna categoria del Dizionario — da scegliere in Admin → Service catalog`)
      }
    }
  },
}
