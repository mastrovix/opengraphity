/**
 * lib/ciTypeFromLabels.ts — la mappa dei tipi del cliente è PER TENANT (A-17).
 *
 * Il difetto: la mappa dinamica era una sola, globale. La label Neo4j di un
 * tipo è `toPascalCase(name)`, quindi due clienti che creano un tipo con lo
 * stesso nome condividono la label per costruzione: chi registrava per ultimo
 * decideva il nome del tipo per TUTTI, e i CI di un cliente comparivano con il
 * tipo dell'altro. Silenzioso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger }))

const { ciTypeFromLabels, registerCITypes, clearCITypes, hasCITypes } = await import('../ciTypeFromLabels.js')

beforeEach(() => {
  vi.clearAllMocks()
  clearCITypes('c-one')
  clearCITypes('c-two')
})

describe('mappa dei tipi per tenant', () => {
  it('due clienti con la stessa label Neo4j ottengono ognuno il PROPRIO tipo', () => {
    registerCITypes('c-one', [{ neo4jLabel: 'LoadBalancer', name: 'load_balancer' }])
    registerCITypes('c-two', [{ neo4jLabel: 'LoadBalancer', name: 'bilanciatore' }])

    expect(ciTypeFromLabels('c-one', ['ConfigurationItem', 'LoadBalancer'])).toBe('load_balancer')
    expect(ciTypeFromLabels('c-two', ['ConfigurationItem', 'LoadBalancer'])).toBe('bilanciatore')
  })

  it('registrare per un cliente non registra per gli altri', () => {
    registerCITypes('c-one', [{ neo4jLabel: 'ErpSystem', name: 'erp_system' }])
    expect(hasCITypes('c-one')).toBe(true)
    expect(hasCITypes('c-two')).toBe(false)
    // Per c-two la label è ignota: tipo per convenzione, con un errore nel log.
    expect(ciTypeFromLabels('c-two', ['ErpSystem'])).toBe('erp_system')
  })

  it('una nuova registrazione SOSTITUISCE la mappa: un tipo cancellato sparisce', () => {
    registerCITypes('c-one', [
      { neo4jLabel: 'ErpSystem', name: 'erp_system' },
      { neo4jLabel: 'LoadBalancer', name: 'load_balancer' },
    ])
    registerCITypes('c-one', [{ neo4jLabel: 'ErpSystem', name: 'erp_system' }])
    expect(ciTypeFromLabels('c-one', ['ErpSystem'])).toBe('erp_system')
    // LoadBalancer non è più un tipo del cliente: resta solo la convenzione.
    expect(ciTypeFromLabels('c-one', ['LoadBalancer'])).toBe('load_balancer')
  })

  it('clearCITypes dimentica un cliente solo (è il clearer che usa il canale Redis)', () => {
    registerCITypes('c-one', [{ neo4jLabel: 'ErpSystem', name: 'erp_system' }])
    registerCITypes('c-two', [{ neo4jLabel: 'ErpSystem', name: 'gestionale' }])
    clearCITypes('c-two')
    expect(hasCITypes('c-one')).toBe(true)
    expect(hasCITypes('c-two')).toBe(false)
    expect(ciTypeFromLabels('c-one', ['ErpSystem'])).toBe('erp_system')
  })

  it('i tipi base non dipendono dal tenant e vincono sulla mappa dinamica', () => {
    registerCITypes('c-one', [{ neo4jLabel: 'Server', name: 'server_del_cliente' }])
    expect(ciTypeFromLabels('c-one', ['ConfigurationItem', 'Server'])).toBe('server')
    expect(ciTypeFromLabels('tenant-mai-visto', ['BusinessApplication'])).toBe('business_application')
  })

  it('un CI senza nessuna label utile è un errore che nomina il tenant', () => {
    expect(() => ciTypeFromLabels('c-two', ['ConfigurationItem'])).toThrow(/tenant c-two/)
  })
})

describe('il log distingue «label ignota» da «tipi del tenant non caricati qui»', () => {
  it('mappa caricata + label ignota → CI orfano di un tipo cancellato', () => {
    registerCITypes('c-one', [])
    expect(ciTypeFromLabels('c-one', ['TipoScomparso'])).toBe('tipo_scomparso')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'c-one', label: 'TipoScomparso', tenantTypesLoaded: true }),
      expect.stringContaining('stale CI of a deleted type'),
    )
  })

  it('mappa MAI caricata in questo processo (worker, events-worker) → lo dice', () => {
    expect(ciTypeFromLabels('c-two', ['TipoDelCliente'])).toBe('tipo_del_cliente')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'c-two', tenantTypesLoaded: false }),
      expect.stringContaining('non sono stati caricati in questo processo'),
    )
  })

  it('una label già segnalata non inonda i log, ma un altro cliente sì (la memoria è per tenant)', () => {
    ciTypeFromLabels('c-one', ['Ignota'])
    ciTypeFromLabels('c-one', ['Ignota'])
    ciTypeFromLabels('c-one', ['Ignota'])
    expect(logger.error).toHaveBeenCalledTimes(1)
    // Con una memoria globale per sola label, questo cliente resterebbe muto.
    ciTypeFromLabels('c-two', ['Ignota'])
    expect(logger.error).toHaveBeenCalledTimes(2)
  })
})
