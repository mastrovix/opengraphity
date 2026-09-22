/**
 * The in-process memory cache and its metamodel-derived families.
 *
 * Why these behaviours matter: this cache holds the allowed relation types,
 * the topology and the mapped CIs. A relation type defined a moment ago was
 * refused with "Invalid relation type" for five minutes by every process that
 * had not served the mutation (A-16) — so the metamodel channel must clear
 * these families, per tenant, WITHOUT throwing away other tenants' entries or
 * unrelated keys that happen to live in the same cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  cache, invalidateAllMetamodelDerivedCache, invalidateMetamodelDerivedCache, metamodelCacheKey, METAMODEL_CACHE_PREFIXES,
} from '../cache.js'
import { clearAllMetamodelCaches, clearLocalMetamodelCaches, registeredMetamodelCacheClearers } from '../schemaInvalidator.js'

beforeEach(() => cache.clear())
afterEach(() => vi.useRealTimers())

describe('MemoryCache', () => {
  it('returns a stored value until its TTL expires, then forgets it', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    cache.set('k', { a: 1 }, 10)
    expect(cache.get<{ a: number }>('k')).toEqual({ a: 1 })
    vi.setSystemTime(1_000_000 + 10_000)
    // Exactly at the deadline it is still valid (strictly "after" expires).
    expect(cache.get('k')).toEqual({ a: 1 })
    vi.setSystemTime(1_000_000 + 10_001)
    expect(cache.get('k')).toBeNull()
    // The expired entry is gone even when time goes back (it was deleted, not just hidden).
    vi.setSystemTime(1_000_000)
    expect(cache.get('k')).toBeNull()
  })

  it('a missing key is null', () => {
    expect(cache.get('nope')).toBeNull()
  })

  it('invalidate removes by prefix only; clear removes everything', () => {
    cache.set('a:1', 1, 60)
    cache.set('a:2', 2, 60)
    cache.set('b:1', 3, 60)
    cache.invalidate('a:')
    expect(cache.get('a:1')).toBeNull()
    expect(cache.get('a:2')).toBeNull()
    expect(cache.get('b:1')).toBe(3)
    cache.clear()
    expect(cache.get('b:1')).toBeNull()
  })
})

describe('metamodel-derived families', () => {
  it('keys are <prefix>:<tenant>', () => {
    expect(metamodelCacheKey('topology', 't1')).toBe('topology:t1')
    expect(METAMODEL_CACHE_PREFIXES).toEqual(['allowed_rel_types', 'topology', 'ci'])
  })

  it('per-tenant invalidation spares other tenants and unrelated keys', () => {
    for (const p of METAMODEL_CACHE_PREFIXES) {
      cache.set(metamodelCacheKey(p, 't1'), 'x', 60)
      cache.set(metamodelCacheKey(p, 't2'), 'y', 60)
    }
    cache.set('ci:t1:detail:42', 'deep', 60)
    cache.set('dashboard:t1', 'keep', 60)
    invalidateMetamodelDerivedCache('t1')
    for (const p of METAMODEL_CACHE_PREFIXES) {
      expect(cache.get(metamodelCacheKey(p, 't1'))).toBeNull()
      expect(cache.get(metamodelCacheKey(p, 't2'))).not.toBeNull()
    }
    expect(cache.get('ci:t1:detail:42')).toBeNull()
    expect(cache.get('dashboard:t1')).toBe('keep')
  })

  it('the all-tenants invalidation empties the families but not unrelated keys (no cache.clear())', () => {
    cache.set(metamodelCacheKey('ci', 't1'), 'x', 60)
    cache.set(metamodelCacheKey('allowed_rel_types', 't2'), 'y', 60)
    cache.set('dashboard:t1', 'keep', 60)
    invalidateAllMetamodelDerivedCache()
    expect(cache.get('ci:t1')).toBeNull()
    expect(cache.get('allowed_rel_types:t2')).toBeNull()
    expect(cache.get('dashboard:t1')).toBe('keep')
  })

  it('is registered on the metamodel channel, both per tenant and for all tenants', () => {
    expect(registeredMetamodelCacheClearers()).toContain('memory-cache')
    cache.set('topology:t1', 'x', 60)
    cache.set('topology:t2', 'y', 60)
    clearLocalMetamodelCaches('t1')
    expect(cache.get('topology:t1')).toBeNull()
    expect(cache.get('topology:t2')).toBe('y')
    clearAllMetamodelCaches()
    expect(cache.get('topology:t2')).toBeNull()
  })
})
