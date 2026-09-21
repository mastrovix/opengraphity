/**
 * Migrazione 20260912_1210_ci_status_vocabulary (personalizzazioni, ondata 0,
 * B0-4): il vocabolario del ciclo di vita del CI deve contenere ogni valore
 * che i CI del tenant hanno davvero (dal vivo: `expired` e `revoked` dei
 * certificati) più quelli del codice (`decommissioned` mancava anche lì).
 * Aggiunge, non riscrive; `__base__` è condiviso e NON prende i valori trovati
 * sui CI di un tenant; un valore corrotto ferma la migrazione; idempotente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ciStatusVocabulary } from '../20260912_1210_ci_status_vocabulary.js'
import { MIGRATIONS } from '../index.js'
import { CI_LIFECYCLE_STATUSES } from '../../../lib/eventVocabularies.js'

interface EnumRow  { id: string; tenantId: string; values: unknown }
interface FieldRow { id: string; tenantId: string; values: unknown }

function fakeSession(enums: EnumRow[], fields: FieldRow[], ciStatuses: Record<string, string[]> = {}) {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const rows = <T,>(list: T[]) => ({ records: list.map((r) => ({ get: (k: string) => (r as Record<string, unknown>)[k] })) })
  return {
    writes,
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      if (cypher.includes("MATCH (e:EnumTypeDefinition {name: 'ci_status'})")) return rows(enums)
      if (cypher.includes('MATCH (ci:ConfigurationItem')) {
        const list = ciStatuses[String(params['tenantId'])] ?? []
        return rows(list.map((status) => ({ status })))
      }
      if (cypher.includes("MATCH (t:CITypeDefinition {name: '__base__'})")) return rows(fields)
      writes.push({ cypher, params })
      return { records: [] }
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260912_1210_ci_status_vocabulary', () => {
  it('è registrata dopo la 1150, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260912_1210_ci_status_vocabulary')).toBeGreaterThan(ids.indexOf('20260911_1150_notification_channels_routable'))
    expect(ciStatusVocabulary.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(ciStatusVocabulary.autocommit).toBeUndefined()
  })

  it('il vocabolario finisce per contenere OGNI stato presente sui CI del tenant (expired/revoked) e quelli del codice', async () => {
    const s = fakeSession(
      [{ id: 'e-one', tenantId: 'c-one', values: ['active', 'inactive', 'maintenance', 'decommissioned'] }],
      [{ id: 'f-base', tenantId: 'system', values: JSON.stringify(['active', 'inactive', 'maintenance']) }],
      { 'c-one': ['active', 'expired', 'inactive', 'maintenance', 'revoked'] },
    )
    await ciStatusVocabulary.up(s as never)

    const enumWrite = s.writes.find((w) => w.cypher.includes('EnumTypeDefinition'))!
    expect(enumWrite.params['values']).toEqual(['active', 'inactive', 'maintenance', 'decommissioned', 'expired', 'revoked'])
    // La proprietà che il punto chiede: nessuno stato dei CI resta fuori.
    for (const status of ['active', 'expired', 'inactive', 'maintenance', 'revoked']) {
      expect(enumWrite.params['values']).toContain(status)
    }

    const fieldWrite = s.writes.find((w) => w.cypher.includes('CIFieldDefinition'))!
    expect(JSON.parse(fieldWrite.params['values'] as string)).toEqual([...CI_LIFECYCLE_STATUSES])
  })

  it('aggiunge in coda e non riscrive i valori del cliente (rinomine comprese)', async () => {
    const s = fakeSession(
      [{ id: 'e-x', tenantId: 'acme', values: ['attivo', 'dismesso'] }],
      [],
      { acme: ['attivo'] },
    )
    await ciStatusVocabulary.up(s as never)
    expect(s.writes[0]!.params['values']).toEqual(['attivo', 'dismesso', ...CI_LIFECYCLE_STATUSES])
  })

  it('`__base__` è condiviso: NON prende i valori trovati sui CI di un tenant', async () => {
    const s = fakeSession(
      [{ id: 'e-x', tenantId: 'acme', values: [...CI_LIFECYCLE_STATUSES] }],
      [{ id: 'f-base', tenantId: 'system', values: JSON.stringify([...CI_LIFECYCLE_STATUSES]) }],
      { acme: ['stato_solo_di_acme'] },
    )
    await ciStatusVocabulary.up(s as never)
    const fieldWrite = s.writes.find((w) => w.cypher.includes('CIFieldDefinition'))
    expect(fieldWrite).toBeUndefined()   // già completo: nessuna scrittura
    expect(s.writes[0]!.params['values']).toEqual([...CI_LIFECYCLE_STATUSES, 'stato_solo_di_acme'])
  })

  it('idempotente: alla seconda esecuzione (vocabolari già completi) non scrive nulla', async () => {
    const s = fakeSession(
      [{ id: 'e-one', tenantId: 'c-one', values: [...CI_LIFECYCLE_STATUSES] }],
      [{ id: 'f-base', tenantId: 'system', values: JSON.stringify([...CI_LIFECYCLE_STATUSES]) }],
      { 'c-one': ['active', 'expired', 'revoked'] },
    )
    await ciStatusVocabulary.up(s as never)
    expect(s.writes).toEqual([])
  })

  it('un `values` corrotto ferma la migrazione nominando il vocabolario', async () => {
    const s = fakeSession([{ id: 'e-x', tenantId: 'acme', values: '{non json' }], [])
    await expect(ciStatusVocabulary.up(s as never)).rejects.toThrow(/ci_status \(acme\)\.values is corrupt JSON/)
    expect(s.writes).toEqual([])
  })

  it('nessun ci.status viene riscritto: la migrazione scrive solo vocabolari', async () => {
    const s = fakeSession(
      [{ id: 'e-one', tenantId: 'c-one', values: ['active'] }],
      [{ id: 'f-base', tenantId: 'system', values: JSON.stringify(['active']) }],
      { 'c-one': ['active', 'expired'] },
    )
    await ciStatusVocabulary.up(s as never)
    for (const w of s.writes) {
      expect(w.cypher).not.toMatch(/SET\s+ci\./)
      expect(w.cypher).not.toContain('ConfigurationItem')
    }
  })
})
