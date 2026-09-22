/**
 * LE REGOLE DI MAPPATURA DELLA DISCOVERY (22 set 2026).
 *
 * ## Perché
 * `mapping.ts` stava all'85%, ed è il pezzo che decide CHE COS'È un CI
 * scoperto in cloud: il suo tipo, e quali dei suoi tag diventano proprietà
 * filtrabili. Sbagliarlo non dà un errore — dà una CMDB in cui `concert-web-01`
 * è un certificato, e nessuno lo collega a questo file.
 *
 * ## Le tre regole che sono costate un rilievo ciascuna
 *  1. **il nome si guarda per PAROLE, non per sottostringa** (E-40):
 *     `name.includes('cert')` faceva di `concert-web-01` un certificato;
 *  2. **«true»/«false» diventano booleani SOLO dove il nome dice che sono un
 *     sì/no** (E-40): valeva per qualunque proprietà, quindi un tag
 *     `Environment=false` o una versione `"true"` cambiavano tipo e poi non si
 *     filtravano più come testo;
 *  3. **un alias di tipo NON scrive anche una proprietà** (A-11): senza il
 *     salto, un alias il cui nome coincidesse con un tag ne scriveva una per
 *     caso.
 */
import { describe, it, expect } from 'vitest'
import { applyMappingRules, ciTypeAliases, inferCIType, normalizeProperties } from '../mapping.js'
import type { DiscoveredCI, MappingRule } from '../types.js'

const ci = (over: Partial<DiscoveredCI> = {}): DiscoveredCI => ({
  external_id: 'i-1', name: 'srv-01', ci_type: '', tags: {}, properties: {}, ...over,
} as DiscoveredCI)

const regola = (over: Partial<MappingRule>): MappingRule =>
  ({ kind: 'property', source_field: 'Env', target_field: 'environment', transform: 'none', ...over } as MappingRule)

// ══════════════════════════════════════════════════════════════════════════════
describe('applyMappingRules', () => {
  it('senza regole il CI esce identico, senza nemmeno una copia', () => {
    const originale = ci({ properties: { a: 1 } })
    expect(applyMappingRules(originale, [])).toBe(originale)
  })

  it('un tag diventa una proprietà, con la trasformazione chiesta', () => {
    const out = applyMappingRules(ci({ tags: { Env: '  PROD  ' } }), [
      regola({ source_field: 'Env', target_field: 'environment', transform: 'trim' }),
    ])
    expect(out.properties['environment']).toBe('PROD')
  })

  it.each([
    ['lowercase', 'PROD', 'prod'],
    ['uppercase', 'prod', 'PROD'],
    ['trim',      '  p  ', 'p'],
    ['none',      '  P  ', '  P  '],
  ])('trasformazione %s', (transform, dentro, atteso) => {
    const out = applyMappingRules(ci({ tags: { Env: dentro } }), [regola({ transform: transform as never })])
    expect(out.properties['environment']).toBe(atteso)
  })

  it('un tag che non c\'è non scrive una proprietà vuota', () => {
    const out = applyMappingRules(ci({ tags: {} }), [regola({ source_field: 'Mancante' })])
    expect(out.properties).not.toHaveProperty('environment')
  })

  it('A-11: una regola `ci_type` è un alias di TIPO e non scrive una proprietà', () => {
    // Senza il salto, un alias il cui nome coincide con un tag ne scriverebbe
    // una per caso.
    const out = applyMappingRules(ci({ tags: { 'ec2-instance': 'x' } }), [
      regola({ kind: 'ci_type', source_field: 'ec2-instance', target_field: 'server' }),
    ])
    expect(out.properties).toEqual({})
  })

  it('le proprietà di partenza restano, e l\'originale non si tocca', () => {
    const originale = ci({ tags: { Env: 'prod' }, properties: { vendor: 'AWS' } })
    const out = applyMappingRules(originale, [regola({})])
    expect(out.properties).toEqual({ vendor: 'AWS', environment: 'prod' })
    expect(originale.properties).toEqual({ vendor: 'AWS' })
  })
})

describe('ciTypeAliases', () => {
  it('solo le regole `ci_type`, col valore in arrivo in minuscolo', () => {
    const m = ciTypeAliases([
      regola({ kind: 'ci_type', source_field: '  EC2-Instance ', target_field: ' virtual_machine ' }),
      regola({ kind: 'property', source_field: 'Env', target_field: 'environment' }),
    ])
    expect([...m.entries()]).toEqual([['ec2-instance', 'virtual_machine']])
  })

  it('un capo vuoto è un errore di configurazione, non un alias che non mappa niente', () => {
    for (const rotta of [
      { source_field: '  ', target_field: 'server' },
      { source_field: 'ec2', target_field: '' },
    ]) {
      expect(() => ciTypeAliases([regola({ kind: 'ci_type', ...rotta })]))
        .toThrow(/servono entrambi/)
    }
  })

  it('nessuna regola `ci_type`: mappa vuota', () => {
    expect(ciTypeAliases([regola({})]).size).toBe(0)
  })
})

