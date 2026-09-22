/**
 * The per-request Audit Log counter (auditScope.ts).
 *
 * The mutation audit plugin reads this counter to decide whether a mutation
 * already wrote its own tailored entry. If the counter leaks between requests
 * a mutation loses its generic entry; if a FAILED write still counts, the
 * mutation ends with no trace at all. Both are silent gaps in the Audit Log.
 */
import { describe, it, expect } from 'vitest'
import {
  runInAuditScope, noteAuditWritten, noteAuditFailed, auditsWrittenInScope, auditsFailedInScope,
} from '../auditScope.js'

describe('auditScope', () => {
  it('outside a request nothing is counted and the readers say null (not zero)', () => {
    noteAuditWritten()
    noteAuditFailed()
    // null = "no GraphQL request here", which callers must not confuse with "0 written".
    expect(auditsWrittenInScope()).toBeNull()
    expect(auditsFailedInScope()).toBeNull()
  })

  it('counts writes inside a request, across awaits, and returns the function result', async () => {
    const out = await runInAuditScope(async () => {
      expect(auditsWrittenInScope()).toBe(0)
      noteAuditWritten()
      await Promise.resolve()
      noteAuditWritten()
      return { written: auditsWrittenInScope(), failed: auditsFailedInScope() }
    })
    expect(out).toEqual({ written: 2, failed: 0 })
  })

  it('a failed write takes back its "written" mark, so the generic entry is still produced', () => {
    const out = runInAuditScope(() => {
      noteAuditWritten()
      noteAuditFailed()
      return [auditsWrittenInScope(), auditsFailedInScope()]
    })
    expect(out).toEqual([0, 1])
  })

  it('a failure with nothing written never drives the counter negative', () => {
    const out = runInAuditScope(() => {
      noteAuditFailed()
      noteAuditFailed()
      return [auditsWrittenInScope(), auditsFailedInScope()]
    })
    expect(out).toEqual([0, 2])
  })

  it('two concurrent requests keep separate counters', async () => {
    const a = runInAuditScope(async () => { noteAuditWritten(); await new Promise((r) => setTimeout(r, 5)); return auditsWrittenInScope() })
    const b = runInAuditScope(async () => { noteAuditWritten(); noteAuditWritten(); noteAuditWritten(); return auditsWrittenInScope() })
    expect(await Promise.all([a, b])).toEqual([1, 3])
  })
})
