import { describe, it, expect } from 'vitest'
import {
  EMPTY_MAPPING, buildSourceConfig, parseSourceConfig, distinctValuesAtPath, valueAtPath,
  isMappingComplete, syncValueTable, suggestSeverity, suggestStatus, type GenericMapping,
} from './sourceConfig'

const SAMPLE = {
  id: 'EVT-1', state: 'open', msg: 'boom',
  alert: { name: 'CheckoutErrorRate', level: 'major' },
  host: { name: 'api-03.example.local' },
  alerts: [{ labels: { severity: 'critical' } }, { labels: { severity: 'warning' } }, { labels: { severity: 'critical' } }],
}

const MAPPING: GenericMapping = {
  fields: { title: 'alert.name', severity: 'alert.level', resource: 'host.name', status: 'state', description: 'msg', externalId: 'id' },
  resourceKind: 'hostname',
  severityValues: { major: 'critical', minor: 'warning' },
  statusValues: { open: 'firing', closed: 'resolved' },
}

describe('sourceConfig — buildSourceConfig', () => {
  it('produce i tre JSON nel formato del connettore generic (campi vuoti omessi, resourceKind sempre presente)', () => {
    const cfg = buildSourceConfig(MAPPING)
    expect(JSON.parse(cfg.fieldMapping)).toEqual({ title: 'alert.name', severity: 'alert.level', resource: 'host.name', status: 'state', description: 'msg', externalId: 'id' })
    expect(JSON.parse(cfg.defaultValues)).toEqual({ resourceKind: 'hostname' })
    expect(JSON.parse(cfg.valueMapping)).toEqual({ severity: { major: 'critical', minor: 'warning' }, status: { open: 'firing', closed: 'resolved' } })
  })

  it('senza campo stato la traduzione dello stato non viene scritta; valori non ancora scelti restano fuori', () => {
    const cfg = buildSourceConfig({ ...MAPPING, fields: { ...MAPPING.fields, status: '', description: '' }, severityValues: { major: 'critical', unknown: '' } })
    expect(JSON.parse(cfg.fieldMapping)).toEqual({ title: 'alert.name', severity: 'alert.level', resource: 'host.name', externalId: 'id' })
    expect(JSON.parse(cfg.valueMapping)).toEqual({ severity: { major: 'critical' } })
  })

  it('parseSourceConfig ∘ buildSourceConfig è l\'identità', () => {
    const cfg = buildSourceConfig(MAPPING)
    const back = parseSourceConfig({ fieldMapping: cfg.fieldMapping, defaultValues: cfg.defaultValues, valueMapping: cfg.valueMapping })
    expect(back.error).toBeNull()
    expect(back.dropped).toEqual([])
    expect(back.mapping).toEqual(MAPPING)
  })
})

describe('sourceConfig — parseSourceConfig', () => {
  it('JSON malformato o valori fuori vocabolario → error, mai un mapping "aggiustato"', () => {
    expect(parseSourceConfig({ fieldMapping: '{not json', defaultValues: null, valueMapping: null }).error).toMatch(/fieldMapping/)
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: '{"resourceKind":"planet"}', valueMapping: null }).error).toMatch(/resourceKind/)
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: null, valueMapping: '{"severity":{"x":"fatal"}}' }).error).toMatch(/valueMapping\.severity\.x/)
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: null, valueMapping: '{"status":{"x":"open"}}' }).error).toMatch(/valueMapping\.status\.x/)
  })

  it('chiavi non gestite dal mappatore (labels, startsAt) vengono segnalate in dropped', () => {
    const r = parseSourceConfig({ fieldMapping: '{"title":"t","labels":"tags","startsAt":"ts"}', defaultValues: null, valueMapping: null })
    expect(r.error).toBeNull()
    expect(r.dropped).toEqual(['labels', 'startsAt'])
    expect(r.mapping.fields.title).toBe('t')
  })

  it('JSON vuoti/null → mapping vuoto con hostname predefinito', () => {
    const r = parseSourceConfig({ fieldMapping: '', defaultValues: null, valueMapping: null })
    expect(r).toEqual({ mapping: EMPTY_MAPPING, error: null, dropped: [] })
  })
})

describe('sourceConfig — percorsi puntati', () => {
  it('valueAtPath segue oggetti e indici di array', () => {
    expect(valueAtPath(SAMPLE, 'alert.level')).toBe('major')
    expect(valueAtPath(SAMPLE, 'alerts.1.labels.severity')).toBe('warning')
    expect(valueAtPath(SAMPLE, 'alerts.x.labels')).toBeUndefined()
    expect(valueAtPath(SAMPLE, 'nope.deeper')).toBeUndefined()
  })

  it('distinctValuesAtPath: un solo valore per un campo scalare, tutti i valori distinti attraverso gli array', () => {
    expect(distinctValuesAtPath(SAMPLE, 'alert.level')).toEqual(['major'])
    expect(distinctValuesAtPath(SAMPLE, 'alerts.0.labels.severity')).toEqual(['critical', 'warning'])
    expect(distinctValuesAtPath(SAMPLE, '')).toEqual([])
    expect(distinctValuesAtPath(SAMPLE, 'alert')).toEqual([])   // un oggetto non è un valore
  })
})

describe('sourceConfig — tabella di traduzione', () => {
  it('syncValueTable aggiunge i valori nuovi senza traduzione e conserva quelli scelti a mano', () => {
    expect(syncValueTable({ major: 'critical', custom: 'warning' }, ['major', 'minor'], 'alert.level')).toEqual({ major: 'critical', custom: 'warning', minor: '' })
    expect(syncValueTable({ major: 'critical' }, ['major'], '')).toEqual({})
  })

  it('isMappingComplete: obbligatori mappati e ogni valore trovato tradotto', () => {
    expect(isMappingComplete(MAPPING)).toBe(true)
    expect(isMappingComplete({ ...MAPPING, fields: { ...MAPPING.fields, resource: '' } })).toBe(false)
    expect(isMappingComplete({ ...MAPPING, severityValues: { major: '' } })).toBe(false)
    // stato non mappato: la sua tabella non conta
    expect(isMappingComplete({ ...MAPPING, fields: { ...MAPPING.fields, status: '' }, statusValues: { open: '' } })).toBe(true)
  })

  it('i suggerimenti coprono solo sinonimi inequivocabili', () => {
    expect(suggestSeverity('Critical')).toBe('critical')
    expect(suggestSeverity('disaster')).toBe('critical')
    expect(suggestSeverity('average')).toBe('warning')
    expect(suggestSeverity('major')).toBe('')
    expect(suggestStatus('open')).toBe('firing')
    expect(suggestStatus('Recovered')).toBe('resolved')
    expect(suggestStatus('ok')).toBe('resolved')
    expect(suggestStatus('weird')).toBe('')
  })
})
