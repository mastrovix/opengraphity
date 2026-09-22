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
const salta = (r: Record<string, unknown> | null, byPerson = true) => { riga = r; return requestApprovalWouldBeSkipped({} as never, 't1', 'wi-1', 'in_progress', { byPerson }) }

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

  /*
   * 23 Sep 2026: a request waiting IN the approval step could never be
   * approved. The passage being decided is still open, so it did not count,
   * and "Approve" (approval → in progress) was filtered out and refused: the
   * only way out was a rejection.
   */
  it('a person moving the request out of the approval step is the approval decision', async () => {
    const waitingInApproval = { requires: true, approvedPassages: 0, currentPurpose: 'approval', targetPurpose: null, targetTerminal: false }
    await expect(salta(waitingInApproval, true)).resolves.toBe(false)
    expect(cypher).toContain('cur.purpose AS currentPurpose')
  })

  it('a deadline is not a person: the automatic move out of approval is still refused (C-12)', async () => {
    const waitingInApproval = { requires: true, approvedPassages: 0, currentPurpose: 'approval', targetPurpose: null, targetTerminal: false }
    await expect(salta(waitingInApproval, false)).resolves.toBe(true)
  })

  it('from any other step a person still cannot skip the approval', async () => {
    await expect(salta({ requires: true, approvedPassages: 0, currentPurpose: null, targetPurpose: null, targetTerminal: false }, true)).resolves.toBe(true)
  })
})
