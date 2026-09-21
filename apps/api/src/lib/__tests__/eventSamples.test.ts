/**
 * eventSamples.ts — ogni campione è nella forma del proprio connettore e
 * attraversa la normalizzazione reale; il campione generic con la
 * configurazione proposta (GENERIC_SAMPLE_CONFIG) produce un evento valido;
 * i campioni sono copie (mai l'oggetto condiviso).
 */
import { describe, it, expect } from 'vitest'
import { CONNECTOR_KINDS, normalizePayload, parseValueMapping, listPayloadKeys } from '../../services/eventService.js'
import { SAMPLE_PAYLOADS, GENERIC_SAMPLE_CONFIG, sampleInboundPayload } from '../eventSamples.js'

describe('eventSamples', () => {
  it('esiste un campione per ognuno dei sei connettori', () => {
    expect(Object.keys(SAMPLE_PAYLOADS).sort()).toEqual([...CONNECTOR_KINDS].sort())
  })

  it.each(['alertmanager', 'grafana', 'zabbix', 'datadog', 'dynatrace'] as const)('%s: il campione normalizza in un evento firing con externalId e hostname', (kind) => {
    const out = normalizePayload(kind, sampleInboundPayload(kind), {}, {})
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ status: 'firing', resourceKind: 'hostname' })
    expect(out[0]!.externalId).toBeTruthy()
    expect(out[0]!.description).toBeTruthy()
  })

  it('generic: campione + GENERIC_SAMPLE_CONFIG → evento valido; i percorsi della config esistono tutti nel campione', () => {
    const { fieldMapping, defaultValues, valueMapping } = GENERIC_SAMPLE_CONFIG
    const out = normalizePayload('generic', sampleInboundPayload('generic'), { ...fieldMapping }, { ...defaultValues }, parseValueMapping(valueMapping))
    expect(out).toEqual([{
      externalId: 'EVT-100234', status: 'firing', severity: 'warning', title: 'CheckoutErrorRate',
      description: 'Service checkout-api is returning HTTP 500 on 12% of requests',
      resource: 'api-03.example.local', resourceKind: 'hostname', labels: { env: 'prod', service: 'checkout-api' },
    }])
    const paths = new Set(listPayloadKeys(SAMPLE_PAYLOADS.generic).map((k) => k.path))
    for (const [field, path] of Object.entries(fieldMapping)) {
      if (field === 'labels') continue   // oggetto, non foglia
      expect(paths.has(path), `${field} → ${path}`).toBe(true)
    }
  })

  it('sampleInboundPayload restituisce una copia; connettore sconosciuto → ValidationError', () => {
    const a = sampleInboundPayload('zabbix')
    a['event_id'] = 'mutated'
    expect(sampleInboundPayload('zabbix')['event_id']).toBe('184352')
    expect(() => sampleInboundPayload('nagios')).toThrow(/connectorKind must be one of: generic, alertmanager, grafana, zabbix, datadog, dynatrace/)
  })
})
