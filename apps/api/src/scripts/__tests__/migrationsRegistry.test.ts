import { describe, it, expect } from 'vitest'
import { validateMigrations, migrationChecksum } from '@opengraphity/neo4j'
import { MIGRATIONS } from '../migrations/index.js'

describe('scripts/migrations registry', () => {
  it('every migration has a valid, unique id, a description and an up()', () => {
    const sorted = validateMigrations(MIGRATIONS)
    expect(sorted.length).toBe(MIGRATIONS.length)
    for (const m of sorted) {
      expect(m.description.length).toBeGreaterThan(10)
      expect(migrationChecksum(m)).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('the CALL … IN TRANSACTIONS migration is declared autocommit (it cannot run in an explicit transaction)', () => {
    for (const m of MIGRATIONS) {
      const src = m.up.toString()
      if (/IN TRANSACTIONS/i.test(src)) expect(m.autocommit, `${m.id} must set autocommit: true`).toBe(true)
    }
  })
})
