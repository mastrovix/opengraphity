/**
 * Isolamento dei vocabolari (A-2 / C-6). Il nucleo dell'ondata: un campo
 * spedito col prodotto è UN nodo per tutti i clienti, quindi il suo
 * `USES_ENUM` non può puntare al vocabolario di un cliente. Qui si pinna la
 * precedenza «vocabolario del tenant > agganciato di sistema > inline» e il
 * rifiuto in scrittura.
 */
import { describe, it, expect, vi } from 'vitest'
import { GraphQLError } from 'graphql'
import {
  SYSTEM_TENANT, enumScopeClause, loadTenantEnumOverrides,
  applyEnumOverride, applyEnumOverrides, assertEnumLinkable, isSharedField,
} from '../enumScope.js'

const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

function sessionWith(rows: Array<Record<string, unknown>>) {
  const run = vi.fn(async () => ({ records: rows.map(rec) }))
  return {
    session: { executeRead: (fn: (tx: { run: typeof run }) => unknown) => fn({ run }) } as never,
    run,
  }
}

describe('enumScopeClause', () => {
  it('ammette il tenant e il sistema, e nessun altro', () => {
    expect(enumScopeClause('enumDef')).toBe("WHERE enumDef.tenant_id IN [$tenantId, 'system']")
    expect(enumScopeClause('bfEnum')).toContain('bfEnum.tenant_id')
  })
})

describe('loadTenantEnumOverrides', () => {
  it('legge solo i vocabolari PROPRI del tenant e ne accetta i values come array o come JSON', async () => {
    const { session, run } = sessionWith([
      { id: 'e1', name: 'severity',  values: ['bassa', 'alta'] },
      { id: 'e2', name: 'ci_status', values: '["active","expired"]' },
    ])
    const out = await loadTenantEnumOverrides(session, 'c-one')
    expect([...out.keys()]).toEqual(['severity', 'ci_status'])
    expect(out.get('ci_status')!.values).toEqual(['active', 'expired'])
    const [cypher, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(cypher).toContain('{tenant_id: $tenantId}')
    expect(cypher).not.toContain("'system'")     // gli enum di sistema NON sono personalizzazioni
    expect(params).toEqual({ tenantId: 'c-one' })
  })

  it('values corrotti → errore che nomina il vocabolario, non un elenco vuoto', async () => {
    const { session } = sessionWith([{ id: 'e1', name: 'severity', values: '{non json' }])
    await expect(loadTenantEnumOverrides(session, 'c-one')).rejects.toThrow(/Vocabolario "severity"/)
  })

  it('per il tenant di sistema non ci sono personalizzazioni e non si interroga il grafo', async () => {
    const { session, run } = sessionWith([{ id: 'x', name: 'y', values: [] }])
    expect((await loadTenantEnumOverrides(session, SYSTEM_TENANT)).size).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('precedenza in lettura', () => {
  const overrides = new Map([['severity', { id: 'own-1', name: 'severity', values: ['bassa', 'alta'] }]])

  it('il vocabolario del tenant vince su quello di sistema agganciato al campo condiviso', () => {
    const row = { enumId: 'sys-1', enumName: 'severity', enumValues: ['low', 'high'] }
    expect(applyEnumOverride(row, overrides)).toEqual({ enumId: 'own-1', enumName: 'severity', enumValues: ['bassa', 'alta'] })
  })

  it('senza vocabolario proprio la riga resta quella agganciata; senza aggancio resta senza', () => {
    expect(applyEnumOverride({ enumId: 'sys-2', enumName: 'risk', enumValues: ['low'] }, overrides).enumId).toBe('sys-2')
    expect(applyEnumOverride({ enumId: null, enumName: null, enumValues: null }, overrides).enumId).toBeNull()
  })

  it('se il campo è già agganciato al vocabolario del tenant non cambia nulla', () => {
    const row = { enumId: 'own-1', enumName: 'severity', enumValues: ['bassa', 'alta'] }
    expect(applyEnumOverride(row, overrides)).toBe(row)
  })

  it('la lista conserva l\'ordine e tocca solo le righe personalizzate', () => {
    const rows = [
      { enumId: 'sys-1', enumName: 'severity', enumValues: ['low'] },
      { enumId: 'sys-2', enumName: 'risk',     enumValues: ['low'] },
    ]
    const out = applyEnumOverrides(rows, overrides)
    expect(out.map((r) => r.enumId)).toEqual(['own-1', 'sys-2'])
  })
})

describe('assertEnumLinkable — chi può essere agganciato a chi', () => {
  const tenantField = { name: 'colore_sede', scope: 'tenant', tenantId: 'c-one' }
  const sharedField = { name: 'severity',    scope: 'itil',   tenantId: 'system' }

  it('un vocabolario di sistema si aggancia a qualunque campo', () => {
    const sys = { id: 's1', name: 'severity', tenantId: SYSTEM_TENANT }
    expect(() => assertEnumLinkable(sys, sharedField, 'c-one')).not.toThrow()
    expect(() => assertEnumLinkable(sys, tenantField, 'c-one')).not.toThrow()
  })

  it('il vocabolario del tenant si aggancia solo ai campi suoi', () => {
    const own = { id: 'o1', name: 'severity', tenantId: 'c-one' }
    expect(() => assertEnumLinkable(own, tenantField, 'c-one')).not.toThrow()
    const err = (() => { try { assertEnumLinkable(own, sharedField, 'c-one') } catch (e) { return e } })()
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toMatch(/spedito col prodotto ed è condiviso/)
    expect((err as GraphQLError).message).toMatch(/Crea un vocabolario con il nome "severity"/)
  })

  it('il vocabolario di un altro cliente non si aggancia da nessuna parte', () => {
    const other = { id: 'x1', name: 'severity', tenantId: 'c-two' }
    expect(() => assertEnumLinkable(other, tenantField, 'c-one')).toThrow(/appartiene a un altro cliente/)
    expect(() => assertEnumLinkable(other, sharedField, 'c-one')).toThrow(/appartiene a un altro cliente/)
  })

  it('un campo è condiviso per lo scope o per il proprietario', () => {
    expect(isSharedField({ scope: 'base',   tenantId: 'system' })).toBe(true)
    expect(isSharedField({ scope: 'itil',   tenantId: 'system' })).toBe(true)
    expect(isSharedField({ scope: 'tenant', tenantId: 'system' })).toBe(true)   // per prudenza
    expect(isSharedField({ scope: 'tenant', tenantId: 'c-one' })).toBe(false)
  })
})
