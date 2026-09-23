/**
 * lib/workerLiveness.ts — the verdict of the worker containers' probe
 * (23 Sep 2026: every tenant has its own queues, `<base>@<tenant>`).
 *
 * Why these behaviours matter:
 *  - a container whose process died or hangs must turn unhealthy: its
 *    heartbeat is gone;
 *  - with tenants, a worker of the probed queue must be connected for one of
 *    them — the check the probe always made, now across the tenants;
 *  - a fresh install with no tenant yet is healthy: there is no work to take,
 *    and an unhealthy container there would send the operator looking for a
 *    fault that does not exist;
 *  - a client that is not a worker of that base (another queue, the queue
 *    events of the same queue, a tenant whose name only starts the same) is
 *    not counted.
 */
import { describe, it, expect } from 'vitest'
import { workersOfBase, livenessVerdict, ALIVE_KEY_PREFIX, ALIVE_TTL_SECONDS } from '../workerLiveness.js'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const client = (name: string) => `id=7 addr=10.0.0.5:51234 laddr=10.0.0.3:6379 fd=9 name=${name} age=12 idle=0 flags=N db=0 cmd=bzpopmin`
const LIST = [
  client(`bull:${b64('embeddings@acme')}`),
  client(`bull:${b64('embeddings@globex')}:w:worker-1`),
  client(`bull:${b64('embeddings@acme')}:qe`),
  client(`bull:${b64('embeddings-extra@acme')}`),
  client(`bull:${b64('sla-jobs@acme')}`),
  'id=9 addr=10.0.0.5:51300 name= age=1 cmd=client|list',
  client('og:metamodel'),
].join('\n')

describe('workersOfBase', () => {
  it('counts the workers of the base for every tenant, and only those', () => {
    expect(workersOfBase(LIST, 'embeddings')).toBe(2)
    expect(workersOfBase(LIST, 'sla-jobs')).toBe(1)
    expect(workersOfBase(LIST, 'events-ingest')).toBe(0)
  })

  it('a worker of the queue the tenants shared still counts (a process running the code from before)', () => {
    expect(workersOfBase(client(`bull:${b64('embeddings')}`), 'embeddings')).toBe(1)
  })

  it('an empty list has none', () => {
    expect(workersOfBase('', 'embeddings')).toBe(0)
  })
})

describe('livenessVerdict', () => {
  const alive = (tenants: number) => JSON.stringify({ tenants, at: '2026-09-23T18:00:00.000Z' })

  it('no heartbeat: unhealthy, whatever the workers', () => {
    expect(livenessVerdict(null, LIST, 'embeddings')).toMatchObject({ ok: false, reason: expect.stringContaining('no heartbeat') })
  })

  it('alive with tenants and a worker connected: healthy', () => {
    expect(livenessVerdict(alive(2), LIST, 'embeddings')).toEqual({ ok: true, reason: 'alive, 2 embeddings worker(s) for 2 tenant(s)' })
  })

  it('alive with tenants but no worker of the base: unhealthy, saying which', () => {
    expect(livenessVerdict(alive(2), LIST, 'events-ingest')).toEqual({ ok: false, reason: 'alive, but no events-ingest worker connected for its 2 tenant(s)' })
  })

  it('alive with no tenant yet: healthy', () => {
    expect(livenessVerdict(alive(0), '', 'embeddings')).toEqual({ ok: true, reason: 'alive, no tenant yet' })
  })

  it('a heartbeat that is not ours to read is not trusted', () => {
    expect(livenessVerdict('{not json', LIST, 'embeddings').ok).toBe(false)
    expect(livenessVerdict('{"at":"x"}', LIST, 'embeddings').ok).toBe(false)
  })

  it('the heartbeat lives three minutes under a per-host key', () => {
    expect(ALIVE_KEY_PREFIX).toBe('og:tenant-queues:alive:')
    expect(ALIVE_TTL_SECONDS).toBe(180)
  })
})
