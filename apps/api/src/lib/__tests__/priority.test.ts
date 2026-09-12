/**
 * Priorità = Impatto × Urgenza, dalla MATRICE DEL CLIENTE (ondata 7 · B-14 /
 * C-8).
 *
 * ## Contratto rinegoziato, e perché
 * Questo file pinnava tre cose che l'ondata 7 chiude:
 *
 *  1. `derivePriority('high','high') === 'critical'` come funzione **pura**.
 *     Adesso la matrice è dato del cliente, quindi la funzione è asincrona e
 *     legge. I casi restano gli stessi — con la matrice di fabbrica il
 *     risultato è identico — ma passano dal dato.
 *  2. `impactUrgencyFromPriority` come **tabella parallela** alla matrice, con
 *     un `default → medium` che nascondeva una priorità sconosciuta. Adesso
 *     l'inverso si calcola DALLA matrice (`invertPriority`), quindi non può
 *     divergere, e una priorità che nessuna cella produce è un errore.
 *  3. `priorityCode` («P1»…«P4»): non ha più chiamanti nell'API — l'unico
 *     `priorityCode` in uso è quello del web (`apps/web/src/lib/priority.ts`,
 *     che ha il suo test) — e la sua tabella `critical → P1` era un'altra
 *     lista di valori di dominio scritta nel codice. Rimossa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeRead = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const loadTenantEnumOverrides = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ executeRead, close }) }))
vi.mock('../enumScope.js', () => ({ loadTenantEnumOverrides }))

const { derivePriority, invertPriority, resolveNewTicketPriority, resolvePriorityPatch } = await import('../priority.js')
const { DOMAIN_MATRIX_SEEDS, clearDomainCaches } = await import('../domainMatrix.js')

const rec = (m: Record<string, unknown>) => ({ get: (k: string) => (k in m ? m[k] : null) })

/** I vocabolari del cliente (quelli di fabbrica, salvo diverso). */
function vocab(over: Record<string, string[]> = {}) {
  const base: Record<string, string[]> = {
    impact:   ['low', 'medium', 'high'],
    urgency:  ['low', 'medium', 'high'],
    priority: ['low', 'medium', 'high', 'critical'],
    ...over,
  }
  return new Map(Object.entries(base).map(([name, values]) => [name, { id: `e-${name}`, name, values }]))
}