describe('inferCIType — il nome si guarda per PAROLE', () => {
  it('E-40: `concert-web-01` NON è un certificato', () => {
    expect(inferCIType(ci({ name: 'concert-web-01' }))).toBe('server')
    expect(inferCIType(ci({ name: 'wildcard-cert-2026' }))).toBe('certificate')
    expect(inferCIType(ci({ name: 'prod.certificate.api' }))).toBe('certificate')
  })

  it('un tipo già dichiarato vince su qualunque indovinello', () => {
    expect(inferCIType(ci({ ci_type: 'firewall', name: 'db-cert-lb-bucket' }))).toBe('firewall')
  })

  it.each([
    ['postgres', 'database_instance'], ['postgresql', 'database_instance'],
    ['mysql', 'database_instance'], ['mariadb', 'database_instance'],
    ['oracle', 'database_instance'], ['mssql', 'database_instance'],
    ['aurora', 'database'], ['dynamodb', 'database'], ['mongodb', 'database'],
  ])('il motore «%s» dà %s', (engine, atteso) => {
    expect(inferCIType(ci({ properties: { engine } }))).toBe(atteso)
  })

  it('un motore sconosciuto non inventa un tipo di database', () => {
    expect(inferCIType(ci({ properties: { engine: 'qualcosa' } }))).toBe('server')
  })

  it.each([
    ['load balancer da parole',  ci({ name: 'prod-lb-01' }),                        'load_balancer'],
    ['load balancer composto',   ci({ name: 'load-balancer-api' }),                 'load_balancer'],
    ['load balancer da proprietà', ci({ properties: { load_balancer_type: 'alb' } }), 'load_balancer'],
    ['container',                ci({ properties: { container_id: 'abc' } }),       'container'],
    ['storage',                  ci({ name: 'backup-bucket' }),                     'storage'],
    ['rete da subnet',           ci({ name: 'prod-subnet-a' }),                     'network'],
    ['rete da cidr',             ci({ properties: { cidr_block: '10.0.0.0/16' } }), 'network'],
    ['applicazione da lambda',   ci({ name: 'notify-lambda' }),                     'application'],
    ['applicazione da app_name', ci({ properties: { app_name: 'portale' } }),       'application'],
    ['niente di tutto ciò',      ci({ name: 'macchina-strana' }),                   'server'],
  ])('%s', (_n, dato, atteso) => {
    expect(inferCIType(dato)).toBe(atteso)
  })

  it('l\'ordine conta: un certificato su un load balancer resta un certificato', () => {
    expect(inferCIType(ci({ name: 'lb-cert-prod' }))).toBe('certificate')
  })
})

describe('normalizeProperties — «true» resta testo dove non è un sì/no', () => {
  it('E-40: solo le proprietà booleane PER NOME diventano booleane', () => {
    const out = normalizeProperties({
      is_public: 'true', has_backup: 'false', monitoring_enabled: 'true',
      monitored: 'false', deleted: 'true', encrypted: 'false',
      // Queste NON lo sono: un tag `Environment=false` e una versione "true"
      // cambiavano tipo, e poi non si filtravano più come testo.
      Environment: 'false', version: 'true', name: 'true',
    })
    expect(out).toEqual({
      is_public: true, has_backup: false, monitoring_enabled: true,
      monitored: false, deleted: true, encrypted: false,
      Environment: 'false', version: 'true', name: 'true',
    })
  })

  it('un valore booleano per nome ma non «true»/«false» resta il testo che è', () => {
    expect(normalizeProperties({ is_public: 'forse' })).toEqual({ is_public: 'forse' })
  })

  it('i vuoti spariscono: null, undefined e le stringhe di soli spazi', () => {
    expect(normalizeProperties({ a: null, b: undefined, c: '   ', d: 'x' })).toEqual({ d: 'x' })
  })

  it('le stringhe si ripuliscono, e tutto il resto passa com\'è', () => {
    expect(normalizeProperties({ nome: '  srv  ', porte: [80, 443], n: 0, b: false }))
      .toEqual({ nome: 'srv', porte: [80, 443], n: 0, b: false })
  })

  it('zero e `false` NON sono vuoti: si tengono', () => {
    expect(normalizeProperties({ n: 0, b: false })).toEqual({ n: 0, b: false })
  })
})
