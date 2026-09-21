/**
 * LA COPERTURA DELLA KNOWLEDGE BASE (20 set 2026, prerequisito dell'ondata 6).
 *
 * La regola che questi test tengono ferma è una sola, ed è quella che separa
 * una misura utile da una misura che mente: **«non c'è» e «non lo sappiamo»
 * sono due cose diverse**. Su un cliente i cui articoli sono stati scritti
 * tutti a mano, nessuno dichiara la propria origine — e «questa categoria non
 * ha articoli» è vero per costruzione, quindi non vuol dire niente.
 */
import { describe, it, expect } from 'vitest'
import { coperturaLeggibile, COLLEGA_CYPHER, type CoperturaKB } from '../kbCoverage.js'

const copertura = (e: Partial<CoperturaKB> = {}): CoperturaKB => ({
  categorie: [], articoliConOrigine: 0, articoliSenzaOrigine: 0, finestraGiorni: 90, ...e,
})

describe('«non c\'è» e «non lo sappiamo» sono due cose diverse', () => {
  it('con zero articoli che dichiarano un\'origine la copertura NON si legge', () => {
    // È il caso di ogni cliente di oggi: articoli scritti a mano, nessuna
    // relazione. Leggere qui uno zero come «scoperto» vorrebbe dire aprire
    // una proposta per ogni categoria, tutte sbagliate.
    expect(coperturaLeggibile(copertura({
      categorie: [{ category: 'Rete', incidenti: 40, articoli: 0 }],
      articoliSenzaOrigine: 28,
    }))).toBe(false)
  })

  it('basta UN articolo con origine perché il meccanismo sia in funzione', () => {
    // Non una percentuale scelta a caso: da quel momento in poi l'assenza di
    // un collegamento su una categoria è un'informazione, non un'assenza di
    // informazione.
    expect(coperturaLeggibile(copertura({ articoliConOrigine: 1, articoliSenzaOrigine: 27 }))).toBe(true)
  })
})

describe('la query della copertura', () => {
  it('collega l\'articolo all\'incident con un MERGE, non con un CREATE', () => {
    // Ripetere la creazione di una bozza dallo stesso incident non deve
    // lasciare due relazioni identiche.
    expect(COLLEGA_CYPHER).toContain('MERGE (a)-[:WRITTEN_FROM]->(i)')
  })

  it('e tutti e due i nodi sono ancorati al tenant', () => {
    expect(COLLEGA_CYPHER).toContain('(a:KBArticle {id: $articleId, tenant_id: $tenantId})')
    expect(COLLEGA_CYPHER).toContain('(i:Incident  {id: $incidentId, tenant_id: $tenantId})')
  })
})
