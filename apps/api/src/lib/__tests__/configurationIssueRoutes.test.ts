/**
 * I `where` DELLA DIAGNOSI CONTRO LE ROTTE VERE (terza revisione · G3).
 *
 * NOTA: quando ho scritto questo file ho affermato che un percorso inesistente
 * «non rende nulla». Non e vero — c'e `errorElement` sulla rotta di layout, e
 * si vede «Pagina non trovata». Corretto girando nel browser; vedi l'ultimo
 * test.
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
const routes = [...mainSrc.matchAll(/(?:path:\s*|guarded\()'([^']*)'/g)]
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

  it('un percorso sbagliato finisce nel RIPIEGO, che e comunque un vicolo cieco', () => {
    // CORREZIONE di quanto questo test affermava quando l'ho scritto: dicevo
    // che `main.tsx` non ha una rotta di ripiego e che un percorso sbagliato
    // «non rende NULLA». Falso, e l'ho scoperto girando nel browser: il
    // ripiego c'e, ed e `errorElement: <RouteError />` sulla rotta di layout —
    // React Router lo usa anche quando nessuna rotta figlia combacia, non solo
    // sugli errori. Cercare `path: '*'` era guardare la porta sbagliata:
    // l'asserzione passava e il commento diceva una cosa non vera.
    //
    // Il che rende il danno di un `where` sbagliato meno grave di come l'avevo
    // raccontato — «Pagina non trovata» invece di una schermata vuota — ma non
    // meno un vicolo cieco: l'admin non arriva dove si rimedia. Il test che
    // conta resta quello sopra, che risolve ogni `where` contro le rotte vere.
    expect(mainSrc).toMatch(/errorElement/)
  })
})
