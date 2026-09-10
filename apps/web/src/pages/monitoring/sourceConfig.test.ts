import { describe, it, expect } from 'vitest'
import {
  EMPTY_MAPPING, EMPTY_PRESET_RULES, buildSourceConfig, buildPresetConfig, parseSourceConfig, parsePresetConfig, distinctValuesAtPath, valueAtPath,
  isMappingComplete, isPresetRulesComplete, syncValueTable, suggestSeverity, suggestStatus, type GenericMapping, type PresetRules,
} from './sourceConfig'

describe('sourceConfig — regole dei connettori preset (A1)', () => {
  const RULES: PresetRules = {
    severityValues: { page: 'critical', none: 'info' },
    statusValues: { muted: 'resolved' },
    defaultResource: 'prometheus-prod',
    defaultResourceKind: 'name',
    resourceFromAlertScope: true,
  }

  it('buildPresetConfig: field_mapping sempre vuoto; value_mapping e default_values solo con ciò che è stato scelto; resourceFrom solo dove il connettore lo prevede', () => {
    const dd = buildPresetConfig('datadog', RULES)
    expect(dd.fieldMapping).toBe('{}')
    expect(JSON.parse(dd.valueMapping)).toEqual({ severity: { page: 'critical', none: 'info' }, status: { muted: 'resolved' } })
    expect(JSON.parse(dd.defaultValues)).toEqual({ resource: 'prometheus-prod', resourceKind: 'name', resourceFrom: 'alert_scope' })
    // Alertmanager non ha resourceFrom: la spunta (residua) non viene scritta
    expect(JSON.parse(buildPresetConfig('alertmanager', RULES).defaultValues)).toEqual({ resource: 'prometheus-prod', resourceKind: 'name' })
    // niente regole → JSON vuoti; una risorsa vuota non scrive resourceKind
    expect(buildPresetConfig('zabbix', EMPTY_PRESET_RULES)).toEqual({ fieldMapping: '{}', defaultValues: '{}', valueMapping: '{}' })
    expect(JSON.parse(buildPresetConfig('zabbix', { ...RULES, defaultResource: '  ', severityValues: { x: '' } }).defaultValues)).toEqual({})
    expect(JSON.parse(buildPresetConfig('zabbix', { ...RULES, severityValues: { x: '' }, statusValues: {} }).valueMapping)).toEqual({})
  })

  it('parsePresetConfig ∘ buildPresetConfig è l\'identità; JSON vuoti/null → regole vuote', () => {
    const cfg = buildPresetConfig('datadog', RULES)
    expect(parsePresetConfig('datadog', cfg)).toEqual({ rules: RULES, error: null })
    expect(parsePresetConfig('grafana', { defaultValues: null, valueMapping: '' })).toEqual({ rules: EMPTY_PRESET_RULES, error: null })
  })

  it('parsePresetConfig: JSON malformato, valori fuori vocabolario, chiavi che l\'editor non rappresenta (default_values.severity, resourceFrom fuori connettore) → error', () => {
    expect(parsePresetConfig('zabbix', { defaultValues: '{nope', valueMapping: null }).error).toMatch(/defaultValues/)
    expect(parsePresetConfig('zabbix', { defaultValues: '{"resourceKind":"planet"}', valueMapping: null }).error).toMatch(/resourceKind/)
    expect(parsePresetConfig('zabbix', { defaultValues: '{"resource":""}', valueMapping: null }).error).toMatch(/defaultValues\.resource/)
    expect(parsePresetConfig('zabbix', { defaultValues: '{"severity":"warning"}', valueMapping: null }).error).toMatch(/defaultValues\.severity: non modificabile/)
    expect(parsePresetConfig('alertmanager', { defaultValues: '{"resourceFrom":"alert_scope"}', valueMapping: null }).error).toMatch(/resourceFrom: non previsto per alertmanager/)
    expect(parsePresetConfig('zabbix', { defaultValues: null, valueMapping: '{"severity":{"x":"fatal"}}' }).error).toMatch(/valueMapping\.severity\.x/)
    expect(parsePresetConfig('zabbix', { defaultValues: null, valueMapping: '{"status":{"x":"open"}}' }).error).toMatch(/valueMapping\.status\.x/)
    expect(parsePresetConfig('zabbix', { defaultValues: null, valueMapping: '{"title":{}}' }).error).toMatch(/valueMapping\.title: non supportato/)
  })

  it('isPresetRulesComplete: un valore senza destinazione blocca; nessuna regola è completo', () => {
    expect(isPresetRulesComplete(EMPTY_PRESET_RULES)).toBe(true)
    expect(isPresetRulesComplete(RULES)).toBe(true)
    expect(isPresetRulesComplete({ ...RULES, severityValues: { page: '' } })).toBe(false)
    expect(isPresetRulesComplete({ ...RULES, statusValues: { x: '' } })).toBe(false)
  })
})

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