/** La matrice salvata sul grafo; `null` = nessun nodo, quindi il seme. */
function matrix(entries: Record<string, string> | null) {
  executeRead.mockReset()
  executeRead.mockResolvedValue({
    records: entries === null ? [] : [rec({ entries: JSON.stringify(entries), updatedAt: '2026-09-17T10:00:00Z' })],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearDomainCaches()
  loadTenantEnumOverrides.mockResolvedValue(vocab())
  matrix(null)
})

describe('derivePriority — la matrice ITIL, ma come dato', () => {
  it('con la matrice di fabbrica i nove casi sono quelli di sempre', async () => {
    for (const [key, expected] of Object.entries(DOMAIN_MATRIX_SEEDS.priority)) {
      const [impact, urgency] = key.split('|') as [string, string]
      clearDomainCaches(); matrix(null)
      expect(await derivePriority('c-one', impact, urgency), key).toBe(expected)
    }
  })

  it('la matrice del cliente vince: rinominati i valori, la priorità segue', async () => {
    loadTenantEnumOverrides.mockResolvedValue(vocab({
      impact: ['basso', 'alto'], urgency: ['calmo', 'urgente'], priority: ['p1', 'p3'],
    }))
    matrix({ 'alto|urgente': 'p1', 'alto|calmo': 'p3', 'basso|urgente': 'p3', 'basso|calmo': 'p3' })
    expect(await derivePriority('c-one', 'alto', 'urgente')).toBe('p1')
  })

  it('un impatto fuori vocabolario è un rifiuto che elenca gli ammessi, non un «medium»', async () => {
    await expect(derivePriority('c-one', 'altissimo', 'high'))
      .rejects.toThrow(/impact: "altissimo" non è nel vocabolario di questo cliente. Ammessi: low, medium, high/)
  })

  it('una combinazione che la matrice non copre nomina matrice e combinazione', async () => {
    loadTenantEnumOverrides.mockResolvedValue(vocab({ impact: ['low', 'medium', 'high', 'tier0'] }))
    await expect(derivePriority('c-one', 'tier0', 'high'))
      .rejects.toThrow(/Matrice "priority".*impact="tier0", urgency="high"/s)
  })
})

describe('invertPriority — l\'inverso si calcola DALLA matrice', () => {
  it('riproduce esattamente le coppie che la vecchia tabella dava', async () => {
    const expected = {
      critical: { impact: 'high',   urgency: 'high' },
      high:     { impact: 'high',   urgency: 'medium' },
      medium:   { impact: 'medium', urgency: 'medium' },
      low:      { impact: 'low',    urgency: 'low' },
    }
    for (const [priority, pair] of Object.entries(expected)) {
      clearDomainCaches(); matrix(null)
      expect(await invertPriority('c-one', priority), priority).toEqual(pair)
    }
  })

  it('l\'inverso è senza perdita: reinserito nella matrice torna la stessa priorità', async () => {
    for (const p of ['critical', 'high', 'medium', 'low']) {
      clearDomainCaches(); matrix(null)
      const { impact, urgency } = await invertPriority('c-one', p)
      clearDomainCaches(); matrix(null)
      expect(await derivePriority('c-one', impact, urgency), p).toBe(p)
    }
  })

  it('una priorità che nessuna cella produce è un errore, non `medium|medium`', async () => {
    loadTenantEnumOverrides.mockResolvedValue(vocab({ priority: ['low', 'medium', 'high', 'critical', 'blocker'] }))
    await expect(invertPriority('c-one', 'blocker'))
      .rejects.toThrow(/nessuna combinazione di impatto e urgenza produce "blocker"/)
  })
})

describe('resolveNewTicketPriority — incident e problem nuovi', () => {
  it('impatto + urgenza vincono e la priorità si deriva', async () => {
    expect(await resolveNewTicketPriority('c-one', { impact: 'high', urgency: 'medium' }))
      .toEqual({ severity: 'high', impact: 'high', urgency: 'medium' })
  })

  it('la sola priorità: impatto e urgenza ricostruiti per inversione', async () => {
    expect(await resolveNewTicketPriority('c-one', { severity: 'critical' }))
      .toEqual({ severity: 'critical', impact: 'high', urgency: 'high' })
  })

  it('metà del dato non passa più in silenzio: solo l\'impatto è un rifiuto', async () => {
    // Prima `impact` senza `urgency` cadeva nel ramo della severità e l'impatto
    // dato dall'utente veniva tenuto, l'urgenza inventata dalla severità.
    await expect(resolveNewTicketPriority('c-one', { impact: 'high', severity: 'low' }))
      .rejects.toThrow(/Impatto e urgenza si passano insieme/)
  })

  it('niente di niente: il messaggio dice cosa fornire', async () => {
    await expect(resolveNewTicketPriority('c-one', {})).rejects.toThrow(/Fornire impact\+urgency oppure severity/)
  })

  it('una severità fuori vocabolario è un rifiuto (prima veniva scritta e mappata a medium|medium)', async () => {
    await expect(resolveNewTicketPriority('c-one', { severity: 'urgentissimo' }))
      .rejects.toThrow(/priority: "urgentissimo" non è nel vocabolario di questo cliente/)
  })
})

describe('resolvePriorityPatch — aggiornamento parziale', () => {
  it('impatto nella patch: merge col corrente e priorità ricalcolata', async () => {
    expect(await resolvePriorityPatch('c-one', { impact: 'low', urgency: 'high' }, { impact: 'high' }))
      .toEqual({ severity: 'critical', impact: 'high', urgency: 'high' })
  })

  it('solo la priorità: impatto e urgenza riallineati', async () => {
    expect(await resolvePriorityPatch('c-one', { impact: 'low', urgency: 'low' }, { priority: 'high' }))
      .toEqual({ severity: 'high', impact: 'high', urgency: 'medium' })
  })

  it('patch vuota: niente da toccare', async () => {
    expect(await resolvePriorityPatch('c-one', { impact: 'low', urgency: 'low' }, {}))
      .toEqual({ severity: null, impact: null, urgency: null })
  })

  it('la controparte manca sul dato storico: si salva il valore dato, la priorità resta', async () => {
    expect(await resolvePriorityPatch('c-one', { impact: null, urgency: null }, { impact: 'high' }))
      .toEqual({ severity: null, impact: 'high', urgency: null })
  })

  it('un valore fuori vocabolario è un rifiuto che elenca gli ammessi', async () => {
    await expect(resolvePriorityPatch('c-one', { impact: 'low', urgency: 'low' }, { urgency: 'urgentissima' }))
      .rejects.toThrow(/urgency: "urgentissima" non è nel vocabolario di questo cliente/)
  })
})
