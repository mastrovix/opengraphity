/**
 * Event Management — connector payload normalization (services/events/normalize.ts),
 * the edges the service-level event tests do not reach.
 *
 * Every function here decides whether a monitoring alert becomes an Event or
 * an explicit rejection. What breaks if these regress:
 *  - malformed configuration (value_mapping, field_mapping, stored JSON) must
 *    be refused with a message that names the field, not accepted as "empty":
 *    a silently ignored mapping means alerts dropped for weeks;
 *  - a value outside the vocabulary is only accepted when it matches after
 *    trimming/lower-casing, never guessed;
 *  - per-item rejection (A1) must only swallow VALIDATION errors: a real bug
 *    must surface, not be counted as "bad payload";
 *  - Zabbix sends local wall-clock time: around the DST switch the instant
 *    must be the one the OS would pick, not an hour off;
 *  - Datadog dates arrive in seconds or milliseconds; both must be read right.
 */
import { describe, it, expect } from 'vitest'
import { ValidationError } from '../../../lib/errors.js'
import {
  quoteValue, parseLabels, zonedTimeToISO, parseValueMapping, parseFieldMapping, normalizeBatch,
  normalizePayload, parseConfigJSON, sourceConfigOf, normalizeBatchWithConfig, listPayloadKeys, PAYLOAD_MAX_DEPTH,
} from '../normalize.js'

describe('quoteValue', () => {
  it('quotes values JSON cannot serialize with their String() form', () => {
    // JSON.stringify(Symbol) is undefined: the message must still say something.
    expect(quoteValue(Symbol('s'))).toBe('Symbol(s)')
    expect(quoteValue(undefined)).toBe('undefined')
    expect(quoteValue('warn')).toBe('"warn"')
  })
})

describe('parseLabels', () => {
  it('serializes non-string list items and skips blank ones', () => {
    expect(parseLabels(['env:prod', '  ', 42, [1, 2]], 'tags')).toEqual({ 'env': 'prod', '42': 'true', '[1,2]': 'true' })
  })

  it('refuses a shape that is neither object, list nor string', () => {
    expect(() => parseLabels(7, 'tags')).toThrow(/tags must be a list/)
  })
})

describe('zonedTimeToISO around the DST switch', () => {
  it('a wall-clock time that does not exist (spring forward) is projected with the offset after the switch', () => {
    // 29 Mar 2026, Rome: 02:00 → 03:00. 02:30 does not exist; the OS reads it as 03:30 CEST = 01:30Z.
    expect(zonedTimeToISO('2026.03.29 02:30:00', 'Europe/Rome')).toBe('2026-03-29T01:30:00.000Z')
  })

  it('an ordinary summer time is plain CEST', () => {
    expect(zonedTimeToISO('2026-07-01 12:00:00', 'Europe/Rome')).toBe('2026-07-01T10:00:00.000Z')
  })
})

describe('listPayloadKeys depth guard', () => {
  it('refuses a payload nested deeper than the limit with a ValidationError (not a stack overflow)', () => {
    let deep: unknown = 1
    for (let i = 0; i < PAYLOAD_MAX_DEPTH + 2; i++) deep = { k: deep }
    expect(() => listPayloadKeys(deep)).toThrow(ValidationError)
  })
})

describe('parseValueMapping / parseFieldMapping', () => {
  it('null means "no mapping"; a non-object is a broken configuration', () => {
    expect(parseValueMapping(null)).toEqual({})
    expect(() => parseValueMapping(['critical'])).toThrow(/value_mapping must be a JSON object/)
    expect(parseFieldMapping(undefined)).toEqual({})
    expect(() => parseFieldMapping('title')).toThrow(/field_mapping must be a JSON object/)
  })
})

describe('parseConfigJSON', () => {
  it('a stored value that is not a string is refused, not coerced', () => {
    expect(() => parseConfigJSON({ a: 1 }, 'field_mapping')).toThrow('field_mapping must be a JSON string')
  })
  it('corrupt JSON names the field', () => {
    expect(() => parseConfigJSON('{', 'value_mapping')).toThrow(/Corrupt value_mapping JSON/)
  })
})

describe('per-item rejection only swallows validation errors', () => {
  it('a real bug inside one alert propagates instead of becoming a "rejected" entry', () => {
    // A BigInt label cannot be serialized: that is a programming error, not a bad payload.
    const payload = { alerts: [{ status: 'firing', labels: { alertname: 'X', severity: 'critical', instance: 'h1', big: 10n } }] }
    expect(() => normalizeBatch('alertmanager', payload, {}, {})).toThrow(TypeError)
  })

  it('an alert whose labels are not an object is rejected with its index', () => {
    const batch = normalizeBatch('alertmanager', { alerts: [{ status: 'firing', labels: 'x' }] }, {}, {})
    expect(batch.rejected).toEqual([{ index: 0, error: 'alerts[0].labels is missing or not an object' }])
  })
})

