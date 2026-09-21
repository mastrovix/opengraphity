/**
 * Migrazione 20261005_1130: l'etichetta italiana dei tre tipi di change torna
 * al tecnico inglese (decisione del proprietario, 20 set 2026: «usa l'inglese
 * per i vocaboli tecnici»).
 *
 * Quello che questi test tengono fermo è il confine: **si tocca solo ciò che
 * il prodotto aveva seminato**. Una rinomina del cliente è sua e resta — è la
 * stessa regola che vale per le etichette spedite (F-22), e sbagliarla qui
 * vorrebbe dire cancellare il lavoro di un admin durante un aggiornamento,
 * senza che nessuno se ne accorga.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { changeTypeLabelsTechnical } from '../20261005_1130_change_type_labels_technical.js'
import { MIGRATIONS } from '../index.js'

type Scritte = Array<{ cypher: string; params: Record<string, unknown> | undefined }>

function sessioneCon(vocabolari: Array<{ tenantId: string; etichette: string }>) {
  const scritte: Scritte = []
  return {
    scritte,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('RETURN e.tenant_id AS tenantId')) {
        return {
          records: vocabolari.map((v) => ({
            get: (k: string) => (k === 'tenantId' ? v.tenantId : v.etichette),
          })),
        }
      }
      scritte.push({ cypher, params })
      return { records: [] }
    }),
  }
}

const seminate = JSON.stringify({
  standard:  { it: 'Standard',  en: 'Standard' },
  normal:    { it: 'Normale',   en: 'Normal' },
  emergency: { it: 'Emergenza', en: 'Emergency' },
})

const scritto = (s: ReturnType<typeof sessioneCon>): Record<string, { it?: string; en?: string }> =>
  JSON.parse(String(s.scritte[0]!.params!['etichette'])) as Record<string, { it?: string; en?: string }>

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20261005_1130_change_type_labels_technical', () => {
  it('è registrata, con id nel formato e senza autocommit (non tocca lo schema)', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('20261005_1130_change_type_labels_technical')
    expect(changeTypeLabelsTechnical.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(changeTypeLabelsTechnical.autocommit).toBeUndefined()
  })

  it('l\'italiano seminato diventa il tecnico inglese', async () => {
    const s = sessioneCon([{ tenantId: 'system', etichette: seminate }])
    await changeTypeLabelsTechnical.up(s as never)

    const m = scritto(s)
    expect(m['normal']!.it).toBe('Normal')
    expect(m['emergency']!.it).toBe('Emergency')
    expect(m['standard']!.it).toBe('Standard')
  })

  it('L\'INGLESE NON SI TOCCA: cambia solo la colonna italiana', async () => {
    const s = sessioneCon([{ tenantId: 'system', etichette: seminate }])
    await changeTypeLabelsTechnical.up(s as never)

    const m = scritto(s)
    expect(m['normal']!.en).toBe('Normal')
    expect(m['emergency']!.en).toBe('Emergency')
  })

  it('UNA RINOMINA DEL CLIENTE RESTA: l\'etichetta è sua', async () => {
    const rinominato = JSON.stringify({
      standard:  { it: 'Standard',            en: 'Standard' },
      normal:    { it: 'Change ordinaria',    en: 'Normal' },
      emergency: { it: 'Emergenza',           en: 'Emergency' },
    })
    const s = sessioneCon([{ tenantId: 'c-uno', etichette: rinominato }])
    await changeTypeLabelsTechnical.up(s as never)

    const m = scritto(s)
    expect(m['normal']!.it, 'la rinomina del cliente non si butta').toBe('Change ordinaria')
    expect(m['emergency']!.it, 'quella ancora seminata invece si allinea').toBe('Emergency')
  })

  it('niente da fare → nessuna scrittura (idempotente alla seconda esecuzione)', async () => {
    const gia = JSON.stringify({
      standard:  { it: 'Standard',  en: 'Standard' },
      normal:    { it: 'Normal',    en: 'Normal' },
      emergency: { it: 'Emergency', en: 'Emergency' },
    })
    const s = sessioneCon([{ tenantId: 'system', etichette: gia }])
    await changeTypeLabelsTechnical.up(s as never)
    expect(s.scritte).toHaveLength(0)
  })

  it('un value_labels illeggibile NON si riscrive a indovinare', async () => {
    const s = sessioneCon([{ tenantId: 'c-rotto', etichette: '{questo non e json' }])
    await changeTypeLabelsTechnical.up(s as never)
    expect(s.scritte).toHaveLength(0)
  })

  it('ogni vocabolario si riscrive DENTRO il suo cliente', async () => {
    const s = sessioneCon([
      { tenantId: 'system', etichette: seminate },
      { tenantId: 'c-due',  etichette: seminate },
    ])
    await changeTypeLabelsTechnical.up(s as never)

    expect(s.scritte).toHaveLength(2)
    expect(s.scritte.map((w) => w.params!['tenantId'])).toEqual(['system', 'c-due'])
    for (const w of s.scritte) expect(w.cypher).toContain('tenant_id: $tenantId')
  })
})
