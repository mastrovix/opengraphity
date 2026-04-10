/**
 * Seed Change Calendar — 4 changes with scheduled windows for testing.
 * Usage: npx tsx src/scripts/seed-change-calendar.ts --tenant-id c-one
 */
import { getSession } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'

const tenantId = (() => {
  const idx = process.argv.indexOf('--tenant-id')
  if (idx < 0 || !process.argv[idx + 1]) {
    process.stderr.write('Usage: seed-change-calendar.ts --tenant-id <id>\n')
    process.exit(1)
  }
  return process.argv[idx + 1]!
})()

// ── date helpers ────────────────────────────────────────────────────────────

function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

function setTime(base: Date, hours: number, minutes = 0): Date {
  const d = new Date(base)
  d.setHours(hours, minutes, 0, 0)
  return d
}

function nextSaturday(base: Date): Date {
  const d = new Date(base)
  const day = d.getDay()
  const diff = (6 - day + 7) % 7 || 7 // next Saturday
  d.setDate(d.getDate() + diff)
  return d
}

const now = new Date()
const tomorrow = addDays(now, 1)
const in3Days = addDays(now, 3)
const saturday = nextSaturday(now)

interface ChangeSpec {
  title:            string
  type:             string
  priority:         string
  status:           string
  scheduledStart:   string
  scheduledEnd:     string
  requiresDowntime: boolean
  ciName:           string  // CI to link via AFFECTS
}

const CHANGES: ChangeSpec[] = [
  {
    title: 'Network switch firmware upgrade — SRV-001',
    type: 'normal',
    priority: 'medium',
    status: 'approved',
    scheduledStart: setTime(tomorrow, 10, 0).toISOString(),
    scheduledEnd: setTime(tomorrow, 14, 0).toISOString(),
    requiresDowntime: false,
    ciName: 'SRV-001',
  },
  {
    title: 'Database index rebuild — DB-003',
    type: 'standard',
    priority: 'low',
    status: 'approved',
    scheduledStart: setTime(in3Days, 2, 0).toISOString(),
    scheduledEnd: setTime(in3Days, 6, 0).toISOString(),
    requiresDowntime: true,
    ciName: 'DB-003',
  },
  {
    title: 'Emergency security patch — APP-005',
    type: 'emergency',
    priority: 'critical',
    status: 'approved',
    scheduledStart: setTime(saturday, 8, 0).toISOString(),
    scheduledEnd: setTime(saturday, 12, 0).toISOString(),
    requiresDowntime: true,
    ciName: 'APP-005',
  },
  {
    // Same day as #1, overlapping time, same CI => creates conflict
    title: 'SSL certificate rotation — SRV-001',
    type: 'normal',
    priority: 'high',
    status: 'approved',
    scheduledStart: setTime(tomorrow, 12, 0).toISOString(),
    scheduledEnd: setTime(tomorrow, 16, 0).toISOString(),
    requiresDowntime: false,
    ciName: 'SRV-001',
  },
]

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const session = getSession(undefined, 'WRITE')
  try {
    for (const spec of CHANGES) {
      const changeId = uuidv4()
      const nowIso = new Date().toISOString()

      // MERGE on title+tenant to avoid duplicates on re-run
      await session.executeWrite((tx) =>
        tx.run(`
          MERGE (c:Change {title: $title, tenant_id: $tenantId})
          ON CREATE SET
            c.id               = $id,
            c.type             = $type,
            c.priority         = $priority,
            c.status           = $status,
            c.scheduled_start  = $scheduledStart,
            c.scheduled_end    = $scheduledEnd,
            c.requires_downtime = $requiresDowntime,
            c.description      = $title,
            c.created_at       = $now,
            c.updated_at       = $now
          ON MATCH SET
            c.scheduled_start  = $scheduledStart,
            c.scheduled_end    = $scheduledEnd,
            c.requires_downtime = $requiresDowntime,
            c.status           = $status,
            c.updated_at       = $now
        `, {
          id: changeId,
          tenantId,
          title: spec.title,
          type: spec.type,
          priority: spec.priority,
          status: spec.status,
          scheduledStart: spec.scheduledStart,
          scheduledEnd: spec.scheduledEnd,
          requiresDowntime: spec.requiresDowntime,
          now: nowIso,
        }),
      )

      // Link to CI via AFFECTS (find CI by name)
      await session.executeWrite((tx) =>
        tx.run(`
          MATCH (c:Change {title: $title, tenant_id: $tenantId})
          MATCH (ci {name: $ciName, tenant_id: $tenantId})
          MERGE (c)-[:AFFECTS]->(ci)
        `, { title: spec.title, tenantId, ciName: spec.ciName }),
      )

      process.stdout.write(`  [+] ${spec.title} (${spec.scheduledStart} — ${spec.scheduledEnd})\n`)
    }

    process.stdout.write(`\nSeeded ${CHANGES.length} calendar changes for tenant ${tenantId}.\n`)
  } finally {
    await session.close()
  }
  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(`Error: ${String(err)}\n`)
  process.exit(1)
})
