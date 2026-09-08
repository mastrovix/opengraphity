/**
 * Versioned data migrations for Neo4j (Ondata 4, G-17).
 *
 * A migration is `{ id, description, up(session) }` with an id of the form
 * `YYYYMMDD_HHMM_name`. The runner:
 *   - validates the list (id format, no duplicates) and sorts it by id;
 *   - keeps the applied state in `(:Migration {id, applied_at, checksum})`
 *     (UNIQUE constraint on `id`, see init.ts);
 *   - takes a global lock `(:MigrationLock {id: 'global'})` with an expiry, so
 *     two processes (two API replicas booting, an operator + a deploy hook)
 *     never migrate at the same time — the second one FAILS, it does not wait;
 *   - applies the pending migrations in order, each in its own write
 *     transaction together with the `Migration` marker (atomic: a failed
 *     migration leaves no marker), unless the migration declares
 *     `autocommit: true` (needed by `CALL { … } IN TRANSACTIONS`, which Neo4j
 *     refuses inside an explicit transaction): then `up` runs on the session
 *     and the marker is written afterwards — such a migration MUST be
 *     idempotent, because a crash between the two leaves it unmarked;
 *   - is fail-fast: the first failure aborts the run with a MigrationError
 *     carrying the id of the failed migration; the later ones are not touched.
 *
 * Rollback is not modelled: a wrong migration is fixed by a NEW migration.
 * The checksum (sha256 of the normalised source of `up`) is recorded on apply
 * and reported as "drift" by listMigrationStatus when the code of an already
 * applied migration changed; it is a warning, never a reason to re-run.
 *
 * This module never opens a driver by itself (unit-testable with a mock
 * session): the caller passes a WRITE session and closes it.
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import type { Session } from 'neo4j-driver'
import type { Queryable } from './query.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface Migration {
  /** `YYYYMMDD_HHMM_snake_name` — the sort key and the identity of the migration. */
  id: string
  description: string
  /**
   * Run `up` on the auto-commit session instead of inside a managed write
   * transaction. Required for `CALL { … } IN TRANSACTIONS`. The migration
   * must be idempotent (the marker is written in a separate statement).
   */
  autocommit?: boolean
  up(session: Queryable): Promise<void>
}

export interface RunMigrationsOptions {
  /** WRITE session; the caller closes it. */
  session: Session
  /** List what would run, execute nothing (no lock, no markers). */
  dryRun?: boolean
  /** Apply only migrations with id <= `to` (inclusive). Must be a known id. */
  to?: string
  /** Re-apply the selected migrations even when already applied (they must be idempotent). */
  force?: boolean
  /** Lock expiry: a lock older than this is considered abandoned (default 10 min). */
  lockTtlMs?: number
  /** Lock owner tag (default `<hostname>:<pid>`). */
  owner?: string
  log?: (message: string) => void
  now?: () => Date
}

export interface RunMigrationsResult {
  applied: string[]
  skipped: string[]
  /** Known migrations left unapplied (only with `to` / dry-run). */
  pending: string[]
}

