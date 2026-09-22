/**
 * genericSamplePayload — the test event for a "generic" monitoring source with
 * its OWN field mapping (total review · G-MON-1).
 *
 * The fixed generic sample only has the example paths (`alert.name`…): a source
 * mapping `event.summary` always failed the "send test event" button with
 * "field_mapping.title (event.summary) is missing". The payload is therefore
 * built backwards from the mapping; if it stops matching what the real
 * normalizer reads, the admin's wizard test fails for a correctly configured
 * source. The round-trip through `normalizePayload` is the contract pinned here.
 */
import { describe, it, expect, vi } from 'vitest'

// Pure functions only: the event service module pulls in the driver, which would
// open a connection to a real Neo4j at import time.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), withSession: vi.fn() }))

const { normalizePayload, parseValueMapping } = await import('../../services/eventService.js')
const { genericSamplePayload } = await import('../eventSamples.js')

describe('genericSamplePayload', () => {
  it('writes a demo value at every mapped path, nesting objects as needed', () => {
    const p = genericSamplePayload({
      title: 'event.summary', resource: ' host . name ', severity: 'level', externalId: 'meta.ids.primary',
    })
    expect(p).toEqual({
      event: { summary: 'Sample alarm from OpenGrafo' },
      // Path segments are trimmed, as the normalizer trims the mapping.
      host: { name: 'sample-host.example.local' },
      level: 'critical',
      meta: { ids: { primary: 'SAMPLE-1' } },
    })
  })

  it('round-trips through the real normalizer into a valid event', () => {
    const fieldMapping = { title: 'event.summary', resource: 'host.name', severity: 'lvl', status: 'st', description: 'event.text', labels: 'tags' }
    const valueMapping = { severity: { P1: 'critical', P3: 'warning' }, status: { OPEN: 'firing', CLOSED: 'resolved' } }
    const payload = genericSamplePayload(fieldMapping, valueMapping, { resourceKind: 'hostname' })
    // The value sent is the source's own key that translates to the demo value.
    expect(payload['lvl']).toBe('P1')
    expect(payload['st']).toBe('OPEN')
    const out = normalizePayload('generic', payload, fieldMapping, { resourceKind: 'hostname' }, parseValueMapping(valueMapping))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      title: 'Sample alarm from OpenGrafo', severity: 'critical', status: 'firing',
      resource: 'sample-host.example.local', resourceKind: 'hostname', description: 'Test event sent from the monitoring source wizard',
    })
  })

  it('with no key translating to the demo value it sends the first key, so translation never rejects it', () => {
    const p = genericSamplePayload({ severity: 'sev' }, { severity: { HIGH: 'warning', LOW: 'info' } })
    expect(p['sev']).toBe('HIGH')
  })

  it('an empty translation table is ignored and the demo value is sent as is', () => {
    expect(genericSamplePayload({ severity: 'sev' }, { severity: {} })['sev']).toBe('critical')
  })

  it('skips unknown fields, blank paths, dot-only paths and fields whose demo is empty (endsAt)', () => {
    const p = genericSamplePayload(
      { title: 't', resource: 'r', severity: 's', foo: 'x.y', description: '   ', endsAt: 'end', externalId: '.' },
    )
    expect(p).toEqual({ t: 'Sample alarm from OpenGrafo', r: 'sample-host.example.local', s: 'critical' })
  })

  it('a later path through an existing scalar or array replaces it with an object', () => {
    const p = genericSamplePayload({ title: 'a', description: 'a.b', resource: 'arr', externalId: 'arr.id', severity: 's' })
    // `a` was a string, `arr` a string too: both become objects holding the deeper value.
    expect(p['a']).toEqual({ b: 'Test event sent from the monitoring source wizard' })
    expect(p['arr']).toEqual({ id: 'SAMPLE-1' })
  })

  it('a required field left unmapped goes at the root key, unless a default covers it', () => {
    const p = genericSamplePayload(
      {},
      { severity: { sev1: 'critical', sev2: 'warning' } },
      { resource: 'fixed-host', title: '' },
    )
    // title: default is empty → still needed at the root; resource: default covers it;
    // severity: unmapped → root key, translated through the table.
    expect(p).toEqual({ title: 'Sample alarm from OpenGrafo', severity: 'sev1' })
  })

  it('an unmapped severity with a table lacking the demo value sends the first key', () => {
    const p = genericSamplePayload({ title: 't', resource: 'r' }, { severity: { a: 'info' } })
    expect(p['severity']).toBe('a')
  })

  it('defaults to empty value mapping and defaults', () => {
    expect(genericSamplePayload({ title: 't' })).toEqual({
      t: 'Sample alarm from OpenGrafo', resource: 'sample-host.example.local', severity: 'critical',
    })
  })
})
