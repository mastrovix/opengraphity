/**
 * A6-2 — la ricerca globale non dipende più dai tipi di CI.
 *
 * ## Il difetto
 * L'indice fulltext `global_search` elencava venti etichette fisse (cinque di
 * ticket più le quindici dei tipi spediti col prodotto). Un indice fulltext
 * **non si estende a runtime**: un tipo creato dal cliente — e i suoi CI — non
 * era cercabile dalla palette, e non lo sarebbe mai diventato senza toccare il
 * codice. In silenzio: la ricerca risponde «nessun risultato».
 *
 * ## Il rimedio
 * L'indice copre i CI per `:ConfigurationItem`, che ogni CI porta (migrazione
 * `20260908_1010`; dal vivo 2049 su 2049). `packages/neo4j/src/init.ts` crea
 * già la definizione nuova sui database nuovi, ma su un database avviato
 * `CREATE FULLTEXT INDEX … IF NOT EXISTS` **non ridefinisce** l'indice
 * esistente: serve un `DROP` seguito da un `CREATE`.
 *
 * ## Perché una riesecuzione non lascia il sistema senza indice
 *  - si legge la definizione viva (`SHOW INDEXES`): se è già quella giusta la
 *    migrazione non fa niente (quindi `--force` è innocuo);
 *  - `DROP` e `CREATE` sono due statement in **autocommit**, uno dietro
 *    l'altro: se il processo muore in mezzo, la riesecuzione trova «nessun
 *    indice» e lo crea;
 *  - alla fine si **attende che l'indice sia in linea** (`db.awaitIndexes`) e
 *    si verifica che ci sia davvero, altrimenti la migrazione fallisce: un
 *    indice mancante renderebbe muta la ricerca globale, che è il difetto che
 *    questa migrazione chiude.
 */
import type { Migration } from '@opengraphity/neo4j'
import { GLOBAL_SEARCH_LABELS, GLOBAL_SEARCH_PROPERTIES } from '@opengraphity/neo4j'

const INDEX_NAME = 'global_search'
const CREATE_CYPHER =
  `CREATE FULLTEXT INDEX ${INDEX_NAME} IF NOT EXISTS FOR (n:${GLOBAL_SEARCH_LABELS.join('|')}) ` +
  `ON EACH [${GLOBAL_SEARCH_PROPERTIES.map((p) => `n.${p}`).join(', ')}]`

/** Stessa definizione? Confronto per insieme sulle etichette, per ordine sulle proprietà. */
function sameDefinition(labels: string[], properties: string[]): boolean {
  const a = [...labels].sort().join('|')
  const b = [...GLOBAL_SEARCH_LABELS].sort().join('|')
  return a === b && properties.join(',') === GLOBAL_SEARCH_PROPERTIES.join(',')
}

export const globalSearchConfigurationItem: Migration = {
  id: '20260916_1700_global_search_configuration_item',
  description: 'Fulltext global_search sui CI per :ConfigurationItem (un tipo nuovo diventa cercabile)',
  autocommit: true,
  async up(session) {
    const shown = await session.run(
      `SHOW INDEXES YIELD name, labelsOrTypes, properties WHERE name = $name RETURN labelsOrTypes, properties`,
      { name: INDEX_NAME },
    )
    const row = shown.records[0]
    if (row) {
      const labels     = (row.get('labelsOrTypes') ?? []) as string[]
      const properties = (row.get('properties') ?? []) as string[]
      if (sameDefinition(labels, properties)) {
        console.log(`[${globalSearchConfigurationItem.id}] ${INDEX_NAME} già su [${labels.join('|')}] — niente da fare`)
        return
      }
      console.log(`[${globalSearchConfigurationItem.id}] ${INDEX_NAME} era su ${String(labels.length)} etichette [${labels.join('|')}] — si ricrea`)
      await session.run(`DROP INDEX ${INDEX_NAME} IF EXISTS`)
    }

    await session.run(CREATE_CYPHER)
    // 300 s: la ripopolazione di un fulltext su un grafo grande non è istantanea,
    // e una ricerca su un indice non ancora in linea non trova niente.
    await session.run('CALL db.awaitIndexes(300)')

    const after = await session.run(
      `SHOW INDEXES YIELD name, labelsOrTypes, properties, state WHERE name = $name RETURN labelsOrTypes, properties, state`,
      { name: INDEX_NAME },
    )
    const check = after.records[0]
    if (!check) throw new Error(`${INDEX_NAME}: l'indice fulltext non esiste dopo il CREATE — la ricerca globale sarebbe muta`)
    const labels     = (check.get('labelsOrTypes') ?? []) as string[]
    const properties = (check.get('properties') ?? []) as string[]
    const state      = check.get('state') as string
    if (!sameDefinition(labels, properties)) {
      throw new Error(`${INDEX_NAME}: definizione inattesa dopo il CREATE — etichette [${labels.join('|')}], proprietà [${properties.join(',')}]`)
    }
    if (state !== 'ONLINE') {
      throw new Error(`${INDEX_NAME}: indice in stato "${state}" dopo db.awaitIndexes — la ricerca globale non è affidabile`)
    }
    console.log(`[${globalSearchConfigurationItem.id}] ${INDEX_NAME} ONLINE su [${labels.join('|')}]`)
  },
}
