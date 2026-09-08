import { describe, it, expect } from 'vitest'
import {
  ConnectorError, connectorError, errorNamed, errorStatus, guardScan, paginate,
  probeConnection, requireConfigString, requireCreds, resourceTypeSet, resourceTypesField,
  tagsToRecord, withConnectorErrors,
} from '../connectors/base.js'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('connectorError / withConnectorErrors / guardScan', () => {
  it('enriches the message with connector and operation and keeps the cause', async () => {
    const cause = new Error('boom')
    await expect(withConnectorErrors('aws', 'EC2 scan (region eu-west-1)', async () => { throw cause }))
      .rejects.toMatchObject({
        name:      'ConnectorError',
        message:   '[aws] EC2 scan (region eu-west-1) failed: boom',
        cause,
        connector: 'aws',
        operation: 'EC2 scan (region eu-west-1)',
      })
  })

  it('returns the value when fn succeeds', async () => {
    await expect(withConnectorErrors('aws', 'op', async () => 42)).resolves.toBe(42)
  })

  it('does not double-wrap an inner ConnectorError', () => {
    const inner = new ConnectorError('aws', 'inner op', new Error('x'))
    expect(connectorError('aws', 'outer op', inner)).toBe(inner)
  })

  it('stringifies non-Error causes', () => {
    expect(connectorError('gcp', 'op', 'plain string').message).toBe('[gcp] op failed: plain string')
  })

  it('guardScan re-yields items and wraps producer errors', async () => {
    const ok = guardScan('csv', 'parse', async function* () { yield 1; yield 2 })
    await expect(collect(ok)).resolves.toEqual([1, 2])

    const bad = guardScan('csv', 'parse', async function* () { yield 1; throw new Error('mid-stream') })
    await expect(collect(bad)).rejects.toThrow('[csv] parse failed: mid-stream')
  })
})

describe('errorNamed / errorStatus', () => {
  it('matches by Error.name', () => {
    const e = new Error('nf'); e.name = 'ResourceNotFoundException'
    expect(errorNamed(e, 'ResourceNotFoundException')).toBe(true)
    expect(errorNamed(e, 'Other')).toBe(false)
    expect(errorNamed('str', 'ResourceNotFoundException')).toBe(false)
  })
  it('reads statusCode or status', () => {
    expect(errorStatus({ statusCode: 404 })).toBe(404)
    expect(errorStatus({ status: 403 })).toBe(403)
    expect(errorStatus({ statusCode: '404' })).toBeUndefined()
    expect(errorStatus(null)).toBeUndefined()
  })
})

describe('resourceTypeSet', () => {
  const ALL = ['ec2', 'rds'] as const
  it('defaults to all when empty', () => {
    expect([...resourceTypeSet('aws', undefined, ALL)]).toEqual(['ec2', 'rds'])
    expect([...resourceTypeSet('aws', ' ', ALL)]).toEqual(['ec2', 'rds'])
  })
  it('parses a comma list', () => {
    expect([...resourceTypeSet('aws', 'rds, ec2', ALL)]).toEqual(['rds', 'ec2'])
  })
  it('fails loudly on unknown types (no silent empty scan)', () => {
    expect(() => resourceTypeSet('aws', 'ec3', ALL)).toThrow(/\[aws\] config failed: resource_types sconosciuti: ec3 \(ammessi: ec2, rds\)/)
  })
  it('resourceTypesField documents the allowed values', () => {
    expect(resourceTypesField(ALL)).toMatchObject({ name: 'resource_types', default_value: 'ec2, rds', required: false })
  })
})

describe('requireCreds / requireConfigString', () => {
  it('returns creds when all present', () => {
    const c = { a: 'x', b: 'y' }
    expect(requireCreds('aws', c, ['a', 'b'])).toBe(c)
  })
  it('lists every missing credential', () => {
    expect(() => requireCreds('aws', { a: 'x', b: ' ' }, ['a', 'b', 'c']))
      .toThrow('[aws] credentials failed: credenziali mancanti: b, c')
  })
  it('requires a non-empty config string', () => {
    expect(requireConfigString('azure', { subscription_id: ' sub ' }, 'subscription_id')).toBe('sub')
    expect(() => requireConfigString('azure', {}, 'subscription_id')).toThrow(/obbligatorio mancante: subscription_id/)
    expect(() => requireConfigString('azure', { subscription_id: 3 }, 'subscription_id')).toThrow(ConnectorError)
  })
})

describe('tagsToRecord', () => {
  it('handles the AWS [{Key,Value}] shape and drops incomplete pairs', () => {
    expect(tagsToRecord([{ Key: 'Name', Value: 'web' }, { Key: 'Empty' }, { Value: 'orphan' }, { Key: 'N', Value: null }]))
      .toEqual({ Name: 'web' })
  })
  it('handles the map shape and keeps raw keys', () => {
    expect(tagsToRecord({ 'app.kubernetes.io/name': 'api', bad: null, other: undefined }))
      .toEqual({ 'app.kubernetes.io/name': 'api' })
  })
  it('returns {} for nullish input', () => {
    expect(tagsToRecord(undefined)).toEqual({})
    expect(tagsToRecord(null)).toEqual({})
  })
})

describe('paginate', () => {
  it('follows tokens until exhausted', async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      first: { items: [1], next: 't2' },
      t2:    { items: [2], next: 't3' },
      t3:    { items: [3] },
    }
    const calls: (string | undefined)[] = []
    const out = await collect(paginate(
      async token => { calls.push(token); return pages[token ?? 'first']! },
      p => p.next,
    ))
    expect(out.map(p => p.items[0])).toEqual([1, 2, 3])
    expect(calls).toEqual([undefined, 't2', 't3'])
  })

  it('treats an empty token as the end', async () => {
    const out = await collect(paginate(async () => ({ next: '' }), p => p.next))
    expect(out).toHaveLength(1)
  })

  it('detects a repeated token instead of looping forever', async () => {
    await expect(collect(paginate(async () => ({ next: 'same' }), p => p.next)))
      .rejects.toThrow(/loop di paginazione/)
  })
})

describe('probeConnection', () => {
  it('wraps success', async () => {
    await expect(probeConnection('AWS', async () => 'Connected')).resolves.toEqual({ ok: true, message: 'Connected' })
  })
  it('converts errors to ok:false with a uniform prefix', async () => {
    await expect(probeConnection('AWS', async () => { throw new Error('denied') }))
      .resolves.toEqual({ ok: false, message: 'AWS connection failed: denied' })
  })
})