export interface MigrationStatus {
  id: string
  description: string | null
  appliedAt: string | null
  /** True when the migration is in the DB but not in the code list (removed/renamed migration). */
  unknown: boolean
  /** True when applied and the code of `up` changed since (informational). */
  checksumDrift: boolean
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError'
  readonly migrationId: string
  override readonly cause: unknown
  constructor(migrationId: string, cause: unknown) {
    super(`Migration ${migrationId} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.migrationId = migrationId
    this.cause = cause
  }
}

export class MigrationLockError extends Error {
  override readonly name = 'MigrationLockError'
  constructor(readonly owner: string | null, readonly lockedAt: string | null) {
    super(`Migrations are locked by "${owner ?? '?'}" since ${lockedAt ?? '?'} — another process is migrating (or died holding the lock: it expires after the TTL)`)
  }
}

// ── Validation / checksum ────────────────────────────────────────────────────

export const MIGRATION_ID_RE = /^\d{8}_\d{4}_[a-z0-9_]+$/

/** Validates ids (format, uniqueness) and returns the list sorted by id. */
export function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const seen = new Set<string>()
  for (const m of migrations) {
    if (!MIGRATION_ID_RE.test(m.id)) {
      throw new Error(`Invalid migration id "${m.id}" (expected YYYYMMDD_HHMM_snake_name)`)
    }
    if (seen.has(m.id)) throw new Error(`Duplicate migration id "${m.id}"`)
    seen.add(m.id)
    if (typeof m.up !== 'function') throw new Error(`Migration ${m.id} has no up()`)
  }
  return [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** sha256 of the whitespace-normalised source of `up` (stable across formatting, not across logic changes). */
export function migrationChecksum(m: Migration): string {
  const src = m.up.toString().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(src).digest('hex')
}

// ── DB state ─────────────────────────────────────────────────────────────────

interface AppliedRow { id: string; applied_at: string | null; checksum: string | null; description: string | null }

async function loadApplied(session: Pick<Session, 'run'>): Promise<Map<string, AppliedRow>> {
  const res = await session.run(
    'MATCH (m:Migration) RETURN m.id AS id, m.applied_at AS applied_at, m.checksum AS checksum, m.description AS description ORDER BY m.id',
  )
  const out = new Map<string, AppliedRow>()
  for (const r of res.records) {
    const id = r.get('id')
    if (typeof id !== 'string') throw new Error(`Migration node with a non-string id: ${JSON.stringify(id)}`)
    out.set(id, {
      id,
      applied_at:  (r.get('applied_at') as string | null) ?? null,
      checksum:    (r.get('checksum') as string | null) ?? null,
      description: (r.get('description') as string | null) ?? null,
    })
  }
  return out
}

/** Applied/pending state of every known migration, plus unknown markers found in the DB. */
export async function listMigrationStatus(
  session: Pick<Session, 'run'>,
  migrations: readonly Migration[],
): Promise<MigrationStatus[]> {
  const sorted  = validateMigrations(migrations)
  const applied = await loadApplied(session)
  const out: MigrationStatus[] = sorted.map((m) => {
    const row = applied.get(m.id)
    return {
      id:            m.id,
      description:   m.description,
      appliedAt:     row?.applied_at ?? null,
      unknown:       false,
      checksumDrift: row?.checksum != null && row.checksum !== migrationChecksum(m),
    }
  })
  const known = new Set(sorted.map((m) => m.id))
  for (const row of applied.values()) {
    if (!known.has(row.id)) {
      out.push({ id: row.id, description: row.description, appliedAt: row.applied_at, unknown: true, checksumDrift: false })
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ── Lock ─────────────────────────────────────────────────────────────────────

const LOCK_ACQUIRE = `
  MERGE (l:MigrationLock {id: 'global'})
  WITH l, (l.locked_at IS NULL OR l.locked_at < $expiresBefore) AS free
  SET l.locked_at = CASE WHEN free THEN $now   ELSE l.locked_at END,
      l.owner     = CASE WHEN free THEN $owner ELSE l.owner     END
  RETURN free AS acquired, l.owner AS owner, l.locked_at AS locked_at`

const LOCK_RELEASE = `
  MATCH (l:MigrationLock {id: 'global'}) WHERE l.owner = $owner
  SET l.locked_at = null, l.owner = null`

async function acquireLock(session: Pick<Session, 'run'>, owner: string, nowIso: string, ttlMs: number): Promise<void> {
  const expiresBefore = new Date(Date.parse(nowIso) - ttlMs).toISOString()
  const res = await session.run(LOCK_ACQUIRE, { now: nowIso, owner, expiresBefore })
  const row = res.records[0]
  if (!row) throw new Error('MigrationLock MERGE returned no row')
  if (row.get('acquired') !== true) {
    throw new MigrationLockError(
      (row.get('owner') as string | null) ?? null,
      (row.get('locked_at') as string | null) ?? null,
    )
  }
}

async function releaseLock(session: Pick<Session, 'run'>, owner: string): Promise<void> {
  await session.run(LOCK_RELEASE, { owner })
}

// ── Runner ───────────────────────────────────────────────────────────────────

const MARK_APPLIED = `
  MERGE (m:Migration {id: $id})
  SET m.applied_at = $now, m.checksum = $checksum, m.description = $description`

export async function runMigrations(
  migrations: readonly Migration[],
  opts: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const {
    session,
    dryRun = false,
    force  = false,
    lockTtlMs = 10 * 60_000,
    owner = `${hostname()}:${process.pid}`,
    log   = (m: string) => console.log(m),
    now   = () => new Date(),
  } = opts

  const sorted = validateMigrations(migrations)
  if (opts.to !== undefined && !sorted.some((m) => m.id === opts.to)) {
    throw new Error(`--to "${opts.to}" is not a known migration id`)
  }

  const applied  = await loadApplied(session)
  const selected = opts.to === undefined ? sorted : sorted.filter((m) => m.id <= opts.to!)
  const outOfRange = opts.to === undefined ? [] : sorted.filter((m) => m.id > opts.to!)

  const result: RunMigrationsResult = { applied: [], skipped: [], pending: [] }
  const toRun: Migration[] = []
  for (const m of selected) {
    if (applied.has(m.id) && !force) result.skipped.push(m.id)
    else toRun.push(m)
  }
  for (const m of outOfRange) if (!applied.has(m.id)) result.pending.push(m.id)

  if (dryRun) {
    for (const m of toRun) log(`[migrate] would apply ${m.id} — ${m.description}${m.autocommit ? ' (autocommit)' : ''}`)
    for (const id of result.skipped) log(`[migrate] already applied ${id}`)
    result.pending.unshift(...toRun.map((m) => m.id))
    return result
  }

  if (toRun.length === 0) {
    log(`[migrate] nothing to apply (${result.skipped.length} already applied)`)
    return result
  }

  await acquireLock(session, owner, now().toISOString(), lockTtlMs)
  try {
    for (const m of toRun) {
      const checksum = migrationChecksum(m)
      const params   = { id: m.id, now: now().toISOString(), checksum, description: m.description }
      log(`[migrate] applying ${m.id} — ${m.description}`)
      try {
        if (m.autocommit) {
          await m.up(session)
          await session.run(MARK_APPLIED, params)
        } else {
          await session.executeWrite(async (tx) => {
            await m.up(tx)
            await tx.run(MARK_APPLIED, params)
          })
        }
      } catch (err) {
        throw new MigrationError(m.id, err)
      }
      result.applied.push(m.id)
      log(`[migrate] applied ${m.id}`)
    }
  } finally {
    await releaseLock(session, owner)
  }
  return result
}
