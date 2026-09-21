/**
 * Secondo giro UI del 15 set 2026: il team di un ticket si cambia da un posto
 * solo (lib/ticketTeamHistory.ts), che scrive anche la storia delle
 * assegnazioni su cui si misura un OLA. Prima i posti erano cinque e uno
 * lasciava il ticket con due team.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')
/** Il frammento stesso e il seed demo. Anche i task della change passano dai frammenti: un OLA li misura. */
const ALLOWED = new Set([
  'scripts/seed-demo-incidents.ts',
  'lib/ticketTeamHistory.ts',
])

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') sources(p, out); continue }
    if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('il team di un ticket passa da assignTeamCypher', () => {
  it('nessun CREATE/MERGE di ASSIGNED_TO_TEAM fuori da lib/ticketTeamHistory.ts, task della change compresi', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file)
      if (ALLOWED.has(rel)) continue
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/(CREATE|MERGE)\b.*-\[:?\w*:?ASSIGNED_TO_TEAM\]->/.test(line)) offenders.push(`${rel}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('il frammento sostituisce il team e scrive il tratto', async () => {
    const { assignTeamCypher } = await import('../ticketTeamHistory.js')
    const c = assignTeamCypher('e', 't')
    expect(c).toContain('DELETE __oldTeam')
    expect(c).toContain('CREATE (e)-[:ASSIGNED_TO_TEAM]->(t)')
    expect(c).toContain('SET __openSeg.ended_at = $__teamNow')
    expect(c).toContain('TicketTeamSegment {')
  })

  /*
   * Il difetto del 20 set 2026: `setTicketTeam` leggeva il team di PRIMA (qui
   * dentro viene cancellato, quindi leggerlo dopo è impossibile) e il primo
   * `WITH` del frammento se lo mangiava. La query falliva a tempo di
   * esecuzione — «Variable `previousTeamName` not defined» — e il guardiano
   * delle query non la vede, perché è composta. Questo test guarda OGNI `WITH`
   * del frammento: basta dimenticarsene uno per riaprire il buco.
   */
  it('le variabili dichiarate in `carry` sopravvivono a TUTTI i WITH del frammento', async () => {
    const { assignTeamCypher } = await import('../ticketTeamHistory.js')
    const c = assignTeamCypher('e', 't', { carry: ['previousTeamName', 'qualcosAltro'] })
    const withs = c.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('WITH '))
    expect(withs.length).toBeGreaterThanOrEqual(5)
    for (const w of withs) {
      expect(w, `questo WITH perde il valore letto prima: ${w}`).toContain('previousTeamName')
      expect(w, `questo WITH perde il valore letto prima: ${w}`).toContain('qualcosAltro')
    }
    // Senza `carry` il frammento resta com'era: gli altri cinque chiamanti non cambiano.
    expect(assignTeamCypher('e', 't')).not.toContain(', undefined')
  })

  it('il primo team di un task nuovo: solo se non ne ha già uno, col tratto aperto', async () => {
    const { firstTeamCypher } = await import('../ticketTeamHistory.js')
    const c = firstTeamCypher('dp', 'supportTeam', '$now')
    expect(c).toContain('NOT EXISTS { (dp)-[:ASSIGNED_TO_TEAM]->(:Team) }')
    expect(c).toContain('CREATE (dp)-[:ASSIGNED_TO_TEAM]->(supportTeam)')
    expect(c).toContain('team_id: supportTeam.id, started_at: $now, ended_at: null')
  })
})
