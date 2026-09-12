/**
 * `cypherIdentifiers.ts` — le due liste di chiavi riservate e la rete sulla
 * scrittura dei CI (A-12).
 *
 * `RESERVED_PROPERTY_KEYS` (chiavi di sistema di qualunque nodo) e
 * `RESERVED_CI_PROPERTY_KEYS` (quelle di un CI) esistevano già ma **non erano
 * usate dal metamodello**. Ora la seconda arriva da
 * `@opengraphity/schema-generator`, così la validazione dei nomi del
 * metamodello e la scrittura dei CI leggono la STESSA lista. Questo test pinna
 * che non possano divergere.
 */
import { describe, it, expect } from 'vitest'
import {
  RESERVED_PROPERTY_KEYS, RESERVED_CI_PROPERTY_KEYS, RESERVED_CI_PROPERTY_PREFIXES,
  assertWritablePropertyKey, assertWritableCIPropertyKey,
  assertFieldName, assertLabel, assertRelationshipType,
} from '../cypherIdentifiers.js'
import { RESERVED_CI_PROPERTY_KEYS as FROM_PACKAGE } from '@opengraphity/schema-generator'
import { ValidationError } from '../errors.js'

describe('le due liste non possono divergere', () => {
  it('RESERVED_CI_PROPERTY_KEYS contiene tutta RESERVED_PROPERTY_KEYS', () => {
    for (const k of RESERVED_PROPERTY_KEYS) {
      expect(RESERVED_CI_PROPERTY_KEYS.has(k), `chiave di sistema mancante: ${k}`).toBe(true)
    }
  })

  it('è la stessa istanza che usa la validazione dei nomi del metamodello', () => {
    expect(RESERVED_CI_PROPERTY_KEYS).toBe(FROM_PACKAGE)
  })

  it('copre le proprietà scritte solo dal prodotto', () => {
    for (const k of ['tenant_id', 'id', 'name_key', 'health', 'health_source', 'last_event_at', 'chain', 'type']) {
      expect(RESERVED_CI_PROPERTY_KEYS.has(k), k).toBe(true)
    }
    expect(RESERVED_CI_PROPERTY_PREFIXES).toContain('discovery_')
  })
})

describe('assertWritableCIPropertyKey — la rete sulla scrittura di un CI', () => {
  it('rifiuta tenant_id nominando il campo del metamodello che lo produce', () => {
    const err = (() => { try { assertWritableCIPropertyKey('tenant_id', 'tenantId'); return null } catch (e) { return e as Error } })()!
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('"tenantId"')
    expect(err.message).toContain('"tenant_id"')
    expect(err.message).toContain('disegnatore')
  })

  it.each(['id', 'name_key', 'health', 'chain', 'created_at'])('rifiuta «%s»', (key) => {
    expect(() => assertWritableCIPropertyKey(key, 'x')).toThrow(ValidationError)
  })

  it('rifiuta il prefisso della sincronizzazione e lo dice', () => {
    const err = (() => { try { assertWritableCIPropertyKey('discovery_source_id', 'discoverySourceId'); return null } catch (e) { return e as Error } })()!
    expect(err.message).toContain('discovery_')
  })

  it.each(['cost_center', 'os', 'ip_address', 'porte'])('lascia passare «%s»', (key) => {
    expect(assertWritableCIPropertyKey(key, 'x')).toBe(key)
  })
})

describe('le funzioni che c\'erano già continuano a valere', () => {
  it('assertWritablePropertyKey resta sulle sole chiavi di sistema', () => {
    expect(() => assertWritablePropertyKey('tenant_id', 'customFields')).toThrow(ValidationError)
    // `health` NON è una chiave di sistema generica: lo è solo su un CI.
    expect(assertWritablePropertyKey('health', 'customFields')).toBe('health')
  })

  it('le regex rifiutano ciò che non è un identificatore', () => {
    expect(() => assertFieldName('Centro di costo', 'x')).toThrow(ValidationError)
    expect(() => assertLabel('2fa', 'x')).toThrow(ValidationError)
    expect(() => assertRelationshipType('depends-on', 'x')).toThrow(ValidationError)
    expect(assertFieldName('cost_center', 'x')).toBe('cost_center')
    expect(assertLabel('LoadBalancer', 'x')).toBe('LoadBalancer')
    expect(assertRelationshipType('DEPENDS_ON', 'x')).toBe('DEPENDS_ON')
  })
})
