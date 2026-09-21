/**
 * Giro del 14 set 2026: una richiesta da catalogo con approvazione offriva
 * anche «Prendi in carico», che la portava in lavorazione senza approvazione.
 */
import { describe, it, expect, vi } from 'vitest'

let riga: Record<string, unknown> | null = null
let cypher = ''
vi.mock('@opengraphity/neo4j', () => ({
  runQueryOne: vi.fn(async (_s: unknown, q: string) => { cypher = q; return riga }),
  toNumber: (v: unknown) => Number(v ?? 0),
}))
const { requestApprovalWouldBeSkipped } = await import('../requestApproval.js')
const salta = (r: Record<string, unknown> | null) => { riga = r; return requestApprovalWouldBeSkipped({} as never, 't1', 'wi-1', 'in_progress') }

describe('requestApprovalWouldBeSkipped', () => {
  it('richiede approvazione, mai approvata, verso un passo di lavorazione → salterebbe', async () => {
    await expect(salta({ requires: true, approvedPassages: 0, targetPurpose: null, targetTerminal: false })).resolves.toBe(true)
  })
  it('verso l\'approvazione o verso una chiusura → no', async () => {
    await expect(salta({ requires: true, approvedPassages: 0, targetPurpose: 'approval', targetTerminal: false })).resolves.toBe(false)
    await expect(salta({ requires: true, approvedPassages: 0, targetPurpose: null, targetTerminal: true })).resolves.toBe(false)
  })
  it('già passata dall\'approvazione, o richiesta senza approvazione → no', async () => {
    await expect(salta({ requires: true, approvedPassages: 1, targetPurpose: null, targetTerminal: false })).resolves.toBe(false)
    await expect(salta({ requires: false, approvedPassages: 0, targetPurpose: null, targetTerminal: false })).resolves.toBe(false)
    await expect(salta(null)).resolves.toBe(false)
  })

  /**
   * Revisione totale · C-12: `approvedPassages` contava TUTTE le esecuzioni
   * del passo di approvazione, compresa quella IN CORSO. Una richiesta ferma
   * in approvazione risultava «già passata», e una scadenza su quel passo la
   * mandava in lavorazione senza che nessuno l'avesse approvata.
   */
  it('conta solo le esecuzioni CONCLUSE del passo di approvazione (C-12)', async () => {
    await salta({ requires: true, approvedPassages: 0, targetPurpose: null, targetTerminal: false })
    expect(cypher).toContain('ex.exited_at IS NOT NULL')
  })
})
