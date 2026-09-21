/**
 * DA DOVE VIENE UN ARTICOLO, E CHE COSA COPRE
 * (20 set 2026, prerequisito dell'ondata 6).
 *
 * ## Il difetto
 * Fra un articolo della Knowledge Base e gli incident non esisteva NESSUN
 * collegamento. Non una relazione, non una proprietà: `createKbDraftFromIncident`
 * sapeva da quale incident stava scrivendo e buttava via quell'informazione
 * un istante dopo averla usata. Di conseguenza la domanda che l'ondata 6
 * doveva porre — «questa categoria di problemi ricorre e non ha un articolo?»
 * — non era calcolabile.
 *
 * E i due `category` non si parlano: un incident usa il vocabolario
 * `category` (di solito un servizio), un articolo usa `kb_category` (di solito
 * un argomento). Mapparli a forza sarebbe stato inventare una corrispondenza
 * che nessuno ha dichiarato.
 *
 * ## La scelta
 * Non si mappano i vocabolari: si registra il FATTO. Quando un articolo nasce
 * da un incident si scrive
 *
 *     (:KBArticle)-[:WRITTEN_FROM]->(:Incident)
 *
 * e da lì la copertura di una categoria si ricava senza inventare niente:
 * una categoria è coperta se esiste un articolo scritto a partire da un
 * incident di quella categoria.
 *
 * ## Il limite, dichiarato invece che nascosto
 * Gli articoli che esistevano PRIMA non hanno la relazione, e non c'è modo
 * onesto di ricostruirla: nessun dato dice da dove venivano. Quindi su un
 * cliente con venti articoli scritti a mano ogni categoria risulterebbe
 * «scoperta», e sarebbe un falso allarme per venti volte su venti.
 *
 * Per questo `coperturaPerCategoria()` restituisce anche `articoliSenzaOrigine`
 * e `articoliConOrigine`, e chi legge deve usarli: finché nessun articolo ha
 * un'origine, la copertura non si SA — non è zero. È la differenza fra «non
 * c'è» e «non lo sappiamo», e confonderle è il modo in cui una misura
 * comincia a mentire.
 */
import { getSession, toNumber } from '@opengraphity/neo4j'

export interface CoperturaCategoria {
  category: string
  /** Quanti incident di questa categoria nella finestra. */
  incidenti: number
  /** Quanti articoli nascono da un incident di questa categoria. */
  articoli:  number
}

export interface CoperturaKB {
  categorie: CoperturaCategoria[]
  /** Articoli che dichiarano da dove vengono. */
  articoliConOrigine:   number
  /** Articoli che non lo dichiarano: scritti a mano, o prima di questa relazione. */
  articoliSenzaOrigine: number
  finestraGiorni: number
}

/**
 * `true` quando la copertura si può leggere come un fatto.
 *
 * Con zero articoli che dichiarano un'origine, «questa categoria non ha
 * articoli» è vero per costruzione e non vuol dire niente. La soglia non è
 * una percentuale scelta a caso: basta che UN articolo dichiari la propria
 * origine perché il meccanismo sia in funzione — da lì in poi l'assenza di
 * un collegamento su una categoria è un'informazione.
 */
export function coperturaLeggibile(c: CoperturaKB): boolean {
  return c.articoliConOrigine > 0
}

/** La relazione, scritta quando un articolo nasce da un incident. */
export const COLLEGA_CYPHER = `
  MATCH (a:KBArticle {id: $articleId, tenant_id: $tenantId})
  MATCH (i:Incident  {id: $incidentId, tenant_id: $tenantId})
  MERGE (a)-[:WRITTEN_FROM]->(i)
`

/**
 * Registra da quale incident è nato un articolo.
 *
 * Non alza: un collegamento mancato non deve togliere all'utente l'articolo
 * che aveva chiesto. Chi chiama decide se dirlo nei log — qui si torna
 * `false` e si va avanti.
 */
export async function collegaArticoloAIncident(
  tenantId: string, articleId: string, incidentId: string,
): Promise<boolean> {
  const session = getSession(undefined, 'WRITE')
  try {
    const r = await session.run(COLLEGA_CYPHER, { tenantId, articleId, incidentId })
    return r.summary.counters.updates().relationshipsCreated > 0
  } catch {
    return false
  } finally {
    await session.close()
  }
}

/**
 * La copertura per categoria di incident.
 *
 * Una query sola, e un `OPTIONAL MATCH` che parte dagli incident: le
 * categorie senza nessun articolo devono comparire con `articoli: 0`, ed è
 * l'unica riga che interessa davvero. Un `MATCH` le avrebbe fatte sparire —
 * che è il modo classico in cui una query di copertura mostra solo ciò che è
 * già coperto.
 */
export async function coperturaPerCategoria(tenantId: string, finestraGiorni = 90): Promise<CoperturaKB> {
  const da = new Date(Date.now() - finestraGiorni * 86_400_000).toISOString()
  const session = getSession()
  try {
    const perCategoria = await session.run(`
      MATCH (i:Incident {tenant_id: $tenantId})
      WHERE i.created_at >= $da AND i.category IS NOT NULL AND i.category <> ''
      WITH i.category AS category, count(i) AS incidenti
      OPTIONAL MATCH (a:KBArticle {tenant_id: $tenantId})-[:WRITTEN_FROM]->(j:Incident {tenant_id: $tenantId})
        WHERE j.category = category
      RETURN category, incidenti, count(DISTINCT a) AS articoli
      ORDER BY incidenti DESC
    `, { tenantId, da })

    const origini = await session.run(`
      MATCH (a:KBArticle {tenant_id: $tenantId})
      RETURN count(a) AS totali,
             count(CASE WHEN EXISTS { (a)-[:WRITTEN_FROM]->(:Incident) } THEN 1 END) AS conOrigine
    `, { tenantId })

    const totali     = toNumber(origini.records[0]?.get('totali') ?? 0)
    const conOrigine = toNumber(origini.records[0]?.get('conOrigine') ?? 0)

    return {
      categorie: perCategoria.records.map((r) => ({
        category:  r.get('category') as string,
        incidenti: toNumber(r.get('incidenti')),
        articoli:  toNumber(r.get('articoli')),
      })),
      articoliConOrigine:   conOrigine,
      articoliSenzaOrigine: totali - conOrigine,
      finestraGiorni,
    }
  } finally {
    await session.close()
  }
}
