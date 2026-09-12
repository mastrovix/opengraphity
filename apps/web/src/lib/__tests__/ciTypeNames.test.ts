/**
 * `lib/ciTypeNames.ts` — il web NON riscrive le regole sui nomi (A-12): le
 * importa dallo stesso modulo che usa la porta dell'API. Questo test pinna
 * che siano davvero le stesse, perché due copie vorrebbero dire un nome
 * accettato dal form e rifiutato dal server (o, peggio, il contrario).
 */
import { describe, it, expect } from 'vitest'
import { checkCITypeName, checkCIFieldName, isShippedType, CI_TYPE_NAME_RE, CI_FIELD_NAME_RE } from '../ciTypeNames'
import * as shared from '@opengraphity/schema-generator/names'

describe('le regole sono quelle condivise, non una copia', () => {
  it('le regex sono le stesse istanze del pacchetto', () => {
    expect(CI_TYPE_NAME_RE).toBe(shared.CI_TYPE_NAME_RE)
    expect(CI_FIELD_NAME_RE).toBe(shared.CI_FIELD_NAME_RE)
  })
})

describe('isShippedType', () => {
  it.each([
    [{ scope: 'base' },   true],
    [{ scope: 'itil' },   true],
    [{ scope: 'tenant' }, false],
    [{},                  true],   // scope assente: si presume spedito, mai il contrario
  ])('%o → %s', (t, expected) => {
    expect(isShippedType(t)).toBe(expected)
  })
})

describe('checkCITypeName — l\'elenco dei nomi presi viene dai tipi vivi', () => {
  const existing = [
    { name: 'server', scope: 'base' },
    { name: 'load_balancer', scope: 'tenant' },
  ]

  it('nome libero → null', () => {
    expect(checkCITypeName('firewall', existing)).toBeNull()
  })

  it('nome di un tipo spedito → messaggio che dice di chi è', () => {
    expect(checkCITypeName('server', existing)).toContain('spedito col prodotto')
  })

  it('nome di un proprio tipo → messaggio che lo dice', () => {
    expect(checkCITypeName('load_balancer', existing)).toContain('un tuo tipo CI')
  })

  it('nome non identificatore → la regola e il suggerimento', () => {
    const m = checkCITypeName('2fa_token', existing)!
    expect(m).toContain('^[a-z][a-z0-9_]*$')
    expect(m).toContain('«fa2_token»')
  })

  it('senza tipi in elenco non inventa collisioni: è il server ad avere la lista completa', () => {
    // `team` è un tipo dello schema di base: qui passa, e il server lo rifiuta
    // con lo stesso messaggio. È l'unico ordine di errori accettabile.
    expect(checkCITypeName('team', [])).toBeNull()
  })
})

describe('checkCIFieldName', () => {
  it('tenantId → il messaggio del server, parola per parola', () => {
    const m = checkCIFieldName('tenantId', { typeLabel: 'Load Balancer' })!
    expect(m).toContain('tenant_id')
    expect(m).toContain('il CI nascerebbe nel cliente scelto dal chiamante')
    expect(m).toContain('Load Balancer')
  })

  it.each(['name', 'status', 'description'])('«%s» è già su ogni CI', (n) => {
    expect(checkCIFieldName(n)).toContain('esiste già')
  })

  it('«createdAt» è rifiutato dalla regola più forte: scrive `created_at`', () => {
    expect(checkCIFieldName('createdAt')).toContain('created_at')
  })

  it('un campo già presente sul tipo', () => {
    expect(checkCIFieldName('costCenter', { existingFieldNames: ['costCenter'] })).toContain('esiste già')
  })

  it('camelCase libero → null', () => {
    expect(checkCIFieldName('costCenter', { existingFieldNames: ['os'] })).toBeNull()
  })
})
