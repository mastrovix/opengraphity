/**
 * I `where` DELLA DIAGNOSI CONTRO LE ROTTE VERE (terza revisione · G3).
 *
 * `configurationIssues` dice all'admin cosa è rotto e **dove si rimedia**, e il
 * banner fa `navigate(issue.where)`. Due dei sei tipi di diagnosi promettevano
 * `/settings/events`, che non esiste: la rotta vera è `settings/event-policy`.
 * In un browser vero il pulsante «Vai a sistemare» portava su «Pagina non
 * trovata» — e la diagnosi colpita era proprio quella viva sul tenant
 * dimostrativo, cioè l'esempio con cui l'ondata 5 si dimostrava funzionante.
 *
 * Nessun test poteva prenderlo: l'API asseriva che `where` fosse *la stringa
 * che l'autore credeva giusta*, e il test del componente cliccava il pulsante
 * dentro un router che accetta qualunque percorso. Niente risolveva quella
 * stringa contro la realtà — la stessa famiglia di `armadi`/`armadios`.
 *
 * Questo test la risolve: legge i `where` di `configurationIssues.ts` e la
 * tabella delle rotte di `apps/web/src/main.tsx`, e pretende che ogni
 * percorso promesso esista davvero. Vive nell'API — dove i `where` sono
 * scritti, e dove il `tsconfig` conosce `node:fs`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// La cwd di vitest qui e `apps/api`.
const REPO    = resolve(process.cwd(), '../..')
const WEB_SRC = join(REPO, 'apps/web/src')

const issuesSrc = readFileSync(join(process.cwd(), 'src/lib/configurationIssues.ts'), 'utf8')
const mainSrc   = readFileSync(join(WEB_SRC, 'main.tsx'), 'utf8')

/** Ogni `where: '...'` dichiarato dalla diagnosi. */
const declared = [...issuesSrc.matchAll(/where:\s*'([^']+)'/g)].map((m) => m[1]!)

/**
 * Le rotte che il router conosce davvero: `path: 'settings/event-policy'` →
 * `/settings/event-policy`. I segmenti con parametro (`workflow/:id`) diventano
 * un prefisso, perché un `where` non può portare un parametro.
 */
const routes = [...mainSrc.matchAll(/path:\s*'([^']*)'/g)]
  .map((m) => m[1]!)
  .filter((p) => p !== '' && p !== '*')
  .map((p) => (p.startsWith('/') ? p : `/${p}`))

function risolve(where: string): boolean {
  if (routes.includes(where)) return true
  // Una rotta con parametro copre i suoi figli: `/workflow` copre `/workflow/:id`.
  return routes.some((r) => r.startsWith(`${where}/:`))
}

describe('ogni «Vai a sistemare» porta su una rotta che esiste', () => {
  it('la diagnosi dichiara dei `where` (se questo cade, la regex non trova più niente)', () => {
    // Senza questo, tutto il resto passerebbe su un elenco vuoto.
    expect(declared.length).toBeGreaterThanOrEqual(5)
    expect(routes.length).toBeGreaterThanOrEqual(20)
  })

  it('le rotte note comprendono quelle che la diagnosi usa', () => {
    expect(routes).toContain('/settings/event-policy')
    expect(routes).toContain('/settings/ci-types')
    expect(routes).toContain('/settings/domain-matrices')
    expect(routes).toContain('/workflow')
  })

  it('nessun `where` punta nel vuoto', () => {
    const rotti = declared.filter((w) => !risolve(w))
    expect(rotti, `Questi percorsi sono promessi da configurationIssues ma il router non li conosce: `
      + `il banner «Vai a sistemare» porterebbe su una pagina vuota. Rotte note: ${routes.join(', ')}`,
    ).toEqual([])
  })

  it('e `/settings/events` non torna: era il difetto', () => {
    expect(declared).not.toContain('/settings/events')
  })

  it('main.tsx non ha una rotta di ripiego, quindi un percorso sbagliato non rende NULLA', () => {
    // Se un giorno si aggiunge un catch-all, questo test va riscritto: il danno
    // di un `where` sbagliato diventerebbe una pagina «non trovata» invece del
    // vuoto, ma resterebbe un vicolo cieco. Il test serve a non dimenticarlo.
    expect(mainSrc).not.toMatch(/path:\s*'\*'/)
  })
})
