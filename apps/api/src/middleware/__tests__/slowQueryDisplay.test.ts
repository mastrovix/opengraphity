/**
 * La query lenta si LEGGE nel pannello (trovato guardando «Query lente» dopo
 * un riavvio).
 *
 * Si registravano i primi 200 caratteri del sorgente così com'era, e le nostre
 * query hanno spesso un commento in testa che spiega perché sono scritte così:
 * al posto della query si leggeva la spiegazione. Con 200 caratteri di budget,
 * un commento lungo se li prende tutti.
 */
import { describe, it, expect } from 'vitest'
import { queryPerIlPannello } from '../metrics.js'

describe('queryPerIlPannello', () => {
  it('toglie il commento in testa e mostra la query', () => {
    const sorgente = `
      // OGNI PARTE nella sua sottoquery (revisione totale · E-36): i sette
      // OPTIONAL MATCH in fila prima del RETURN facevano il prodotto cartesiano
      MATCH (t:CITypeDefinition {tenant_id: $tenantId})
      RETURN t.name AS name
    `
    const vista = queryPerIlPannello(sorgente)
    expect(vista.startsWith('MATCH (t:CITypeDefinition')).toBe(true)
    expect(vista).not.toContain('E-36')
  })

  it('toglie anche i commenti a blocco e quelli a fine riga', () => {
    const vista = queryPerIlPannello('/* nota */ MATCH (n:Tenant) // il tenant\n RETURN n.id AS id')
    expect(vista).toBe('MATCH (n:Tenant) RETURN n.id AS id')
  })

  it('sta su una riga sola: nel pannello ogni query è una riga', () => {
    expect(queryPerIlPannello('MATCH (m:Migration)\n  RETURN m.id AS id\n  ORDER BY m.id'))
      .toBe('MATCH (m:Migration) RETURN m.id AS id ORDER BY m.id')
  })

  it('una query senza commenti resta identica, a parte gli spazi', () => {
    expect(queryPerIlPannello('MATCH (n) RETURN n')).toBe('MATCH (n) RETURN n')
  })
})