describe('value vocabulary matching', () => {
  const alert = (severity: unknown) => ({ alerts: [{ status: 'firing', labels: { alertname: 'CPU', severity, instance: 'web-1' } }] })

  it('accepts a vocabulary value after trimming and lower-casing', () => {
    const [ev] = normalizePayload('alertmanager', alert(' Critical '), {}, {})
    expect(ev!.severity).toBe('critical')
  })

  it('a non-string severity is quoted as text in the rejection', () => {
    expect(() => normalizePayload('alertmanager', alert(5), {}, {})).toThrow(/value "5" is not mapped/)
  })
})

describe('Zabbix / Datadog / Dynatrace required fields', () => {
  it('Zabbix without event_severity (and no default) is rejected naming the expected values', () => {
    expect(() => normalizePayload('zabbix', { event_id: '1', event_name: 'Down', event_value: '1', host_name: 'h' }, {}, {}))
      .toThrow(/event_severity is missing \(Not classified \| Information/)
  })

  it('Datadog without alert_type (and no default) is rejected', () => {
    expect(() => normalizePayload('datadog', { alert_id: '9', title: 'T', alert_transition: 'Triggered', hostname: 'h' }, {}, {}))
      .toThrow('alert_type is missing (error | warning | info | success)')
  })

  it('Datadog dates in seconds and in milliseconds give the same instant; a string date is kept', () => {
    const base = { alert_id: '9', title: 'T', alert_transition: 'Triggered', alert_type: 'error', hostname: 'h' }
    const [s] = normalizePayload('datadog', { ...base, date: 1_790_000_000 }, {}, {})
    const [ms] = normalizePayload('datadog', { ...base, date: 1_790_000_000_000 }, {}, {})
    expect(s!.startsAt).toBe(new Date(1_790_000_000_000).toISOString())
    expect(ms!.startsAt).toBe(s!.startsAt)
    const [str] = normalizePayload('datadog', { ...base, date: '2026-09-20T10:00:00Z' }, {}, {})
    expect(str!.startsAt).toBe('2026-09-20T10:00:00Z')
  })

  it('Dynatrace: ImpactedEntities[0] that is not an object is rejected', () => {
    const p = { PID: '1', ProblemTitle: 'Slow', State: 'OPEN', ProblemSeverity: 'PERFORMANCE', ImpactedEntities: ['web-1'] }
    expect(() => normalizePayload('dynatrace', p, {}, {})).toThrow('ImpactedEntities[0] must be an object { type, name, entity }')
  })

  it('Dynatrace: blank optional fields do not become labels', () => {
    const p = { PID: '1', ProblemTitle: 'Slow', State: 'OPEN', ProblemSeverity: 'PERFORMANCE', ImpactedEntity: 'Host web-1', ProblemURL: '   ', Tags: 'env:prod' }
    const [ev] = normalizePayload('dynatrace', p, {}, {})
    expect(ev!.labels).toEqual({ Tags: 'env:prod' })
  })
})

describe('generic connector', () => {
  it('reads startsAt / endsAt at their mapped paths', () => {
    const payload = { t: 'Disk', sev: 'warning', host: 'db-1', when: { from: '2026-09-20T10:00:00Z', to: '2026-09-20T11:00:00Z' } }
    const mapping = { title: 't', severity: 'sev', resource: 'host', startsAt: 'when.from', endsAt: 'when.to' }
    const [ev] = normalizePayload('generic', payload, mapping, { resourceKind: 'hostname' })
    expect(ev).toMatchObject({ startsAt: '2026-09-20T10:00:00Z', endsAt: '2026-09-20T11:00:00Z', resource: 'db-1' })
  })

  it('a missing field with a configured default is described without the "no default" hint', () => {
    // default_values.title is set but blank: the message must not claim there is no default.
    expect(() => normalizePayload('generic', { severity: 'info', resource: 'x' }, {}, { title: '', resourceKind: 'name' }))
      .toThrow('title (field_mapping.title = "title") is missing or empty')
  })
})

describe('normalizeBatchWithConfig', () => {
  it('normalizes per item with the stored source configuration', () => {
    const config = sourceConfigOf({ connector_kind: 'alertmanager', value_mapping: JSON.stringify({ severity: { page: 'critical' } }) })
    const batch = normalizeBatchWithConfig(config, {
      alerts: [
        { status: 'firing', labels: { alertname: 'A', severity: 'page', instance: 'h1' } },
        { status: 'firing', labels: { alertname: 'B', instance: 'h2' } },
      ],
    })
    expect(batch.total).toBe(2)
    expect(batch.events.map((e) => [e.title, e.severity])).toEqual([['A', 'critical']])
    expect(batch.rejected).toEqual([{ index: 1, error: 'alerts[1].labels.severity is missing (no default_values.severity)' }])
  })
})
