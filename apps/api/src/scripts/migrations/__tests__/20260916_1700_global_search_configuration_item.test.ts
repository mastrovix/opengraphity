/**
 * A6-2 — l'indice fulltext `global_search` deve coprire i CI per
 * `:ConfigurationItem`: un indice fulltext non si estende a runtime, quindi con
 * venti etichette fisse un tipo creato dal cliente non era **mai** cercabile.
 * Qui si pinna: la definizione unica condivisa con `packages/neo4j/src/init.ts`,
 * il DROP prima del CREATE (`IF NOT EXISTS` non ridefinisce), l'idempotenza (se
 * la definizione è già quella giusta non si tocca niente) e il fallimento
 * esplicito se dopo il CREATE l'indice non c'è o non è ONLINE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GLOBAL_SEARCH_LABELS, GLOBAL_SEARCH_PROPERTIES } from '@opengraphity/neo4j'
import { globalSearchConfigurationItem } from '../20260916_1700_global_search_configuration_item.js'
import { MIGRATIONS } from '../index.js'

type Row = Record<string, unknown>

/** Sessione finta: `SHOW INDEXES` risponde dalla coda, tutto il resto una riga vuota. */
function fakeSession(shows: (Row | null)[]) {
  const calls: string[] = []
  let i = 0
  return {
    calls,
    run: vi.fn(async (cypher: string) => {
      calls.push(cypher)
      if (cypher.startsWith('SHOW INDEXES')) {
        const row = shows[i++] ?? null
        return { records: row ? [{ get: (k: string) => row[k] }] : [] }
      }
      return { records: [] }
    }),
  }
}

const OLD = { labelsOrTypes: ['Incident', 'Change', 'Problem', 'ServiceRequest', 'KBArticle', 'Server', 'Application'], properties: [...GLOBAL_SEARCH_PROPERTIES], state: 'ONLINE' }
const NEW = { labelsOrTypes: [...GLOBAL_SEARCH_LABELS], properties: [...GLOBAL_SEARCH_PROPERTIES], state: 'ONLINE' }

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260916_1700_global_search_configuration_item', () => {
  it('è registrata per ultima, id nel formato, autocommit (DROP+CREATE sono schema)', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toContain('20260916_1700_global_search_configuration_item')
    expect(ids.indexOf('20260916_1700_global_search_configuration_item'))
      .toBeGreaterThan(ids.indexOf('20260914_1520_step_entered_notification_rules'))
    expect(globalSearchConfigurationItem.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(globalSearchConfigurationItem.autocommit).toBe(true)
  })

  it('l\'indice copre i CI per :ConfigurationItem, non per tipo', () => {
    expect(GLOBAL_SEARCH_LABELS).toEqual(['Incident', 'Change', 'Problem', 'ServiceRequest', 'KBArticle', 'ConfigurationItem'])
    expect(GLOBAL_SEARCH_LABELS).not.toContain('Server')
    expect(GLOBAL_SEARCH_LABELS).not.toContain('Application')
  })

  it('definizione vecchia → DROP, CREATE con :ConfigurationItem, attesa dell\'indice, verifica', async () => {
    const s = fakeSession([OLD, NEW])
    await globalSearchConfigurationItem.up(s as never)
    expect(s.calls[0]).toContain('SHOW INDEXES')
    expect(s.calls[1]).toBe('DROP INDEX global_search IF EXISTS')
    expect(s.calls[2]).toContain('CREATE FULLTEXT INDEX global_search IF NOT EXISTS FOR (n:Incident|Change|Problem|ServiceRequest|KBArticle|ConfigurationItem)')
    expect(s.calls[2]).toContain('ON EACH [n.title, n.number, n.code, n.name]')
    expect(s.calls[3]).toBe('CALL db.awaitIndexes(300)')
    expect(s.calls[4]).toContain('SHOW INDEXES')
  })

  it('idempotente: definizione già giusta → nessun DROP, nessun CREATE (--force innocuo)', async () => {
    const s = fakeSession([NEW])
    await globalSearchConfigurationItem.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(1)
    expect(s.calls.some((c) => c.includes('DROP INDEX'))).toBe(false)
    expect(s.calls.some((c) => c.includes('CREATE FULLTEXT'))).toBe(false)
  })

  it('indice assente (riesecuzione dopo un\'interruzione fra DROP e CREATE) → lo crea, senza DROP', async () => {
    const s = fakeSession([null, NEW])
    await globalSearchConfigurationItem.up(s as never)
    expect(s.calls.some((c) => c.includes('DROP INDEX'))).toBe(false)
    expect(s.calls.some((c) => c.includes('CREATE FULLTEXT'))).toBe(true)
  })

  it('dopo il CREATE l\'indice non c\'è → errore (la ricerca globale sarebbe muta)', async () => {
    const s = fakeSession([OLD, null])
    await expect(globalSearchConfigurationItem.up(s as never)).rejects.toThrow(/non esiste dopo il CREATE/)
  })

  it('indice non ONLINE dopo l\'attesa → errore', async () => {
    const s = fakeSession([OLD, { ...NEW, state: 'POPULATING' }])
    await expect(globalSearchConfigurationItem.up(s as never)).rejects.toThrow(/stato "POPULATING"/)
  })

  it('definizione inattesa dopo il CREATE → errore', async () => {
    const s = fakeSession([OLD, { ...NEW, labelsOrTypes: ['Incident'] }])
    await expect(globalSearchConfigurationItem.up(s as never)).rejects.toThrow(/definizione inattesa/)
  })
})
