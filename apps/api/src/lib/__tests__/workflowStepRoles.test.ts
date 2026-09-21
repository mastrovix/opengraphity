/**
 * I ruoli dei passi che il codice pretende, per tipo di ticket, e la diagnostica
 * che li cerca in ogni workflow del cliente (revisione del 14 set 2026 · F17).
 *
 * Due metà, e servono entrambe:
 *  - il **guardiano**: ogni chiamata nel codice che cerca un passo per categoria
 *    o per scopo, con tipo e ruolo scritti per esteso, deve stare nella tabella
 *    `STEP_ROLES` — obbligatoria se chi la chiama si ferma senza (target*,
 *    require*), almeno facoltativa se ne fa a meno. Aggiungere un uso senza
 *    aggiornare la tabella rompe questo test, quindi la diagnostica non può
 *    restare indietro;
 *  - la **lettura**: per ogni definizione ATTIVA, i ruoli che mancano.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

let rows: Array<{ id: string; name: string; entityType: string; categories: string[]; purposes: string[] }> = []
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(async () => rows) }))

const { STEP_ROLES, workflowsMissingStepRoles } = await import('../workflowStepRoles.js')

const SRC = join(import.meta.dirname, '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
      walk(full, out)
    } else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

const CALL = /\b(targetStepByCategory|targetStepByPurpose|requireStepNamesByPurpose|stepNamesByCategory|stepNamesByPurposeOrdered|getStepNamesByPurpose)\(\s*[^,]+,\s*[^,]+,\s*'([a-z_]+)',\s*\[([^\]]*)\]/g

describe('STEP_ROLES copre ogni uso nel codice', () => {
  const uses: Array<{ file: string; fn: string; entity: string; role: string }> = []
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(CALL)) {
      for (const lit of m[3]!.matchAll(/'([a-z_]+)'/g)) {
        uses.push({ file: relative(SRC, file), fn: m[1]!, entity: m[2]!, role: lit[1]! })
      }
    }
  }

  it('trova gli usi (se diventano pochissimi, il pattern non li vede più)', () => {
    expect(uses.length).toBeGreaterThanOrEqual(15)
  })

  it('ogni uso bloccante è un ruolo OBBLIGATORIO, ogni altro uso è almeno facoltativo', () => {
    const problems: string[] = []
    for (const u of uses) {
      const spec = STEP_ROLES[u.entity as keyof typeof STEP_ROLES]
      const kind = /Category/.test(u.fn) ? 'categories' : 'purposes'
      const blocking = /^(target|require)/.test(u.fn)
      const required = spec?.required[kind].includes(u.role as never) ?? false
      const optional = spec?.optional[kind].includes(u.role as never) ?? false
      if (blocking && !required) problems.push(`${u.file}: ${u.fn} ${u.entity} ${kind} ${u.role} (bloccante, non obbligatorio in STEP_ROLES)`)
      if (!blocking && !required && !optional) problems.push(`${u.file}: ${u.fn} ${u.entity} ${kind} ${u.role} (assente da STEP_ROLES)`)
    }
    expect(problems).toEqual([])
  })

  it('gli usi con costanti (non visti dal pattern) sono dichiarati: la finestra di rilascio', () => {
    expect([...STEP_ROLES.change.required.purposes, ...STEP_ROLES.change.optional.purposes]).toEqual(expect.arrayContaining(['implementation', 'scheduled']))
  })
})

describe('workflowsMissingStepRoles', () => {
  it('per ogni definizione, i ruoli obbligatori e facoltativi che mancano', async () => {
    rows = [
      { id: 'wd-1', name: 'Incident Management', entityType: 'incident', categories: ['active', 'resolved', 'closed', 'escalated'], purposes: [] },
      { id: 'wd-2', name: 'Incident — Rinominato', entityType: 'incident', categories: ['active', 'closed'], purposes: [] },
      { id: 'wd-3', name: 'Change RFC', entityType: 'change', categories: ['active', 'closed'], purposes: ['assessment', 'scheduled', 'approval', 'review'] },
    ]
    const out = await workflowsMissingStepRoles({} as never, 'c-one')
    expect(out).toEqual([
      { workflow: 'Incident — Rinominato', entityType: 'incident', required: { categories: ['resolved', 'escalated'], purposes: [] }, optional: { categories: [], purposes: [] } },
      { workflow: 'Change RFC', entityType: 'change', required: { categories: [], purposes: [] }, optional: { categories: [], purposes: ['implementation'] } },
    ])
  })

  it('i tipi senza requisiti (kb_article) non vengono letti', async () => {
    rows = []
    const { runQuery } = await import('@opengraphity/neo4j')
    await workflowsMissingStepRoles({} as never, 'c-one')
    const params = vi.mocked(runQuery).mock.calls.at(-1)![2] as { tenantId: string; entityTypes: string[] }
    expect(params.tenantId).toBe('c-one')
    expect(params.entityTypes.sort()).toEqual(Object.keys(STEP_ROLES).sort())
  })
})
