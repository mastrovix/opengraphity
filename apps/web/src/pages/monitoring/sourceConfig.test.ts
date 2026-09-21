import { describe, it, expect } from 'vitest'
import {
  EMPTY_MAPPING, EMPTY_PRESET_RULES, buildSourceConfig, buildPresetConfig, parseSourceConfig, parsePresetConfig, distinctValuesAtPath, valueAtPath,
  isMappingComplete, isPresetRulesComplete, syncValueTable, suggestSeverity, suggestStatus, readablePath, type GenericMapping, type PresetRules,
} from './sourceConfig'

describe('sourceConfig — regole dei connettori preset (A1)', () => {
  const RULES: PresetRules = {
    severityValues: { page: 'critical', none: 'info' },
    statusValues: { muted: 'resolved' },
    defaultSeverity: 'warning',
    defaultResource: 'prometheus-prod',
    defaultResourceKind: 'name',
    resourceFromAlertScope: true,
  }

  it('buildPresetConfig: field_mapping sempre vuoto; value_mapping e default_values solo con ciò che è stato scelto; resourceFrom solo dove il connettore lo prevede', () => {
    const dd = buildPresetConfig('datadog', RULES)
    expect(dd.fieldMapping).toBe('{}')
    expect(JSON.parse(dd.valueMapping)).toEqual({ severity: { page: 'critical', none: 'info' }, status: { muted: 'resolved' } })
    expect(JSON.parse(dd.defaultValues)).toEqual({ severity: 'warning', resource: 'prometheus-prod', resourceKind: 'name', resourceFrom: 'alert_scope' })
    // Alertmanager non ha resourceFrom: la spunta (residua) non viene scritta
    expect(JSON.parse(buildPresetConfig('alertmanager', RULES).defaultValues)).toEqual({ severity: 'warning', resource: 'prometheus-prod', resourceKind: 'name' })
    // niente regole → JSON vuoti; una risorsa vuota non scrive resourceKind; una severità di soli spazi non viene scritta
    expect(buildPresetConfig('zabbix', EMPTY_PRESET_RULES)).toEqual({ fieldMapping: '{}', defaultValues: '{}', valueMapping: '{}' })
    expect(JSON.parse(buildPresetConfig('zabbix', { ...RULES, defaultResource: '  ', defaultSeverity: ' ', severityValues: { x: '' } }).defaultValues)).toEqual({})
    expect(JSON.parse(buildPresetConfig('zabbix', { ...RULES, severityValues: { x: '' }, statusValues: {} }).valueMapping)).toEqual({})
  })

  it('parsePresetConfig ∘ buildPresetConfig è l\'identità (compresa default_values.severity, D·2.3); JSON vuoti/null → regole vuote', () => {
    const cfg = buildPresetConfig('datadog', RULES)
    expect(parsePresetConfig('datadog', cfg)).toEqual({ rules: RULES, error: null })
    expect(parsePresetConfig('grafana', { defaultValues: null, valueMapping: '' })).toEqual({ rules: EMPTY_PRESET_RULES, error: null })
    // severità di default scritta via API nelle parole dello strumento (Zabbix "Average"): riletta tale quale
    expect(parsePresetConfig('zabbix', { defaultValues: '{"severity":"Average"}', valueMapping: null })).toEqual({ rules: { ...EMPTY_PRESET_RULES, defaultSeverity: 'Average' }, error: null })
  })

  it('parsePresetConfig: JSON malformato, valori fuori vocabolario, chiavi che l\'editor non rappresenta (default_values.title, resourceFrom fuori connettore) → error in i18n', () => {
    expect(parsePresetConfig('zabbix', { defaultValues: '{nope', valueMapping: null }).error).toMatch(/^defaultValues: /)
    expect(parsePresetConfig('zabbix', { defaultValues: '{"resourceKind":"planet"}', valueMapping: null }).error).toBe('defaultValues.resourceKind: expected one of hostname, ip, fqdn, external_id, name')
    expect(parsePresetConfig('zabbix', { defaultValues: '{"resource":""}', valueMapping: null }).error).toBe('defaultValues.resource: expected a non-empty string')
    expect(parsePresetConfig('zabbix', { defaultValues: '{"severity":""}', valueMapping: null }).error).toBe('defaultValues.severity: expected a non-empty string')
    expect(parsePresetConfig('zabbix', { defaultValues: '{"title":"x"}', valueMapping: null }).error).toBe('defaultValues.title: cannot be edited from this page')
    expect(parsePresetConfig('alertmanager', { defaultValues: '{"resourceFrom":"alert_scope"}', valueMapping: null }).error).toBe('defaultValues.resourceFrom: not available for alertmanager')
    expect(parsePresetConfig('zabbix', { defaultValues: null, valueMapping: '{"severity":{"x":"fatal"}}' }).error).toBe('valueMapping.severity.x: expected one of critical, warning, info')
    expect(parsePresetConfig('zabbix', { defaultValues: null, valueMapping: '{"status":{"x":"open"}}' }).error).toBe('valueMapping.status.x: expected one of firing, resolved')
    expect(parsePresetConfig('zabbix', { defaultValues: null, valueMapping: '{"title":{}}' }).error).toBe('valueMapping.title: not supported')
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
  defaultSeverity: '',
  defaultStatus: '',
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

  it('D·1.2: severità e stato predefiniti finiscono in default_values solo se scelti', () => {
    expect(JSON.parse(buildSourceConfig({ ...MAPPING, defaultSeverity: 'warning', defaultStatus: 'resolved' }).defaultValues)).toEqual({ resourceKind: 'hostname', severity: 'warning', status: 'resolved' })
    expect(JSON.parse(buildSourceConfig({ ...MAPPING, defaultSeverity: 'info' }).defaultValues)).toEqual({ resourceKind: 'hostname', severity: 'info' })
  })

  it('parseSourceConfig ∘ buildSourceConfig è l\'identità, anche con i predefiniti', () => {
    const cfg = buildSourceConfig(MAPPING)
    const back = parseSourceConfig({ fieldMapping: cfg.fieldMapping, defaultValues: cfg.defaultValues, valueMapping: cfg.valueMapping })
    expect(back).toEqual({ mapping: MAPPING, error: null, dropped: [] })
    const withDefaults: GenericMapping = { ...MAPPING, defaultSeverity: 'warning', defaultStatus: 'firing' }
    expect(parseSourceConfig(buildSourceConfig(withDefaults))).toEqual({ mapping: withDefaults, error: null, dropped: [] })
  })
})

describe('sourceConfig — parseSourceConfig', () => {
  it('JSON malformato o valori fuori vocabolario → error (in i18n), mai un mapping "aggiustato"', () => {
    expect(parseSourceConfig({ fieldMapping: '{not json', defaultValues: null, valueMapping: null }).error).toMatch(/^fieldMapping: /)
    expect(parseSourceConfig({ fieldMapping: '[]', defaultValues: null, valueMapping: null }).error).toBe('fieldMapping: expected a JSON object')
    expect(parseSourceConfig({ fieldMapping: '{"title":3}', defaultValues: null, valueMapping: null }).error).toBe('fieldMapping.title: expected a path (text)')
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: '{"resourceKind":"planet"}', valueMapping: null }).error).toBe('defaultValues.resourceKind: expected one of hostname, ip, fqdn, external_id, name')
    // un default fuori vocabolario non è rappresentabile dall'editor: errore, non silenzio
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: '{"severity":"major"}', valueMapping: null }).error).toBe('defaultValues.severity: expected one of critical, warning, info')
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: '{"status":"open"}', valueMapping: null }).error).toBe('defaultValues.status: expected one of firing, resolved')
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: null, valueMapping: '{"severity":{"x":"fatal"}}' }).error).toBe('valueMapping.severity.x: expected one of critical, warning, info')
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: null, valueMapping: '{"status":{"x":"open"}}' }).error).toBe('valueMapping.status.x: expected one of firing, resolved')
    expect(parseSourceConfig({ fieldMapping: '{}', defaultValues: null, valueMapping: '{"severity":[]}' }).error).toBe('valueMapping.severity: expected a JSON object')
  })

  it('D·1.2: default_values.severity/status vengono riletti; ogni chiave sconosciuta di field_mapping, default_values e value_mapping è in dropped con il prefisso', () => {
    const r = parseSourceConfig({
      fieldMapping: '{"title":"t","labels":"tags","startsAt":"ts","resourceKind":"kind"}',
      defaultValues: '{"resourceKind":"ip","severity":"warning","status":"resolved","title":"fallback","description":"x"}',
      valueMapping: '{"severity":{"major":"critical"},"foo":{"a":"b"}}',
    })
    expect(r.error).toBeNull()
    expect(r.dropped).toEqual(['fieldMapping.labels', 'fieldMapping.startsAt', 'fieldMapping.resourceKind', 'defaultValues.title', 'defaultValues.description', 'valueMapping.foo'])
    expect(r.mapping).toEqual({
      ...EMPTY_MAPPING,
      fields: { ...EMPTY_MAPPING.fields, title: 't' },
      resourceKind: 'ip', defaultSeverity: 'warning', defaultStatus: 'resolved',
      severityValues: { major: 'critical' }, statusValues: {},
    })
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

  it('readablePath: "campo (in contenitore)" per chi non è tecnico (D·2.2)', () => {
    expect(readablePath('alert.level', 'in')).toBe('level (in alert)')
    expect(readablePath('alerts.0.labels.severity', 'in')).toBe('severity (in alerts.0.labels)')
    expect(readablePath('id', 'in')).toBe('id')
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
